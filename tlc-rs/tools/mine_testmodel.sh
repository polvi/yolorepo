#!/usr/bin/env bash
# Mine safety-only conformance cases from the tlaplus repo's test-model corpus.
#
# Usage: tools/mine_testmodel.sh <tlaplus-repo-root> <out-dir>
#
# Three gates:
#  1. cfg grep: drop SYMMETRY / VIEW / ALIAS / PROPERTY (action-only
#     properties get re-admitted in a later refinement pass).
#  2. tla grep: drop out-of-scope EXTENDS and fairness (WF_/SF_).
#  3. run gate (authoritative, done separately via `tlc-diff sweep <out-dir>`):
#     keep cases the pinned Java TLC finishes with ok/violation/deadlock.
set -euo pipefail

REPO="${1:?tlaplus repo root}"
OUT="${2:?output dir}"
SRC="$REPO/tlatools/org.lamport.tlatools/test-model"

mkdir -p "$OUT"
kept=0 dropped=0

for cfg in $(find "$SRC" -maxdepth 1 -name '*.cfg' | sort); do
  base="${cfg%.cfg}"
  tla="$base.tla"
  [ -f "$tla" ] || { dropped=$((dropped+1)); continue; }

  if grep -qE '^[[:space:]]*(SYMMETRY|VIEW|ALIAS|PROPERT)' "$cfg"; then
    dropped=$((dropped+1)); continue
  fi
  if grep -qE 'WF_|SF_' "$tla"; then
    dropped=$((dropped+1)); continue
  fi
  if grep -qE 'EXTENDS.*(TLCExt|Randomization|IOUtils|Json|RealTime|Reals|TLAPS)' "$tla"; then
    dropped=$((dropped+1)); continue
  fi

  name="$(basename "$base")"
  cp "$tla" "$OUT/$name.tla"
  cp "$cfg" "$OUT/$name.cfg"
  kept=$((kept+1))
done

echo "kept $kept, dropped $dropped (top-level test-model only; multi-module dirs are a later refinement)"
echo "next: TLC_JAR=<pinned jar> cargo run -p tlc-diff -- sweep $OUT"
