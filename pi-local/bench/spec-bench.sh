#!/usr/bin/env bash
# Measure generation speed with and without speculative decoding.
#
# Speculative decoding runs a small draft model ahead of the big one and pays
# full price only for tokens the big model rejects, so the win depends
# entirely on the acceptance rate. That is a measurement, not a guess.
#
#   bench/spec-bench.sh
#   PI_LLAMA_REPO=... PI_LLAMA_QUANT=... PI_LLAMA_ALIAS=... bench/spec-bench.sh
set -uo pipefail

BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/../bin" && pwd)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="http://127.0.0.1:${PI_LLAMA_PORT:-8080}"
DRAFT_FILE="${PI_LLAMA_DRAFT:-mtp-Qwen3.8-27B-Q4_0}"
REPS="${SPEC_BENCH_REPS:-3}"
MAXTOK="${SPEC_BENCH_MAXTOK:-256}"
ALIAS="${PI_LLAMA_ALIAS:-qwen3.8-27b}"

req="$HERE/.spec-request.json"

# temperature 0 so every run walks the same token path and the comparison is fair
python3 - "$req" "$ALIAS" "$MAXTOK" <<'PY'
import json, sys
path, alias, maxtok = sys.argv[1], sys.argv[2], int(sys.argv[3])
prompt = ("Write a clear, self-contained explanation of how a write-ahead log keeps a "
          "database durable across a crash. Cover the ordering rules and recovery. "
          "Aim for about 250 words.")
json.dump({
    "model": alias,
    "temperature": 0,
    "max_tokens": maxtok,
    "messages": [{"role": "user", "content": prompt}],
    "chat_template_kwargs": {"enable_thinking": False},
}, open(path, "w"))
PY

parse='
import json,sys
try: d=json.load(sys.stdin)
except Exception: print("parse-error 0 0"); raise SystemExit
t = d.get("timings") or {}
print(t.get("predicted_n",0), round(t.get("predicted_per_second",0),2), round(t.get("prompt_per_second",0),2))
'

measure() {
  curl -s "$BASE/v1/chat/completions" -H 'Content-Type: application/json' \
    --data-binary "@$req" | python3 -c "$parse"
}

run_case() {
  label="$1"; shift
  "$BIN/pi-llama-down" >/dev/null 2>&1
  if ! env "$@" "$BIN/pi-llama-up" >/dev/null 2>&1; then
    echo "--- $label: server failed to start"
    return 1
  fi
  measure >/dev/null   # warm the slot; first call pays prefill
  echo "--- $label"
  for i in $(seq 1 "$REPS"); do
    set -- $(measure)
    printf "    run %s: %s tok at %s tok/s (prefill %s tok/s)\n" "$i" "$1" "$2" "$3"
  done
}

run_case "no draft"         PI_LLAMA_DRAFT=
run_case "draft MTP n-max=3" PI_LLAMA_DRAFT="$DRAFT_FILE" PI_LLAMA_DRAFT_MAX=3
run_case "draft MTP n-max=5" PI_LLAMA_DRAFT="$DRAFT_FILE" PI_LLAMA_DRAFT_MAX=5

"$BIN/pi-llama-down" >/dev/null 2>&1
rm -f "$req"
