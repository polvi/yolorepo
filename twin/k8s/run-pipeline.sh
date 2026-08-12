#!/bin/bash
# Start pipeline.sh detached from any kubectl exec session: hour-long runs
# must not depend on a live apiserver websocket (learned the hard way — the
# stream died mid-match while the pipeline kept running). Output goes to
# /work/job/pipeline.log, the exit code to /work/job/status; the client polls
# both with short-lived execs. Inherits ITERS/MATCHER. Idempotent: attaches
# to (does not restart) an already-running pipeline.
set -euo pipefail

if pgrep -f '/work/scripts/[p]ipeline.sh' >/dev/null; then
  echo 'already-running'
  exit 0
fi

rm -f /work/job/status
nohup bash -c \
  "bash /work/scripts/pipeline.sh > /work/job/pipeline.log 2>&1; echo \$? > /work/job/status" \
  >/dev/null 2>&1 &
echo 'started'
