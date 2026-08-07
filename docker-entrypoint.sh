#!/usr/bin/env bash
# Tulen - container entrypoint: N detection workers plus the FastAPI app, supervised.
#
# Railway gives a service one container and attaches a volume to that one
# container. The API and the workers share a single SQLite file over WAL, so
# they have to live together; that makes this script a small supervisor, and a
# supervisor has exactly two jobs it cannot get wrong.
#
#   1. A dead worker has to take the container down with it. An API whose queue
#      has no consumer still accepts uploads and still hands back a job id, and
#      every one of those jobs sits at `queued` forever. That failure is silent
#      and, from the operator's side, indistinguishable from "CPU inference is
#      slow" - which it legitimately is, at ~2s per still and ~27s per video
#      frame. Exiting non-zero instead turns an invisible stall into a crashed
#      deploy that Railway reports and restarts.
#
#   2. SIGTERM has to reach the workers. Railway sends it on every redeploy. A
#      worker that never sees it is torn down mid-job with its row still at
#      `running` and no process behind it: the queue skips that row because it
#      is not `queued`, and the SSE stream keepalives at the operator with no
#      terminal event. `db.requeue_stale_jobs` does recover it once the lease
#      expires (300s by default), but a five-minute stall we could have avoided
#      is still a five-minute stall.
#
# Point 1 is why uvicorn is a background job here instead of an `exec`. `exec`
# would replace this shell, which would leave nothing watching the workers and
# make PID 1 a process that knows nothing about them.
set -euo pipefail

# Associative arrays (4.0), `wait -n` (4.3) and the ${var@Q} quoting used by the
# config validation below (4.4) are all load-bearing, so 4.4 is the real floor -
# a 4.3 shell would clear this gate and then die on "bad substitution" while
# reporting a bad $PORT. Fail with a sentence rather than with confusing
# behaviour if the image ships ash/dash.
if [[ -z "${BASH_VERSINFO:-}" ]] \
   || (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4) )); then
  echo "[entrypoint] FATAL: needs bash >= 4.4 (got ${BASH_VERSION:-unknown})." >&2
  echo "[entrypoint] Install bash in the image, or run this with bash explicitly." >&2
  exit 1
fi

log()  { printf '[entrypoint] %s\n' "$*" >&2; }
die()  { printf '[entrypoint] FATAL: %s\n' "$*" >&2; exit 1; }

# --------------------------------------------------------------- application

# The entrypoint may be copied to /usr/local/bin, so its own directory is not
# necessarily the app. Prefer wherever `service/api.py` actually is: next to the
# script if it was copied into the tree, otherwise the image's WORKDIR.
_here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$_here/service/api.py" ]]; then
  APP_DIR="$_here"
else
  APP_DIR="${TULEN_APP_DIR:-$PWD}"
fi
cd "$APP_DIR" || die "cannot enter app directory: $APP_DIR"
[[ -f service/api.py && -f service/worker.py ]] \
  || die "no service/ package under $APP_DIR - set \$TULEN_APP_DIR to the app root"

PYTHON="${TULEN_PYTHON:-python}"
command -v "$PYTHON" >/dev/null 2>&1 || die "interpreter not on PATH: $PYTHON"

# Unbuffered because these logs go to a pipe, where Python would otherwise block
# -buffer them and Railway would show nothing until 8KB had accumulated - which
# on a quiet queue can be hours. No .pyc writes: the tree is baked at build time
# and per-boot bytecode churn buys nothing.
export PYTHONUNBUFFERED=1
export PYTHONDONTWRITEBYTECODE=1

# ------------------------------------------------------------------- config

# One knob for the volume, then per-path overrides. Both processes must resolve
# the SAME database file: the API reads the queue the worker writes, and if they
# disagreed, jobs would be accepted into one file and polled for in another -
# the "queued forever" failure again, this time with no crash to point at.
# Exporting is what guarantees agreement, since `db.default_db_path()` reads
# $TULEN_DB and `api.WORKSPACE` reads $TULEN_WORKSPACE.
DATA_DIR="${TULEN_DATA_DIR:-/data}"
export TULEN_DB="${TULEN_DB:-$DATA_DIR/tulen.db}"
export TULEN_WORKSPACE="${TULEN_WORKSPACE:-$DATA_DIR/workspace}"

PORT="${PORT:-8090}"
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT > 0 && PORT < 65536 )) \
  || die "PORT must be a port number, got: ${PORT@Q}"

# Rejected rather than coerced: `WORKER_CONCURRENCY=two` silently becoming 0
# workers is precisely the state this script exists to prevent.
WORKER_CONCURRENCY="${WORKER_CONCURRENCY:-1}"
[[ "$WORKER_CONCURRENCY" =~ ^[0-9]+$ ]] && (( WORKER_CONCURRENCY >= 1 )) \
  || die "WORKER_CONCURRENCY must be a positive integer, got: ${WORKER_CONCURRENCY@Q}"

# Seconds to let children wind down on SIGTERM before escalating. Keep this
# comfortably below Railway's drainingSeconds (railway.json sets 30) or the
# platform's SIGKILL lands first and the ladder below never runs.
SHUTDOWN_GRACE="${TULEN_SHUTDOWN_GRACE:-10}"
SHUTDOWN_ESCALATE="${TULEN_SHUTDOWN_ESCALATE:-5}"

# --------------------------------------------------------- volume + preflight

# The volume mounts empty on first boot, and `sqlite3.connect` will happily
# create a database on the container's ephemeral layer if the mount is missing -
# which loses every survey on the next deploy. Create the paths, then prove they
# are writable, so a bad mount fails here instead of at the first upload.
mkdir -p -- "$(dirname -- "$TULEN_DB")" "$TULEN_WORKSPACE" \
  || die "cannot create directories under $DATA_DIR - either the volume is not
     mounted there, or it is not writable by uid $(id -u). Railway volumes are
     created root-owned, so a non-root USER in the Dockerfile needs the mount
     point chown-ed to it."

for dir in "$(dirname -- "$TULEN_DB")" "$TULEN_WORKSPACE"; do
  probe="$dir/.write-probe.$$"
  if ! : >"$probe" 2>/dev/null; then
    die "not writable: $dir (volume mounted read-only, or owned by another uid?)"
  fi
  rm -f -- "$probe"
done

engine_state="unchecked"
engine_detail=""
if [[ "${TULEN_SKIP_PREFLIGHT:-0}" == "1" ]]; then
  log "preflight skipped (TULEN_SKIP_PREFLIGHT=1)"
else
  # ffmpeg is not optional: la_studio/frames.py shells out to it and raises
  # without it, so every video job would fail one at a time, at runtime.
  command -v ffmpeg  >/dev/null 2>&1 || die "ffmpeg not on PATH - video jobs cannot run"
  command -v ffprobe >/dev/null 2>&1 || die "ffprobe not on PATH - video jobs cannot run"

  # Ask the engine module itself rather than restating its paths here: it owns
  # where the checkpoint and its interpreter live, and duplicating that would
  # rot the moment either moves. Doubles as an import smoke test - the module
  # pulls in nothing heavier than pathlib, so this costs one interpreter start.
  #
  # The three names below are the exact three `available()` tests, in its order.
  # Print all three: `available()` is the AND of them, so reporting a subset
  # leaves a boot that failed on the one part this script did not mention.
  if ! engine_report="$("$PYTHON" - <<'PY' 2>&1
from la_studio import countgd_engine as engine

print("ok" if engine.available() else "missing")
print(engine.PYTHON)
print(engine.CHECKPOINT)
print(engine.BERT_DIR)
PY
  )"; then
    die "engine preflight failed in $APP_DIR:"$'\n'"$engine_report"
  fi

  { read -r engine_state
    read -r engine_python
    read -r engine_ckpt
    read -r engine_bert
  } <<<"$engine_report"
  if [[ "$engine_state" != "ok" ]]; then
    # Refusing to boot is the point. With no engine every job fails identically
    # and the API keeps taking uploads; a container that never starts is the
    # louder, cheaper version of the same news.
    die "CountGD is not usable in this image - every detection job would fail.
       interpreter:  $engine_python $( [[ -f "$engine_python" ]] && echo '(present)' || echo '(MISSING)')
       checkpoint:   $engine_ckpt $( [[ -f "$engine_ckpt" ]] && echo '(present)' || echo '(MISSING)')
       text encoder: $engine_bert $( [[ -d "$engine_bert" ]] && echo '(present)' || echo '(MISSING)')
     The 1.6GB of weights cannot be committed to git, so the image has to fetch
     them at build time; see the Dockerfile. Set TULEN_SKIP_PREFLIGHT=1 to boot
     anyway (useful only for debugging the API in isolation)."
  fi
  engine_detail="$engine_ckpt"
fi

# ------------------------------------------------------------------ start-up

log "Tulen starting"
log "  app dir     : $APP_DIR"
log "  python      : $(command -v "$PYTHON")"
log "  database    : $TULEN_DB"
log "  workspace   : $TULEN_WORKSPACE"
log "  bind        : 0.0.0.0:$PORT"
log "  workers     : $WORKER_CONCURRENCY"
log "  engine      : ${engine_state}${engine_detail:+ ($engine_detail)}"
log "  ffmpeg      : $(command -v ffmpeg 2>/dev/null || echo 'not found')"
log "  shutdown    : ${SHUTDOWN_GRACE}s grace, +${SHUTDOWN_ESCALATE}s before SIGKILL"

# Inference is compute-bound on CPU, so workers past the core count do not add
# throughput - they split the same cores and make every job slower, including
# the one an operator is watching. Warn rather than clamp; the operator may know
# something about their plan's limits that nproc does not.
if command -v nproc >/dev/null 2>&1; then
  cores="$(nproc)"
  (( WORKER_CONCURRENCY > cores )) && log \
    "  note: $WORKER_CONCURRENCY workers on $cores core(s) - CPU inference is" \
    "compute-bound, so this slows every job down rather than adding throughput"
fi

declare -a CHILD_PIDS=()
declare -A CHILD_NAME=()

track() { CHILD_PIDS+=("$1"); CHILD_NAME["$1"]="$2"; }

# Workers first, so the queue has consumers before the API can put anything in
# it. --db is passed explicitly even though $TULEN_DB would be picked up anyway:
# it makes the resolved path visible in `ps` and immune to a child that somehow
# starts with a different environment.
for (( i = 1; i <= WORKER_CONCURRENCY; i++ )); do
  "$PYTHON" -m service.worker --worker-id "w$i" --db "$TULEN_DB" &
  track "$!" "worker w$i"
  log "started worker w$i (pid $!)"
done

"$PYTHON" -m uvicorn service.api:app --host 0.0.0.0 --port "$PORT" &
track "$!" "api"
log "started api (pid $!)"

# ------------------------------------------------------------------ shutdown

alive_pids() {
  local pid
  for pid in "${CHILD_PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then printf '%s\n' "$pid"; fi
  done
}

signal_children() {
  local sig="$1" pid
  for pid in $(alive_pids); do kill -"$sig" "$pid" 2>/dev/null || true; done
}

# Poll rather than `wait`, because we need a deadline: a worker's SIGTERM
# handler finishes the job in flight before stopping, and a video job is minutes
# of work that Railway will not wait for.
await_exit() {
  local deadline=$(( SECONDS + $1 ))
  while (( SECONDS < deadline )); do
    [[ -z "$(alive_pids)" ]] && return 0
    sleep 0.2
  done
  [[ -z "$(alive_pids)" ]]
}

SHUTTING_DOWN=0
on_signal() {
  # Re-entrant by design: orchestrators routinely send a second SIGTERM, and
  # restarting the ladder from the top would reset the deadline every time.
  (( SHUTTING_DOWN )) && return 0
  SHUTTING_DOWN=1
  log "received SIG$1 - stopping ${#CHILD_PIDS[@]} child process(es)"

  signal_children TERM
  if await_exit "$SHUTDOWN_GRACE"; then
    log "all children stopped cleanly"
    exit 0
  fi

  # The second SIGTERM is deliberate, not a repeat: service/worker.py treats it
  # as "exit now, the running job stays claimed" (os._exit(130)). That is a
  # cleaner stop than SIGKILL - it is the worker's own documented escape - and
  # the abandoned claim is exactly what db.requeue_stale_jobs exists to recover.
  log "still running after ${SHUTDOWN_GRACE}s - second SIGTERM (worker will drop its claim)"
  signal_children TERM
  if ! await_exit "$SHUTDOWN_ESCALATE"; then
    log "SIGKILL: $(alive_pids | tr '\n' ' ')"
    signal_children KILL
    await_exit 2 || true
  fi

  # Reap, so nothing is left as a zombie under PID 1 on the way out. The CountGD
  # subprocess a worker spawns is our grandchild, not our child; it is orphaned
  # here and cleaned up by container teardown, which is why this only waits on
  # direct children.
  local pid
  for pid in "${CHILD_PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done

  log "shutdown complete"
  exit 0
}

trap 'on_signal TERM' TERM
trap 'on_signal INT'  INT

# ---------------------------------------------------------------- supervision

# Block until any child exits. A trapped signal interrupts `wait`, which is what
# lets on_signal run promptly instead of after the next job finishes.
while true; do
  status=0
  wait -n || status=$?
  (( SHUTTING_DOWN )) && break

  # `wait -n` reports a status but not whose, so the corpse is identified by
  # elimination. It can legitimately come up empty - `wait -n` also returns when
  # there are no children left to wait for - and an empty array subscript is a
  # hard error under `set -u`, which would replace the diagnosis below with
  # "bad array subscript" at the exact moment someone needs to read it.
  dead_pid=""
  for pid in "${CHILD_PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then dead_pid="$pid"; break; fi
  done
  if [[ -n "$dead_pid" ]]; then
    dead_name="${CHILD_NAME[$dead_pid]:-unknown child}"
  else
    dead_name="a child process"
  fi

  # Every exit here is fatal, including status 0. A worker that returns cleanly
  # has still stopped consuming the queue, and an API that returns cleanly has
  # still stopped serving - neither is something to keep the container up for,
  # and "half the service is gone" is worse than "the service is down" because
  # only one of the two is visible.
  log "FATAL: $dead_name (pid ${dead_pid:-?}) exited with status $status"
  log "a half-running container would accept jobs it can never finish - exiting"

  SHUTTING_DOWN=1
  signal_children TERM
  await_exit "$SHUTDOWN_GRACE" || { signal_children KILL; await_exit 2 || true; }
  for pid in "${CHILD_PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done

  # Never exit 0 on this path: Railway's ON_FAILURE restart policy keys off the
  # exit status, and a zero would leave the container stopped and quiet.
  exit $(( status == 0 ? 1 : status ))
done
