#!/usr/bin/env bash
# Generates the checked-in pack fixtures using native git, so the pack reader
# is exercised against real `git pack-objects` output WITH deltas.
#   ref-delta.pack : git pack-objects (default: REF_DELTA entries)
#   ofs-delta.pack : git pack-objects --delta-base-offset (OFS_DELTA entries)
# Also writes expected-oids.txt and embeds everything as base64 into
# fixtures.generated.ts (workers tests cannot read files at runtime).
# Run once from anywhere: bash generate.sh   (requires git + bun)
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.com
export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.com
export GIT_AUTHOR_DATE='1700000000 +0000' GIT_COMMITTER_DATE='1700000000 +0000'

git init -q -b main "$tmp/repo"
cd "$tmp/repo"

seq 1 1000 > big.txt
echo hello > a.txt
mkdir -p sub
echo nested > sub/b.txt
git add -A && git commit -qm one

# Small edits to a large file: prime delta candidates.
perl -pi -e 's/^500$/five hundred/' big.txt
echo world >> a.txt
git add -A && git commit -qm two

seq 2 1001 > big2.txt
perl -pi -e 's/^700$/seven hundred/' big.txt
git add -A && git commit -qm three

mkdir "$tmp/out"
refsha=$(git rev-list --objects --all | git pack-objects --window=10 --depth=10 -q "$tmp/out/ref")
ofssha=$(git rev-list --objects --all | git pack-objects --delta-base-offset --window=10 --depth=10 -q "$tmp/out/ofs")
# git writes pack files read-only; clear stale copies before overwriting.
rm -f "$dir/ref-delta.pack" "$dir/ofs-delta.pack"
install -m 644 "$tmp/out/ref-$refsha.pack" "$dir/ref-delta.pack"
install -m 644 "$tmp/out/ofs-$ofssha.pack" "$dir/ofs-delta.pack"
git rev-list --objects --all | awk '{print $1}' | sort -u > "$dir/expected-oids.txt"

# Sanity: both packs must actually contain deltas (verify-pack chain stats).
# (Capture first: grep -q would SIGPIPE verify-pack under pipefail.)
refstats=$(git verify-pack -v "$tmp/out/ref-$refsha.idx")
ofsstats=$(git verify-pack -v "$tmp/out/ofs-$ofssha.idx")
grep -q 'chain length = 1' <<<"$refstats" || { echo "ERROR: ref pack contains no deltas" >&2; exit 1; }
grep -q 'chain length = 1' <<<"$ofsstats" || { echo "ERROR: ofs pack contains no deltas" >&2; exit 1; }
# Record the blob oid + content of a.txt at HEAD for content assertions.
git rev-parse 'HEAD:a.txt' > "$dir/a-txt-oid.txt"

bun "$dir/embed.ts"
echo "fixtures regenerated in $dir"
