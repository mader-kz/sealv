# syntax=docker/dockerfile:1
#
# SEALv — Caspian seal detection backend (FastAPI + CountGD), CPU-only.
#
# One container runs BOTH processes. That is not a packaging shortcut: the API
# and the worker share a single SQLite file in WAL mode, and a Railway volume
# attaches to exactly one service. Splitting them would mean two volumes and
# two divergent databases, so they stay together and the entrypoint supervises
# both.
#
# Layer order is deliberate — heaviest and least volatile first, app source
# last — so that editing a Python file re-runs only the final few COPYs and
# never re-downloads 1.6 GB of weights or 400 MB of torch.

# Pinned to amd64 because that is what Railway runs, and because the torch pin
# below only exists there: PyTorch publishes `2.2.1+cpu` wheels for x86_64 only.
# On an aarch64 builder (any Apple Silicon dev machine) the CPU index carries no
# +cpu wheel at that version at all, so an unpinned build fails on the Mac while
# succeeding in CI - the worst kind of difference, because it is discovered at
# deploy time. Forcing the platform makes a local build byte-comparable with the
# deployed one; the cost is that building on ARM goes through emulation and is
# slow. That is the right trade for a verification build.
FROM --platform=linux/amd64 python:3.12-slim

# ---------------------------------------------------------------- system deps
# ffmpeg: la_studio/frames.py shells out to ffmpeg AND ffprobe for video frame
#   extraction — it hard-fails with FFmpegMissing if either is off PATH.
# libglib2.0-0: OpenCV links libgthread even in the headless build.
# libgl1: the headless wheel does not need libGL, but CountGD's own
#   requirements.txt asks for full opencv-python; if anything ever pulls that
#   in transitively, its absence surfaces as an obscure import-time crash deep
#   in a worker job. A few MB here buys immunity to that whole failure class.
# libgomp1: OpenMP runtime. The torch wheel vendors its own copy, but scipy and
#   pycocotools expect the system one.
#
# ARG, not ENV: this is build-time only and has no business in the runtime
# environment of the running service.
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libglib2.0-0 \
        libgl1 \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ------------------------------------------------------- torch (own layer)
# Pinned to the only combination CountGD's vendored GroundingDINO fork works
# with. Two things here are load-bearing:
#
# 1. The explicit "+cpu" local version can ONLY be satisfied by the PyTorch CPU
#    index — PyPI publishes plain "2.2.1", which bundles the CUDA runtime and
#    costs gigabytes that a CPU-only Railway box can never use. Pinning the
#    local segment removes any chance of the resolver picking the CUDA build.
#    --extra-index-url is a fallback for pure-python deps only; it cannot
#    supply a "+cpu" wheel.
#
# 2. numpy is pinned HERE, not in the layer below, because torchvision 0.17.1
#    declares an unbounded "numpy" dependency and would happily install numpy
#    2.x — which its compiled extensions cannot load. numpy must be resolved in
#    the same transaction that installs torchvision.
RUN pip install --no-cache-dir \
        --index-url https://download.pytorch.org/whl/cpu \
        --extra-index-url https://pypi.org/simple \
        torch==2.2.1+cpu \
        torchvision==0.17.1+cpu \
        numpy==1.26.4

# ------------------------------------------------- remaining python packages
# transformers is pinned: 4.39.1 is the last release CountGD's GroundingDINO
# fork imports cleanly. The rest float. Resolved against linux/amd64 cp312 they
# reproduce the matrix that is known to work locally. Resolved against
# linux/amd64 cp312 on top of the layer above: timm 1.0.28, transformers
# 4.39.1, tokenizers 0.15.2, opencv-headless 4.11.0.86, huggingface_hub 0.36.2,
# safetensors 0.8.0, pycocotools 2.0.11, scipy 1.17.1 — and pillow 12.3.0,
# which torchvision already pulled in one layer earlier.
#
# Two things make this layer safe to leave floating. torch and torchvision are
# NOT reinstalled here: timm depends on torch, but pip leaves an already-
# satisfied requirement alone, so the 2.2.1+cpu wheel from the layer above
# survives. (Resolved from a clean interpreter this same list picks torch
# 2.13.0 — the layer order is what prevents that, not the pins.) And
# transformers' own "huggingface-hub<1.0" bound is what keeps that dependency
# from jumping a major version underneath this image.
# opencv is the headless build on purpose: this container has no display and
# the GUI build drags in the whole X11 stack.
RUN pip install --no-cache-dir \
        transformers==4.39.1 \
        numpy==1.26.4 \
        timm \
        addict \
        yapf \
        opencv-python-headless \
        pycocotools \
        scipy \
        termcolor \
        colorlog \
        pyyaml \
        safetensors \
        matplotlib \
        fastapi \
        "uvicorn[standard]" \
        python-multipart \
        pillow \
        huggingface_hub \
        hf_transfer \
        modal

# `modal` is the client, not the model. With $SEALV_MODAL_APP set,
# countgd_engine forwards inference to a GPU on Modal and this container never
# loads torch weights at all - which is the recommended split, because CPU
# inference here is ~2s per still while the box must also stay responsive.
# Without the client installed that env var silently cannot work, so the
# offload path would fail at the first job rather than at boot. It ships always;
# it is a few MB and unused when the variable is unset.

# ------------------------------------------------------- CountGD interpreter
# There is deliberately NO .venv-countgd in this image.
#
# On a dev Mac that venv exists because CountGD (torch 2.2.1 / transformers
# 4.39.1) cannot share a process with the MLX LocateAnything stack
# (transformers 5.x). This image has no MLX and therefore no conflict:
# everything lives in one site-packages, and `countgd_engine._interpreter()`
# falls back to `sys.executable` precisely for this case.
#
# Creating the venv anyway is not harmless, which is why the earlier version of
# this file was wrong to. `preflight._check_pins` only runs when the engine's
# interpreter IS the running one — that is how it knows it can trust
# importlib.metadata — so a venv at that path makes the two paths differ and
# silently skips the torch/transformers pin check on every boot. That check is
# the guard against the failure mode this project cares about most: a newer
# release that imports cleanly and then counts differently. Losing it to a
# directory that exists only to satisfy a path assumption is a bad trade.
#
# So: no venv, one interpreter, and the pins verified for real at every start.
RUN python -c \
    "import torch, torchvision; print('countgd interpreter ok:', torch.__version__, torchvision.__version__)"

# --------------------------------------------------------------- model weights
# ~1.6 GB, fetched at BUILD time and baked into the image. They cannot be
# committed (GitHub caps blobs at 100 MB) and must not be fetched at boot —
# Railway would re-download them on every cold start and the first request
# would race the download.
#
# This sits above the source COPYs so a code change never re-downloads it.
#
# Only the five bert files the model actually loads are pulled. The repo also
# carries onnx/flax/rust/tf/coreml variants — 1.4 GB that nothing here reads.
# hf_transfer is the Rust-backed downloader; it saturates the build network far
# better than requests on a file this size.
ENV HF_HUB_DISABLE_TELEMETRY=1
RUN HF_HUB_ENABLE_HF_TRANSFER=1 python - <<'PY'
from huggingface_hub import hf_hub_download

CHECKPOINTS = "/app/vendor/CountGD/checkpoints"
BERT = f"{CHECKPOINTS}/bert-base-uncased"

# The detector weights live in a Space, not a model repo — repo_type matters.
hf_hub_download(
    repo_id="nikigoli/countgd",
    repo_type="space",
    filename="checkpoint_best_regular.pth",
    local_dir=CHECKPOINTS,
)

# cfg_fsc147_vit_b.py is pointed at this directory as text_encoder_type, so the
# layout has to match what transformers expects of a local model directory.
for name in (
    "config.json",
    "model.safetensors",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.txt",
):
    hf_hub_download(
        repo_id="google-bert/bert-base-uncased",
        filename=name,
        local_dir=BERT,
    )
PY

# huggingface_hub leaves per-file download metadata beside the weights; it is
# dead weight in an image whose contents can never change.
RUN rm -rf "/app/vendor/CountGD/checkpoints/.cache" \
           "/app/vendor/CountGD/checkpoints/bert-base-uncased/.cache"

# ------------------------------------------------------------------ app source
# Last, and split so the most-edited trees invalidate the least. vendor/CountGD
# is a vendored clone the engine imports (models.registry, util.slconfig,
# datasets_inference.transforms) — its code ships, its checkpoints directory is
# excluded by .dockerignore so this COPY cannot clobber what we just downloaded.
COPY vendor/CountGD/ /app/vendor/CountGD/
COPY la_studio/ /app/la_studio/
COPY service/ /app/service/
COPY webapp/ /app/webapp/

# ----------------------------------------------------------------- runtime env
# /data is the Railway volume mount: the SQLite file and the uploaded media /
# extracted frames are the only state that must outlive a deploy. Everything
# else in the image is reproducible.
#
# One knob, not three. The entrypoint derives SEALV_DB and SEALV_WORKSPACE from
# $SEALV_DATA_DIR and exports them, so both processes resolve the same files.
# Baking SEALV_DB/SEALV_WORKSPACE here as well would look like belt and braces
# and in fact silently disable the knob: the entrypoint fills them in only when
# unset (`${SEALV_DB:-$DATA_DIR/sealv.db}`), so an image-level value wins and
# SEALV_DATA_DIR=/srv/sealv would move nothing. Either variable may still be set
# at deploy time to override an individual path.
#
# SEALV_REQUIRE_VOLUME is the assertion that /data is a real mount and not just
# a directory. It has to be stated here because it is only true of a container:
# on a dev box ~/.sealv is a plain directory and the question is meaningless.
# Nothing else catches a forgotten volume — mkdir succeeds, the write probe
# passes, uploads work, /healthz says ok, and the whole survey archive is
# deleted by the next deploy. railway.json declares the same requirement as
# deploy.requiredMountPath, but that is a Railway-side promise this process
# cannot see; preflight restates it where it can be checked. Set it empty to
# run the image with no volume on purpose.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    COUNTGD_REPO=/app/vendor/CountGD \
    SEALV_DATA_DIR=/data \
    SEALV_REQUIRE_VOLUME=/data

# The mount point has to exist for a volume to be mounted over it, and creating
# it here rather than at boot keeps the entrypoint's `mkdir` from being the
# thing that papers over a missing one.
RUN mkdir -p /data

# Fail the BUILD, not the first user request, if the engine is not wired up.
# This runs the application's own preflight rather than a hand-written subset,
# so the build asserts exactly what the container will assert at boot: the
# interpreter, the checkpoint and the BERT directory, both weight files past a
# size floor that catches a truncated download, ffmpeg on PATH, and the
# torch/transformers pins. Storage is excluded — the volume is a runtime fact
# and /data is empty here.
#
# version() reports "<name>/<bytes>", which is how a run records which weights
# produced a count; printing it puts that identity in the build log.
# SEALV_REQUIRE_VOLUME is blanked for this one command. `probe_writes=False`
# skips the write probe but NOT the mount-point assertion, which is gated
# separately by that variable - and a mount point cannot exist during a build,
# only at `docker run`. Left set, this check fails every build with a message
# about an unattached volume, which is true and irrelevant here. The runtime
# entrypoint still asserts it, which is where the answer is meaningful.
RUN SEALV_REQUIRE_VOLUME= python -c "\
from service import preflight; \
from la_studio import countgd_engine as e; \
p = preflight.check(probe_writes=False); \
assert not p, 'image is not deployable: ' + '; '.join(x.what for x in p); \
print('countgd weights:', e.version())"

# ------------------------------------------------------------------ entrypoint
# The supervisor lives in docker-entrypoint.sh rather than inline here, because
# it is real logic with real failure modes (boot preflight, N workers, a
# SIGTERM escalation ladder) and it deserves to be readable and testable on its
# own. It is copied into /app deliberately: the script locates the app by
# looking for service/api.py next to itself, so /app makes that resolution
# exact rather than dependent on the working directory.
#
# Its preflight runs the same service.preflight checks the build asserted above,
# plus the volume probe that only means anything at runtime -- so a mis-wired
# image refuses to boot instead of accepting uploads it can never process.
COPY --chmod=755 docker-entrypoint.sh /app/docker-entrypoint.sh

# Informational only — Railway publishes $PORT, which may differ.
EXPOSE 8090

# /healthz returns 503 when the database is unreachable, which is the failure
# this is worth catching. curl is not in the slim image and is not worth adding
# for one probe. start-period covers first-boot schema creation on a cold
# volume; inference happens in job subprocesses and never blocks the event loop.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8090')+'/healthz', timeout=5)" || exit 1

# Runs as root deliberately: Railway attaches volumes owned by root, and a
# non-root UID could not write the database on first boot. The entrypoint's
# writability probe reports that condition explicitly if it ever changes.
#
# No CMD: the entrypoint takes no arguments and is configured entirely through
# the environment ($PORT, $WORKER_CONCURRENCY, $SEALV_DATA_DIR).
ENTRYPOINT ["/app/docker-entrypoint.sh"]
