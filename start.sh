#!/usr/bin/env bash
# Tulen — detection API + worker + web app, in one process group.
#
# Both processes live here rather than in two services because they share one
# SQLite file: the API writes the job, the worker claims it, and WAL only
# arbitrates that between processes on the same filesystem. A platform volume
# attaches to a single service, so "same volume" and "same container" are the
# same requirement.
set -euo pipefail
cd "$(dirname "$0")"

export TULEN_DB="${TULEN_DB:-$HOME/.tulen/tulen.db}"
mkdir -p "$(dirname "$TULEN_DB")"

# The dev box keeps runtime dependencies in .venv. A container installs them
# into the system interpreter and has no venv at all, so the venv is a
# preference here, not a requirement - same reasoning as la_studio's choice of
# interpreter for CountGD.
PY=".venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3 || command -v python)"

# 127.0.0.1 keeps a laptop's dev server off the LAN. A container has to accept
# traffic from outside its own network namespace or the platform's health check
# never reaches it, so a deployment sets HOST=0.0.0.0. $PORT is supplied by the
# platform; 8090 is only the local default.
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8090}"

"$PY" -m service.worker --worker-id w1 &
WORKER=$!
"$PY" -m uvicorn service.api:app --host "$HOST" --port "$PORT" &
API=$!

# Forward the platform's shutdown to both. Without this, SIGTERM stops the
# shell and orphans a worker that is mid-count.
trap 'kill "$WORKER" "$API" 2>/dev/null || true' INT TERM

echo "==> Tulen  http://${HOST}:${PORT}"

# Neither half is useful alone: an API with no worker accepts uploads and queues
# jobs that never run, and a worker with no API has nothing feeding it. In one
# container that has to be one lifetime - otherwise a worker that refused to
# start (missing weights, unwritable volume) leaves a service that answers its
# health check and silently counts nothing, which is exactly the failure the
# startup preflight exists to make loud.
#
# `wait -n` is the clean way to say this and needs bash 4.3; this script also
# runs on macOS, where /bin/bash is still 3.2. Polling costs one syscall pair a
# second.
while kill -0 "$WORKER" 2>/dev/null && kill -0 "$API" 2>/dev/null; do
  sleep 1
done

status=0
if kill -0 "$API" 2>/dev/null; then
  echo "==> worker exited - stopping the API" >&2
  wait "$WORKER" || status=$?
else
  echo "==> API exited - stopping the worker" >&2
  wait "$API" || status=$?
fi

kill "$WORKER" "$API" 2>/dev/null || true
wait 2>/dev/null || true
exit "$status"
