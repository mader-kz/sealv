# Deploying Tulen to Railway

This is the operational guide for putting the Caspian seal detection backend on
Railway: what the container looks like, what it costs, where it stops scaling,
and what breaks first.

Numbers in this document were measured, not estimated. Where a figure is a
projection rather than a measurement it says so.

---

## 1. What actually gets deployed

**One Railway service. One container. One volume. Two processes inside it.**

```
┌─ Railway service "tulen" ──────────────────────────────┐
│                                                        │
│  PID 1  /app/docker-entrypoint.sh   (bash supervisor)  │
│    │                                                   │
│    ├─ child  python -m service.worker --worker-id w1   │
│    │         ├─ claims jobs from SQLite                │
│    │         └─ subprocess per image for CountGD       │
│    │                                                   │
│    └─ child  python -m uvicorn service.api:app         │
│              --host 0.0.0.0 --port $PORT               │
│              ├─ serves the REST API (/v1/...)          │
│              └─ serves webapp/index.html at /          │
│                                                        │
│  /data  ← Railway volume                               │
│         ├─ tulen.db      (SQLite, WAL)                 │
│         └─ workspace/    (uploaded media, frames)      │
└────────────────────────────────────────────────────────┘
```

PID 1 is the **entrypoint script**, not uvicorn. That is deliberate and §5
explains it: something has to notice when a worker dies, and a process that has
`exec`-ed itself into uvicorn cannot.

### One interpreter, not two

There is **one** Python environment in the image, at the system interpreter, and
it holds everything: fastapi, uvicorn, and torch 2.2.1 / torchvision 0.17.1 /
transformers 4.39.1.

A dev Mac is the case that needs two. There, CountGD's pins cannot share a
process with the MLX LocateAnything stack (transformers 5.x), so
`la_studio/countgd_engine.py` shells out to a side venv. In the container there
is no MLX and therefore no conflict, so it shells out to *itself*:

```python
def _interpreter() -> Path:
    override = _env_path("COUNTGD_PYTHON")
    if override is not None:
        return override
    venv = ROOT / ".venv-countgd" / "bin" / "python"
    return venv if venv.is_file() else Path(sys.executable)
```

The path is **not** hardcoded — `$COUNTGD_PYTHON` overrides it and
`sys.executable` is the fallback. Inference still runs in a fresh subprocess per
image; only the interpreter is shared.

> **Do not create a `.venv-countgd` in the image to "be safe".** It is not
> inert. `preflight._check_pins` verifies torch and transformers against their
> pins *only* when the engine's interpreter is the running one — that is the
> condition under which `importlib.metadata` is telling it the truth. A venv at
> that path makes the two differ, and the pin check silently turns itself off on
> every boot. CountGD vendors a GroundingDINO fork that newer releases import
> cleanly and then count differently, so that check is the guard against the one
> failure this tool must never ship. Trading it for a directory that exists to
> satisfy a path assumption that no longer holds is a bad deal.

> **Do not install `requirements.txt` in the image.** That file describes the
> local macOS LocateAnything path and pulls `mlx` / `mlx-lm`, which are
> Apple-Silicon only and cannot install on linux/amd64. Verified by tracing
> imports: `service/` reaches only fastapi, starlette, PIL, numpy, and
> `la_studio`'s `{frames, tiling, consensus, countgd_engine}` — none of which
> import mlx. The Dockerfile uses an explicit package list instead.

---

## 2. Why there is no docker-compose

Railway builds **one Dockerfile per service**. There is no compose runtime.

Railway does accept a `docker-compose.yml`: you drop it on the project canvas
and it *imports* the file by splitting each compose service into a separate
Railway service. That is a scaffolding convenience, not compose support — and
for this application it breaks the one invariant that matters:

> **It is not possible to attach the same volume to two Railway services.**
> (Railway has stated this is requested but not planned. Multiple volumes per
> service are also unsupported.)

The API and the worker share **one SQLite file**. `service/db.py` opens it in
WAL mode precisely so the API can read job progress while a worker writes it:

```python
conn.execute("PRAGMA journal_mode = WAL")
```

Split them into two Railway services and each gets its own volume, its own
`tulen.db`, and its own empty job queue. The API would accept uploads and queue
jobs into a database no worker can see; `/healthz` would report a healthy system
with jobs stuck in `queued` forever. Nothing would error — it would just
silently never work.

Hence: **one service, both processes, one container, one volume.** The container
entrypoint in §5 starts them.

---

## 3. Before you start

### 3.1 The repository

Railway deploys from a git repo. Before the first push, confirm nothing large is
tracked — a 1.2 GB blob in git history is not something you remove casually, and
GitHub hard-rejects files over 100 MB:

```bash
git ls-files -z | xargs -0 du -h 2>/dev/null | sort -rh | head
```

Nothing should be anywhere near 100 MB. The two files that must never appear:

| File | Bytes | Where it comes from instead |
|---|---|---|
| `vendor/CountGD/checkpoints/checkpoint_best_regular.pth` | 1,250,122,522 (1.16 GiB) | Downloaded during the Docker build (§4) |
| `vendor/CountGD/checkpoints/bert-base-uncased/model.safetensors` | 440,449,768 (420 MiB) | Downloaded during the Docker build (§4) |

`yolo11x.pt` (114 MB) is also in the tree and is an unrelated detector this
service never loads; it must stay untracked too.

### 3.2 `.dockerignore`

Already in the repo, and worth reading before you change anything: it is 96
lines and two of its rules are load-bearing rather than cosmetic.

- **`vendor/CountGD/checkpoints`.** The Dockerfile downloads the weights *into*
  that directory, and the later `COPY vendor/CountGD/` would otherwise overwrite
  them with whatever the dev machine had — or push 1.6 GB through the build
  context to write identical bytes.
- **`.venv*`.** The three local venvs are ~700 MB each and built for macOS
  arm64, so they are not merely redundant in a linux/amd64 image, they are
  unusable. This is also what keeps a stray `.venv-countgd` from reaching the
  image and disabling the pin check (§1).

`web/` is excluded and `webapp/` is not: `service/api.py` serves
`webapp/index.html` at `/`, and `web/` is the older standalone page. `run.sh`
and `start.sh` are excluded because they are dev entrypoints that bind
`127.0.0.1` and reference the macOS venvs by path.

---

## 4. The Dockerfile

**It is already in the repo, at the root, as `Dockerfile`.** Railway auto-detects
that name (anything else needs `RAILWAY_DOCKERFILE_PATH`), and `railway.json`
pins it explicitly anyway. Read it rather than re-deriving it — it is commented
where the reasoning is not obvious. This section covers only what an operator
needs to know about it.

**Single stage, one interpreter.** There is no builder stage and no venv. A
multi-stage split buys nothing here: the only compiled dependency is
`pycocotools`, which publishes a `cp312` manylinux wheel, so no toolchain is
ever installed to leave behind. See §1 for why an extra venv is actively
harmful.

**Layer order is the point.** Heaviest and least volatile first:

| Layer | Roughly | Invalidated by |
|---|---|---|
| `apt-get` ffmpeg + libglib/libgl/libgomp | ~250 MB | Editing the apt line |
| torch 2.2.1+cpu, torchvision, numpy 1.26.4 | ~500 MB | Editing that pip line |
| transformers 4.39.1 and the rest | ~400 MB | Editing that pip line |
| **model weights, 1.69 GB** | 1.69 GB | Editing the download step |
| `COPY vendor/ la_studio/ service/ webapp/` | ~3 MB | **Every code change** |

So editing `service/api.py` rebuilds the last few layers in seconds and never
re-pulls the model.

**Three things in it that are easy to get wrong:**

1. **`torch==2.2.1+cpu`, from `--index-url https://download.pytorch.org/whl/cpu`.**
   The explicit `+cpu` local version can only be satisfied by that index; plain
   PyPI publishes `2.2.1`, which bundles the CUDA runtime and costs gigabytes a
   CPU container can never use. Pinning the local segment removes any chance of
   the resolver picking the CUDA build.
2. **`numpy==1.26.4` is pinned in the same transaction as torchvision**, because
   torchvision 0.17.1 declares an unbounded `numpy` dependency and would happily
   install numpy 2.x, which its compiled extensions cannot load.
3. **The weights are downloaded above the `COPY`, and `.dockerignore` excludes
   `vendor/CountGD/checkpoints`.** Both halves are required: without the ignore
   rule, `COPY vendor/CountGD/` would overwrite the freshly downloaded weights
   with whatever the build context had.

**The build asserts its own work.** The last `RUN` before the entrypoint runs
`service.preflight.check(probe_writes=False)` — the same checks the container
runs at boot: interpreter, checkpoint, BERT directory, a 100 MB size floor on
both weight files that catches a truncated download, ffmpeg on PATH, and the
torch/transformers pins. A mis-wired image therefore fails the **build**, not
the first upload.

**Image size: expect roughly 3–4 GB.** That is a projection, not a measurement —
the honest inputs are: weights 1,690,572,290 B (1.69 GB) exactly, and the linux
CPU torch wheel is 178 MB compressed. The often-quoted 726 MB / torch-282 MB
figures are the **macOS arm64** venv on the dev machine and do not transfer.

**First build takes a while** — figure 10–20 minutes, dominated by the 1.6 GB of
weights and the torch wheel. Subsequent builds that touch only application code
hit the cache and finish in under a minute.

---

## 5. The container entrypoint

**It is already in the repo, at the root, as `docker-entrypoint.sh`**, and the
Dockerfile installs it with `ENTRYPOINT ["/app/docker-entrypoint.sh"]` — an
entrypoint rather than a `CMD`, because it takes no arguments and is configured
entirely through the environment.

It replaces `start.sh`, which is a local dev script and is **wrong for Railway
in two ways**: it binds `--host 127.0.0.1` (Railway's proxy cannot reach that —
it must be `0.0.0.0`), and it hardcodes a single worker. `.dockerignore` keeps
it out of the image so the two cannot be confused.

### What it does, in order

1. **Locates the app** by looking for `service/api.py` next to itself.
2. **Validates config** — `$PORT` must be a port number, `$WORKER_CONCURRENCY` a
   positive integer. Both are rejected rather than coerced, because
   `WORKER_CONCURRENCY=two` silently becoming zero workers is precisely the
   state this script exists to prevent.
3. **Creates and write-probes the volume paths** before anything starts, so a
   missing or read-only mount fails here instead of at the first upload.
4. **Runs the preflight** — ffmpeg and ffprobe on PATH, then the engine's own
   `available()` triple (interpreter, checkpoint, BERT directory). If the engine
   is unusable it **refuses to boot**. That is the point: a container that never
   starts is the louder, cheaper version of "every job fails".
5. **Starts the workers first, then uvicorn**, so the queue has consumers before
   anything can be put in it.
6. **Supervises.**

### The two things a supervisor cannot get wrong

**A dead worker must take the container down.** An API whose queue has no
consumer still accepts uploads and still hands back a job id, and every one of
those jobs sits at `queued` forever — a failure indistinguishable from "CPU
inference is slow", which it legitimately is. So the script blocks on `wait -n`
and treats *any* child exit as fatal, **including status 0**: half a service is
worse than no service, because only one of the two is visible. It never exits 0
on that path, because Railway's `ON_FAILURE` restart policy keys off the exit
status and a zero would leave the container stopped and quiet.

> Verified: a worker exiting with status 7 took the container down with exit
> code 7, logging `FATAL: worker w1 (pid 17) exited with status 7`.

**SIGTERM must reach the workers.** Railway sends it on every redeploy. A worker
that never sees it is torn down mid-job with its row still at `running` and no
process behind it; `db.requeue_stale_jobs` recovers that only after the 300 s
lease expires. This is why uvicorn is a background job and **not** an `exec`:
`exec` replaces the shell, which would discard the traps and leave nothing
watching the workers.

The shutdown path is a ladder: SIGTERM to all children → wait
`TULEN_SHUTDOWN_GRACE` (10 s) → a second SIGTERM, which `service/worker.py`
treats as "exit now, drop the claim" → wait `TULEN_SHUTDOWN_ESCALATE` (5 s) →
SIGKILL. The total (15 s) is deliberately under `railway.json`'s
`drainingSeconds: 30`, or the platform's own SIGKILL would land first and the
ladder would never run.

> Verified on `python:3.12-slim` with two workers plus the API: `docker stop`
> produced `received SIGTERM - stopping 3 child process(es)`, both workers and
> the API each logged receiving it, then `all children stopped cleanly`.

---

## 6. Step-by-step Railway deploy

**Most of the deploy config is already committed, in `railway.json`.** Railway
reads it from the repo root, so these settings do not need to be clicked in and
will not drift:

```json
{
  "build":  { "builder": "DOCKERFILE", "dockerfilePath": "Dockerfile" },
  "deploy": {
    "numReplicas": 1,
    "requiredMountPath": "/data",
    "healthcheckPath": "/healthz",
    "healthcheckTimeout": 300,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 5,
    "overlapSeconds": 0,
    "drainingSeconds": 30,
    "sleepApplication": false
  }
}
```

Two of those are load-bearing and worth understanding rather than trusting:

- **`overlapSeconds: 0`.** The default rolling deploy briefly runs the old and
  new containers together. They cannot both hold this volume, and two writers on
  one SQLite file is exactly the corruption case WAL does not protect against
  across a handover. Zero overlap means old-stops-then-new-starts.
- **`sleepApplication: false`.** Railway sleeps a service after ~10 minutes with
  no **outbound** packets, and only inbound traffic wakes it. A worker grinding
  through a video is pure local CPU and local file I/O — it emits no outbound
  packets at all, so a long sortie can be slept mid-job, and a queued job
  generates no traffic to wake the container back up. For this workload sleeping
  is a correctness hazard, not a latency one. Leave it off.

`requiredMountPath` is accepted by Railway's config schema and is intended to
stop a deploy that has no volume at `/data`. It is **not** in Railway's
config-as-code documentation, so do not lean on it: the container checks the
same thing itself at boot (`TULEN_REQUIRE_VOLUME`, §7), because a durability
guarantee you cannot verify from inside the process is not a guarantee.

### The steps

1. **Push the repo** to GitHub with the ignore rules verified per §3. Confirm no
   weight files were committed:
   ```bash
   git ls-files -z | xargs -0 du -h 2>/dev/null | sort -rh | head
   ```
   Nothing should be near 100 MB.

2. **Create the service.** Railway dashboard → *New Project* → *Deploy from
   GitHub repo* → pick the repo. Railway reads `railway.json` and builds the
   root `Dockerfile`. Let this first build sit — the volume is not attached yet.

3. **Attach the volume before the first successful boot.** Service → *Variables*
   panel → *+ New Volume* (or right-click the service on the canvas → *Attach
   Volume*). Set the **mount path to `/data`**, matching `requiredMountPath`.
   Size it per §8; the Hobby plan caps volumes at 5 GB.

   Preflight refuses to start if `/data` is not a **mount point**, and the
   entrypoint additionally write-probes it. Both matter, and they catch
   different things: a missing volume is invisible to a write probe, because
   `mkdir -p` creates the directory on the container's own filesystem and every
   write to it succeeds — right up until the next deploy deletes the archive.

4. **Set the environment variables** (§7). Railway injects `PORT` itself — do
   not set it. In the common case there is nothing to set at all: the Dockerfile
   already bakes `TULEN_DATA_DIR=/data` and `COUNTGD_REPO`.

5. **Deploy** and watch the logs. A healthy boot logs the entrypoint banner, then
   one line per worker, then uvicorn:
   ```
   [entrypoint] Tulen starting
   [entrypoint]   database    : /data/tulen.db
   [entrypoint]   workspace   : /data/workspace
   [entrypoint]   bind        : 0.0.0.0:8080
   [entrypoint]   workers     : 1
   [entrypoint] started worker w1 (pid 7)
   [preflight] worker: engine, ffmpeg and storage all present
   worker w1 ready (lease 300s, max 3 attempts/job)
   INFO:     Uvicorn running on http://0.0.0.0:8080
   ```
   Worker ids are `w1`, `w2`, … — the entrypoint passes `--worker-id "w$i"`. The
   port is whatever Railway injected as `$PORT`.

6. **Verify** against the deployed URL:
   ```bash
   curl -s https://<your-app>.up.railway.app/healthz | python3 -m json.tool
   ```
   Expect `"status": "ok"`, `"workspace": "/data/workspace"`, and an `engine`
   block reporting `"backend": "local"`, `"weights": true`, `"ffmpeg": true`,
   `"problems": []`. `/healthz` runs the same `preflight.summary()` the boot
   check runs, so a green healthz *does* mean the detector is wired up — but it
   proves configuration, not inference. Still upload one still and confirm a run
   completes end to end before trusting the deployment.

   If `workspace` is not under `/data`, the volume or the variable is wrong —
   stop and fix it before uploading anything.

---

## 7. Environment variables

Set these in the Railway service's *Variables* panel. The Dockerfile in §4
already sets sane defaults for all of them; Railway values override.

The volume is configured by **one** variable, `TULEN_DATA_DIR`. The entrypoint
derives `TULEN_DB` and `TULEN_WORKSPACE` from it and *exports* them, which is
what guarantees the API and the workers open the same SQLite file. The
Dockerfile deliberately does **not** bake the two derived paths as well: the
entrypoint fills them in only when unset (`${TULEN_DB:-$DATA_DIR/tulen.db}`), so
an image-level value would win and silently make `TULEN_DATA_DIR` a no-op.

| Variable | Value | What reads it |
|---|---|---|
| `TULEN_DATA_DIR` | `/data` | The entrypoint script (§5) — the volume root both paths below are derived from |
| `TULEN_DB` | *(derived: `$TULEN_DATA_DIR/tulen.db`)* | `service/db.py::default_db_path()` — set it only to override the derived path; unset **and** unexported it falls back to `~/.tulen/tulen.db`, which on Railway is ephemeral |
| `TULEN_WORKSPACE` | *(derived: `$TULEN_DATA_DIR/workspace`)* | `service/api.py` — uploaded media and extracted frames |
| `COUNTGD_REPO` | `/app/vendor/CountGD` | `la_studio/countgd_engine.py` — where the checkpoint and config live |
| `WORKER_CONCURRENCY` | `1` | The entrypoint script (§5) — how many worker processes to spawn |
| `PORT` | *(do not set)* | Injected by Railway; the entrypoint binds `0.0.0.0:$PORT` |

**Honest note on `WORKER_CONCURRENCY`:** no Python code reads this variable. It
is consumed entirely by the entrypoint script in §5, which uses it to decide how
many `python -m service.worker` processes to launch and gives each a distinct
`--worker-id`. Concurrent workers are safe by design — `db.claim_job()` takes
the write lock with `BEGIN IMMEDIATE` and claims with a single
`UPDATE ... WHERE id = (SELECT ... LIMIT 1)` — but see §8 before raising it,
because RAM is the binding constraint, not correctness.

Optional tuning, read by `service/worker.py`:

| Variable | Default | Meaning |
|---|---|---|
| `TULEN_JOB_LEASE_S` | `300` | Seconds a claim survives unrefreshed before another worker recovers the job |
| `TULEN_JOB_MAX_ATTEMPTS` | `3` | Claims allowed per job before recovery gives up and fails it — bounded so a job that OOM-kills its worker cannot crash-loop the queue forever |

Escape hatches. None of these should be set on a healthy deployment, and three
of them will quietly break it if they are — listed so that a container behaving
strangely can be checked against them:

| Variable | Default | Effect |
|---|---|---|
| `TULEN_PREFLIGHT` | *(unset)* | `warn` downgrades a fatal preflight to a logged banner. The UI then serves past runs and **every new job fails**. For recovering read access while storage or ffmpeg is broken, nothing else |
| `TULEN_SKIP_PREFLIGHT` | `0` | `1` makes the entrypoint skip its own engine check entirely. Debugging the API in isolation only |
| `TULEN_REQUIRE_VOLUME` | `/data` *(set by the Dockerfile)* | The path preflight asserts is a **mount point**, not merely a directory. Blank accepts ephemeral storage: the service then runs normally and every survey, run and count is destroyed by the next deploy. Only ever set it blank to smoke-test an image with no volume attached |
| `COUNTGD_PYTHON` | *(unset)* | Overrides the interpreter CountGD is invoked with. Setting it also **disables the torch/transformers pin check** (§1), because `importlib.metadata` can only speak for the running interpreter |
| `TULEN_MODAL_APP` | *(unset)* | Switches detection to a deployed Modal app (§11). When set, the image needs the `modal` client but none of the local weights, and preflight checks that instead |
| `TULEN_SHUTDOWN_GRACE` | `10` | Seconds children get on SIGTERM before the second one. Keep the total under `drainingSeconds` (30) |
| `TULEN_SHUTDOWN_ESCALATE` | `5` | Seconds after that before SIGKILL |

Both fall back to their defaults on an unparseable value rather than refusing to
start, "because a worker that will not start because `TULEN_JOB_LEASE_S=5m` is a
survey that does not run."

---

## 8. Sizing: CPU and RAM

### Measured

One CountGD detection subprocess, profiled with `/usr/bin/time -l` on a
612×459 still:

| Metric | Measured |
|---|---|
| **Peak RSS** | **3,550,806,016 B = 3.31 GiB** |
| torch import | 0.96 s |
| Model build + checkpoint load | 1.38 s |
| Inference | 1.84 s / 1.95 s (two runs) |
| Torch threads used | 16 |

The model is held **entirely in RAM** — 1.16 GiB of fp32 detector weights plus
420 MiB of BERT, plus transient copies during `load_state_dict` and the torch
runtime itself. 3.3 GiB is the floor for *one* concurrent detection, and it is
not reducible without quantizing the checkpoint.

### Recommended allocation

| Setting | Minimum | Comfortable |
|---|---|---|
| RAM | **4 GB** | **8 GB** |
| vCPU | 2 | 4–8 |
| `WORKER_CONCURRENCY` | 1 | 1 |
| Volume | 5 GB (Hobby cap) | 20–50 GB if videos are routine |

**4 GB is a genuine minimum, not a comfortable one** — 3.3 GiB of model leaves
under 700 MB for uvicorn, the worker, ffmpeg, and page cache. Give it 8 GB if
video is in scope, because ffmpeg decoding a 4K clip runs concurrently with
inference.

**Keep `WORKER_CONCURRENCY=1` unless you have measured headroom.** Two workers
means two simultaneous 3.3 GiB processes — 6.6 GiB of model alone. That is the
single easiest way to OOM this container.

### Timing, and why the local numbers flatter Railway

The project's reference figures are **~2 s per still** and **~27 s per video
frame** (the latter with 250 px tiling, which runs many inferences per frame).
Both were measured on a development machine where torch had **16 threads**.

A Railway container at 2 vCPU will be materially slower — plan on 2–4× for
CPU-bound inference. Nothing in the code adapts to this; it is simply less CPU.

There is also fixed overhead the headline numbers exclude. Because
`countgd_engine.detect()` spawns a fresh process per image, **every call pays
0.96 s of torch import plus 1.38 s of checkpoint load — ~2.3 s before any
inference happens.** Measured end-to-end, one small still took 5.24 s wall for
1.9 s of actual work.

The practical consequence: a video job sampling 240 frames is **240 × (~27 s +
2.3 s) ≈ 2 hours** on the reference machine, and plausibly 4–8 hours on a
2-vCPU container. That worker is occupied for the whole time. `service/worker.py`
already flags the fix — a long-lived warm child process — as unimplemented; see
§9 for why doing it changes the bill.

---

## 9. What it costs

Railway bills **usage**, per-second, on top of a subscription:

| Resource | Rate |
|---|---|
| vCPU | $0.000463 / vCPU / minute ($20 / vCPU / month) |
| RAM | $0.000231 / GB / minute ($10 / GB / month) |
| Volume | $0.15 / GB / month |
| Egress | $0.05 / GB |
| Hobby plan | $5 / month, includes $5 of usage |
| Pro plan | $20 / month per seat, includes $20 of usage |

**Say it plainly: a CPU-bound counting workload is the expensive kind for this
billing model.** You are billed for vCPU-minutes, and inference is nothing but
vCPU-minutes. There is no caching, no idle discount, no amortization across
requests — every frame costs what it costs. A GPU platform bills more per minute
but needs far fewer of them; Railway bills less per minute and you need many.

### The arithmetic

A month is 43,200 minutes. Two regimes:

**Idle** (API up, worker polling an empty queue every 2 s) — call it 0.35 GB
resident and ~0.01 vCPU:

```
RAM     0.35 GB × 43,200 min × $0.000231 = $3.49
CPU     0.01 vCPU × 43,200 min × $0.000463 = $0.20
Volume  5 GB × $0.15                       = $0.75
                                     idle floor ≈ $4.44 / month
```

That floor is paid whether or not anyone counts a single seal.

**Busy** (a job running: ~2 vCPU saturated, ~4 GB resident):

```
CPU     2 vCPU × $0.000463 = $0.000926 / min
RAM     4 GB   × $0.000231 = $0.000924 / min
                       total ≈ $0.00185 / min ≈ $0.11 per active hour
```

**About 11 cents per hour of active detection.** Now a light month — 300 stills
and 8 short videos at 240 frames each, using the pessimistic 60 s/frame Railway
projection:

```
Stills   300 × 10 s        =    50 min × $0.00185 = $0.09
Videos   8 × 240 × 60 s    = 1,920 min × $0.00185 = $3.55
Idle floor                                        = $4.44
                                          usage   ≈ $8.08 / month
```

On Hobby ($5/month including $5 of usage) that lands at roughly **$8–12 per
month all-in at light use.** The variance is almost entirely video: stills are
rounding error, and one heavily-sampled sortie can cost more than the rest of
the month combined.

### The warm-model trap

`service/worker.py` documents an intended optimization: keep one long-lived
CountGD child alive instead of reloading per image, saving the ~2.3 s of
import-plus-load per frame (~9 minutes across a 240-frame video).

**That optimization roughly quadruples the RAM bill.** Today the 3.3 GiB is
resident only while a detection is actually running, because the subprocess
exits and returns every byte to the OS — the process-per-call design is
accidentally cost-efficient on a usage-billed platform. A warm worker holds
3.3 GiB resident 24/7:

```
3.3 GB × 43,200 min × $0.000231 = $32.93 / month in RAM alone
```

It is still the right call if the box is busy most of the day. It is the wrong
call for a service that counts a few sorties a week. Decide on measured
duty-cycle, not on the latency number.

---

## 10. The SQLite constraint, and how to lift it

**Current ceiling: one container.** Not one *service*, one *container*. The API
and every worker must see the same `tulen.db` on the same filesystem, a Railway
volume attaches to exactly one service, and Railway does not offer shared
filesystems between services. Scaling means a bigger container, up to
`WORKER_CONCURRENCY` workers, bounded by 3.3 GiB of RAM each.

That is enough for a survey team. It is not enough for many concurrent teams,
and it has no redundancy: the container is a single point of failure and the
volume is a single point of data loss. **Take backups of `/data/tulen.db`** —
Railway volume backups, or a periodic `sqlite3 .backup` copied to object
storage.

### Porting to Postgres + object storage

The schema was written for this port. From `service/schema.sql`:

> Single-node worker pool for now; every construct here maps 1:1 onto Postgres
> if this needs to scale out (the only change is the job claim, which becomes
> `SELECT ... FOR UPDATE SKIP LOCKED`).

**The job claim.** `db._CLAIM_SQL` is already written in the portable shape:

```sql
UPDATE job
   SET status = 'running', claimed_by = ?, claimed_at = ?, attempts = attempts + 1
 WHERE id = (SELECT id FROM job
              WHERE status = 'queued'
           ORDER BY created_at, id
              LIMIT 1)
```

The subselect grows two words:

```sql
 WHERE id = (SELECT id FROM job
              WHERE status = 'queued'
           ORDER BY created_at, id
              LIMIT 1
         FOR UPDATE SKIP LOCKED)
```

This is deliberate, and `claim_job`'s docstring explains why the form was chosen
before it was needed: selecting an id and then updating it is equally safe under
SQLite's global write lock, but on Postgres there is no global write lock to
hide a check-then-act race behind. Writing it the portable way now means the
port is a string edit rather than a redesign.

**The rest of the change list**, all mechanical:

| Item | SQLite today | Postgres |
|---|---|---|
| Claim | `BEGIN IMMEDIATE` + `_tx(conn, "IMMEDIATE")` | Plain `BEGIN`; `FOR UPDATE SKIP LOCKED` does the serialization |
| `_HAS_RETURNING` fallback | Version check + re-`SELECT` branch | Delete it — Postgres always has `RETURNING` |
| Placeholders | `?` | `%s` (psycopg) |
| Timestamps | `TEXT` + `datetime('now')` | `timestamptz` + `now()` |
| Autoincrement | `INTEGER PRIMARY KEY AUTOINCREMENT` | `GENERATED ALWAYS AS IDENTITY` |
| Pragmas | WAL, `foreign_keys`, `busy_timeout` | Drop all — `db.connect()` becomes a pool |
| `_widen()` | Runtime `ALTER TABLE` on startup | Real migrations (Alembic) |

**Object storage is the other half, and it is the larger job.** `media.path`
holds a local workspace path, and `service/api.py` serves bytes with
`FileResponse` from three routes (`/media/{id}/file`,
`/media/{id}/frames/{name}`, `/media/{id}/frames/{job_id}/{name}`). Once workers
are separate containers, an uploaded file on the API's disk is invisible to
them. That means: `media.path` becomes an S3/R2 key, upload writes to the
bucket, workers fetch to a local scratch dir, extracted frames are written back,
and the `FileResponse` routes become presigned-URL redirects. The `SAFE_NAME`
regex guarding frame filenames stays — it guards key construction just as well
as path construction.

Only after both halves are done can the worker become its own Railway service,
scaled horizontally, with the API scaled independently.

---

## 11. Alternatives worth naming

Not endorsements — each is a different trade:

- **Fly.io** — volumes plus scale-to-zero and GPU machines; same one-volume-
  per-machine constraint, so it does not solve the SQLite split by itself.
- **Modal** — per-second serverless GPU with weights baked into the image;
  strong fit for spiky counting. **Already implemented**: `modal_app.py` is in
  the repo, `countgd_engine.detect()` routes to it when `$TULEN_MODAL_APP` is
  set, and preflight then checks for the `modal` client instead of the local
  weights. See `docs/DEPLOY_MODAL.md`. The worker keeps its polling loop — only
  the transport behind `detect()` changes, so nothing downstream knows which
  ran. This is the cheapest way to make video jobs tolerable.
- **RunPod / Vast.ai** — cheapest GPU-hours by a wide margin; you own the
  reliability, the queueing, and the babysitting.
- **Google Cloud Run** — scales to zero and now offers GPUs; no persistent local
  disk, so it forces the Postgres + object-storage port first.
- **Hetzner (cloud or dedicated) + Docker** — roughly €15–20/month for 8 vCPU /
  16 GB, far cheaper than Railway for an always-on CPU workload; no managed
  platform, no build pipeline, no volume backups unless you build them.
- **A GPU box at all** — CountGD on GPU is 10–50× faster per frame, which turns
  the 2-hour video job into minutes. If video is the main workload rather than
  stills, this is the change that matters most; everything else is tuning.

---

## 12. Troubleshooting

### 12.1 Weights missing — every job fails

**Symptom.** In the normal case you never see this, because both the build and
the boot preflight refuse to produce or start such a container (§4, §5). It is
reachable only with `TULEN_PREFLIGHT=warn` or `TULEN_SKIP_PREFLIGHT=1` set.

Jobs go `queued` → `running` → `failed`, and `job.error` names the missing
piece:

```
CountGD cannot run - missing: checkpoint /app/vendor/CountGD/checkpoints/checkpoint_best_regular.pth
```

or, on the tiled path:

```
detection failed on all 12 tiles of frame_00001.jpg: ...
```

The second message is deliberate — `service/detect.py` refuses to return a count
of 0 when every tile failed, because "every tile failing is an environment
fault, not a scene with nothing in it. Returning 0 would be a wrong answer."

**Cause.** `countgd_engine.available()` is the AND of **three** things — the
interpreter, the checkpoint, and the BERT text-encoder directory:

```python
return PYTHON.is_file() and CHECKPOINT.is_file() and BERT_DIR.is_dir()
```

The error message names whichever ones failed, so read it rather than guessing.
Usually the build's download step failed, or `COUNTGD_REPO` points somewhere
without a `checkpoints/` directory.

**Diagnose.** Ask the deployment, not the filesystem — `/healthz` already
carries the whole answer:

```bash
curl -s https://<app>.up.railway.app/healthz | python3 -m json.tool
```

```json
"engine": {
  "ok": false,
  "backend": "local",
  "weights": false,
  "ffmpeg": true,
  "problems": ["CountGD checkpoint missing at /app/vendor/CountGD/checkpoints/checkpoint_best_regular.pth"]
}
```

`"status"` is `degraded` whenever `engine.ok` is false. It is reported rather
than fatal on purpose: a container deliberately serving past runs should not be
killed by its own health check, but "why is every job failing" has to be
answerable from outside the box.

If you need to look directly, in a Railway shell:

```bash
ls -la /app/vendor/CountGD/checkpoints/
ls -la /app/vendor/CountGD/checkpoints/bert-base-uncased/
```

`checkpoint_best_regular.pth` must be 1,250,122,522 bytes and
`bert-base-uncased/model.safetensors` 440,449,768. A file of a few hundred bytes
is a git-lfs pointer or an HTML error page saved under the right name — which is
why preflight enforces a 100 MB floor on both rather than just `is_file()`.

The run record carries the same identity: `countgd_engine.version()` returns
`checkpoint_best_regular.pth/1250122522` — name and exact byte count — or `None`
when absent, never a placeholder, so a count can always be traced to the weights
that produced it.

### 12.2 ffmpeg missing — videos fail, stills work

**Symptom.** Image jobs succeed; every video job fails with:

```
ffmpeg/ffprobe not found on PATH - install with: brew install ffmpeg
```

`/healthz` reports `"ffmpeg": false`.

**Cause.** `apt-get install ffmpeg` missing from the runtime stage — or present
only in the builder stage, which does not carry over.

**The trap.** `la_studio/frames.py` resolves both binaries at **module import
time**:

```python
FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
```

Installing ffmpeg into a running container does **not** fix it. The processes
must restart. Fix the Dockerfile and redeploy.

### 12.3 Volume not mounted — data vanishes on every deploy

**Symptom.** Everything works, then a deploy wipes all media, surveys and runs.
Or: uploads succeed but the container restarts with a disk-full error.

**Cause.** No volume at `/data`, so `TULEN_DB` and `TULEN_WORKSPACE` resolved
onto the container's ephemeral layer.

**Diagnose.** `curl .../healthz` and read `engine.problems`. A missing mount
reports itself there:

```
/data exists but is not a mount point - the persistent volume is not attached,
so every upload, run and count would be written to the container's own
filesystem and lost on the next deploy
```

Reading `workspace` alone is **not** a diagnosis: it says `/data/workspace` in
both the healthy case and the ephemeral one. The two are indistinguishable by
path, which is what made this failure silent. Only a home-directory path like
`/root/.tulen/workspace` tells you the *variable* is wrong rather than the
mount.

Preflight refuses to boot on this, so in practice a container that has been up
for a while has its volume. The check is skipped only if `TULEN_REQUIRE_VOLUME`
was set blank or `TULEN_PREFLIGHT=warn`.

**Recovery.** There is none. Ephemeral data is gone. Attach the volume, set the
variables, redeploy, re-upload.

### 12.4 OOM during model load

**Symptom.** The container dies mid-job with exit code **137** (SIGKILL).
Railway logs show a restart with no Python traceback — the process was killed by
the kernel, so nothing got the chance to log.

**Cause.** Peak RSS during model load is **3.3 GiB** for a single detection. On
a 2 GB container it never survives the first job. With
`WORKER_CONCURRENCY=2` it needs 6.6 GiB before anything else.

**Fix.** Raise memory to 8 GB, or set `WORKER_CONCURRENCY=1`.

**What the system does on its own** — this part is already handled, and is worth
understanding before you go looking for stuck jobs. An OOM-killed worker never
reaches the `except` that records a failure, so its row stays `running` with no
process behind it. Recovery is a lease, not a heartbeat-free guess:

1. Workers refresh `claimed_at` while they work (`db.heartbeat_job`).
2. Every `lease/2` seconds, any live worker runs `db.requeue_stale_jobs()`.
3. A job whose `claimed_at` has stood still longer than `TULEN_JOB_LEASE_S`
   (default 300 s) is re-queued.
4. After `TULEN_JOB_MAX_ATTEMPTS` (default 3) it is failed permanently, so a job
   heavy enough to OOM its worker cannot crash-loop the queue forever.

So expect an OOM job to retry twice and then fail with a recorded reason. If you
see a job at `attempts = 3`, you have found a genuine resource problem, not a
transient one.

### 12.5 Worker died — jobs sit in `queued` forever

**Symptom.** The API is fully responsive, `/healthz` returns `"status": "ok"`,
uploads succeed, jobs are accepted with 202 — and nothing ever runs. `queued`
climbs, `running` stays 0.

**This is the failure mode that looks exactly like an idle system.** Nothing is
red. There is no error anywhere.

**Diagnose.**
```bash
curl -s https://<app>.up.railway.app/healthz | python3 -m json.tool
# {"status":"ok", ..., "jobs":{"queued":14,"running":0}}
```
`queued > 0` with `running == 0` for more than a couple of minutes means no
worker is alive. Confirm in the Railway logs: a healthy worker logs
`worker railway-w1 ready (lease 300s, max 3 attempts/job)` on boot, and the
process should still exist:

```bash
# `ps` is not in python:3.12-slim (no procps). Read /proc instead.
grep -l service.worker /proc/*/cmdline 2>/dev/null
```

**Cause.** The worker process died — OOM (§12.4), an unhandled crash at startup,
or an import error — while uvicorn, being a separate process, carried on
serving.

**Fix.** The §5 entrypoint supervises the workers and kills PID 1 when one dies,
so Railway restarts the container and the lease sweep recovers the in-flight
job. If you deployed without that supervision, this state persists indefinitely
and the only signal is the `queued`/`running` ratio.

**Worth alerting on:** `queued > 0 && running == 0` sustained for 5 minutes is a
precise, low-false-positive detector for a dead worker pool. It is the single
most valuable alert to add to this deployment.

### 12.6 Healthcheck flapping during long jobs

**Symptom.** Railway restarts the container mid-detection; jobs never finish and
`attempts` climbs to 3.

**Cause.** The healthcheck timeout is shorter than the response time of an API
whose container is CPU-saturated by inference. Railway concludes the service is
unhealthy; it is merely busy.

**Fix.** Raise the healthcheck timeout (60s+), give the container more vCPU so
the API is not starved, and keep `WORKER_CONCURRENCY` low enough to leave a core
for the API.

### 12.7 `no such table: job` or `database is locked`

**`no such table`** — the schema is applied by the API's FastAPI lifespan hook
(`db.init_db`) and by each worker on startup, and `schema.sql` is fully
`IF NOT EXISTS`. Seeing this means the process is looking at a *different file*
than the one that was initialized: `TULEN_DB` differs between the API and the
worker, most likely because it is set on only one of them. Both read the same
env var, so set it once at the service level.

**`database is locked`** — `db.connect()` sets `busy_timeout` to 30 s, so this
means a writer held the lock longer than that. On a Railway volume the usual
cause is slow disk I/O under a large frame-extraction write. It is transient by
design: `service/worker.py` catches a failed claim and retries rather than
dying, "because a locked database is transient often enough that dying here
would just mean the queue stops draining unattended."
