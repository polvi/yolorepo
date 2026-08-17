#!/usr/bin/env bash
# Install the pi-local inference setup:
#   - symlink pi-llama-{up,down,status} into ~/.local/bin
#   - merge the llama-cpp provider into ~/.pi/agent/models.json
#   - optionally install the launchd agent so the server starts at login
#
#   - optionally make the local model pi's default
#
# Usage: ./install.sh [--launchd] [--default]
set -euo pipefail

want_launchd=0
want_default=0
for arg in "$@"; do
  case "$arg" in
    --launchd) want_launchd=1 ;;
    --default) want_default=1 ;;
    *) echo "usage: install.sh [--launchd] [--default]" >&2; exit 2 ;;
  esac
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
bindir="${PI_LOCAL_BIN:-$HOME/.local/bin}"
pi_dir="$HOME/.pi/agent"

mkdir -p "$bindir" "$pi_dir"

for cmd in pi-llama-up pi-llama-down pi-llama-status; do
  ln -sf "$here/$cmd" "$bindir/$cmd"
  echo "linked $bindir/$cmd"
done

case ":$PATH:" in
  *":$bindir:"*) ;;
  *) echo "note: $bindir is not on PATH, add it to your shell profile" ;;
esac

# Merge rather than overwrite: pi's models.json may already hold other providers.
python3 - "$root/config/models.json" "$pi_dir/models.json" <<'PY'
import json, os, sys

src_path, dst_path = sys.argv[1], sys.argv[2]
with open(src_path) as f:
    src = json.load(f)

dst = {}
if os.path.exists(dst_path) and os.path.getsize(dst_path) > 0:
    try:
        with open(dst_path) as f:
            dst = json.load(f)
    except json.JSONDecodeError:
        backup = dst_path + ".bak"
        os.replace(dst_path, backup)
        print(f"existing models.json was not valid JSON, moved to {backup}")
        dst = {}

providers = dst.setdefault("providers", {})
for name, cfg in src["providers"].items():
    if name in providers:
        print(f"replacing existing provider '{name}'")
    providers[name] = cfg

with open(dst_path, "w") as f:
    json.dump(dst, f, indent=2)
    f.write("\n")
print(f"wrote {dst_path}")
PY

if [ "$want_default" = "1" ]; then
  python3 - "$pi_dir/settings.json" <<'PY'
import json, os, sys

path = sys.argv[1]
settings = {}
if os.path.exists(path) and os.path.getsize(path) > 0:
    try:
        with open(path) as f:
            settings = json.load(f)
    except json.JSONDecodeError:
        backup = path + ".bak"
        os.replace(path, backup)
        print(f"existing settings.json was not valid JSON, moved to {backup}")

settings["defaultProvider"] = "llama-cpp"
settings["defaultModel"] = "qwen3.8-27b"

with open(path, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
print(f"set defaultProvider/defaultModel in {path}")
PY
fi

if [ "$want_launchd" = "1" ]; then
  plist="$HOME/Library/LaunchAgents/io.proc.pi-llama.plist"
  mkdir -p "$(dirname "$plist")"
  sed -e "s|__PI_LLAMA_UP__|$here/pi-llama-up|g" -e "s|__HOME__|$HOME|g" \
    "$root/launchd/io.proc.pi-llama.plist.template" > "$plist"
  launchctl bootout "gui/$(id -u)/io.proc.pi-llama" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "loaded launchd agent io.proc.pi-llama (server starts at login)"
  echo "remove it with: launchctl bootout gui/$(id -u)/io.proc.pi-llama && rm $plist"
fi

echo
echo "done. start the server with:  pi-llama-up"
echo "then:                         pi --provider llama-cpp --model qwen3.8-27b"
