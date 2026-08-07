"""Startup preflight: prove this process can run a job before it accepts one.

Every condition checked here has the same runtime signature - a job is queued,
claimed, spends a minute in ffmpeg or model load, and dies with a stack trace in
`job.error`. On a laptop that is a nuisance you notice on the first count. In a
container it is worse: the deploy comes up green, serves the UI, accepts
uploads, and then loses every count, with the reason in a worker log nobody is
tailing. The weights are ~1.6GB that cannot be committed (GitHub rejects files
over 100MB) and therefore have to be fetched at build time, so "the image built
but the model is not in it" is the single most likely way this deployment
breaks - and it breaks minutes after the deploy looked fine.

What gets checked follows the engine that is actually configured. The local
backend needs weights, a text encoder and the pinned torch in this container;
the Modal backend needs none of them and an image built for it ships none, so
demanding them would fail the very deployment that backend exists to enable.
ffmpeg and the volume are checked either way - frames are extracted here and
the survey archive lives here, whichever machine runs the model.

So the conditions are checked once, at process start, where the failure is still
attached to the deploy that caused it. Fatal means fatal: the banner goes to
stderr and the process refuses to start. On a platform that health-checks a
rollout, refusing to start is what fails the rollout and leaves the previous
working release serving - the correct outcome for an image that cannot count.

`SEALV_PREFLIGHT=warn` downgrades fatal to logged. It exists for one situation:
storage or ffmpeg is broken and an operator needs the read-only half of the UI
(past runs, past counts, the archive) while they fix it. The banner prints on
every start either way, so nothing is ever silently degraded.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

# la_studio/ sits one level up from service/. This module is imported by both
# entry points - by the API before it has touched sys.path, and by the worker
# before `detect` runs its own copy of this guard - so the guard is repeated
# here rather than assumed. It keeps preflight importable however the process
# was started (uvicorn from the repo root, `python -m service.worker`, or a
# working directory that is neither).
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from la_studio import countgd_engine  # noqa: E402
from la_studio import frames as frames_mod  # noqa: E402

from . import db  # noqa: E402

DEFAULT_WORKSPACE = Path.home() / ".sealv" / "workspace"

# A truncated download and a git-lfs pointer file both leave something on disk
# that `is_file()` is perfectly happy with: a few hundred bytes where 1.2GB was
# expected. torch.load only finds out minutes later, inside a job, as an
# unpickling error nobody outside this repo can act on. Both real weight files
# are past 400MB, so a floor at 100MB cleanly separates "present" from "a stub".
_MIN_WEIGHT_BYTES = 100 * 1024 * 1024

# What transformers actually opens in a local BERT directory. The onnx / flax /
# rust variants carried by the upstream repo are 1.4GB this service never loads,
# so their absence is not a problem and must not be reported as one.
_BERT_FILES = (
    "config.json",
    "model.safetensors",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.txt",
)

# The pins CountGD's vendored GroundingDINO fork was measured against. Newer
# releases import cleanly and then behave differently, which is the worst shape
# a version problem can take, so drift refuses the start - see `_check_pins` for
# why that is worth more than a logged warning.
#
# Compared without the PEP 440 local segment, so the "+cpu" wheels this image is
# built from satisfy "2.2.1".
_PINS = {"torch": "2.2.1", "transformers": "4.39.1"}


@dataclass(frozen=True)
class Problem:
    """One reason this process cannot count, and the one thing to do about it."""

    what: str
    fix: str


# --------------------------------------------------------------------- paths

def _env_path(name: str) -> Optional[Path]:
    """A path from the environment, with unset and blank treated alike.

    Railway - and `docker run -e VAR=` - hand a declared-but-empty variable
    through as "", and `Path("")` is `Path(".")`: the container's working
    directory, which lives in the image and not on the volume. Silently writing
    the survey archive somewhere that vanishes on the next deploy is the worst
    outcome this file can allow, so blank is treated as unset rather than as a
    relative path.
    """
    raw = (os.environ.get(name) or "").strip()
    return Path(raw).expanduser() if raw else None


def workspace_path() -> Path:
    """Where uploaded media, extracted frames and tile crops live.

    Made absolute here rather than left as given: `media.path` is stored in the
    database as a plain string and later checked back against this directory
    with `Path.relative_to`. A relative workspace would bake the API process's
    working directory into every stored path, and both the containment check and
    the file-serving routes would start missing the moment anything ran from
    somewhere else - the worker, a shell, a one-off script.
    """
    return (_env_path("SEALV_WORKSPACE") or DEFAULT_WORKSPACE).resolve()


# -------------------------------------------------------------------- checks

def _mb(n: int) -> str:
    return f"{n / (1024 * 1024):.1f}MB"


def _check_remote_engine(problems: list[Problem]) -> None:
    """The remote backend's equivalent of "are the weights here".

    Modal holds the weights and the pinned torch on its side, so all this image
    needs is the client - and `import modal` happens lazily, inside the first
    detection. Without this check a deploy configured for Modal but built
    without the client looks perfect until the first job dies on ImportError.
    """
    from importlib.util import find_spec

    if find_spec("modal") is None:
        problems.append(Problem(
            f"$SEALV_MODAL_APP is set to {countgd_engine.MODAL_APP!r} but the "
            "modal client is not installed",
            "pip install modal, or unset $SEALV_MODAL_APP to run the model in "
            "this container (which then needs the ~1.6GB of local weights)",
        ))


def _check_engine(problems: list[Problem]) -> None:
    """The interpreter and the weights the local detector cannot start without."""
    python = countgd_engine.PYTHON
    if not python.is_file():
        problems.append(Problem(
            f"no python interpreter for CountGD at {python}",
            "unset $COUNTGD_PYTHON to fall back to the running interpreter, or "
            "point it at one that has torch 2.2.1 + transformers 4.39.1",
        ))

    repo = countgd_engine.REPO
    if not repo.is_dir():
        # Everything below is relative to the repo, so there is nothing further
        # to say once it is missing - reporting five derived paths would bury
        # the one fact that matters.
        problems.append(Problem(
            f"CountGD source tree not found at {repo}",
            "ship vendor/CountGD in the image (it is a vendored clone, not a "
            "package), or point $COUNTGD_REPO at where it landed",
        ))
        return

    ckpt = countgd_engine.CHECKPOINT
    if not ckpt.is_file():
        problems.append(Problem(
            f"CountGD checkpoint missing at {ckpt}",
            "download checkpoint_best_regular.pth (~1.2GB) from the HF Space "
            'nikigoli/countgd (repo_type="space") during the image build - it '
            "is too large to commit",
        ))
    elif ckpt.stat().st_size < _MIN_WEIGHT_BYTES:
        problems.append(Problem(
            f"CountGD checkpoint at {ckpt} is only {_mb(ckpt.stat().st_size)} - "
            "expected ~1.2GB, so this is a stub, not the weights",
            "re-download it; a git-lfs pointer or an interrupted fetch leaves a "
            "file that exists and cannot be loaded",
        ))

    bert = countgd_engine.BERT_DIR
    if not bert.is_dir():
        problems.append(Problem(
            f"BERT text encoder missing at {bert}",
            "download google-bert/bert-base-uncased during the image build - "
            f"only these files are needed: {', '.join(_BERT_FILES)}",
        ))
        return

    missing = [name for name in _BERT_FILES if not (bert / name).is_file()]
    if missing:
        problems.append(Problem(
            f"BERT text encoder at {bert} is incomplete - missing "
            f"{', '.join(missing)}",
            "re-download those files from google-bert/bert-base-uncased",
        ))
    weights = bert / "model.safetensors"
    if weights.is_file() and weights.stat().st_size < _MIN_WEIGHT_BYTES:
        problems.append(Problem(
            f"BERT weights at {weights} are only {_mb(weights.stat().st_size)} - "
            "expected ~420MB",
            "re-download model.safetensors from google-bert/bert-base-uncased",
        ))


def _check_ffmpeg(problems: list[Problem]) -> None:
    """Video is half the product, and ffmpeg is how frames exist at all.

    Checked against the module constants rather than by calling `shutil.which`
    again, because those constants are resolved once at import and are what the
    extraction path will really use. Re-deriving the answer here could report a
    binary that the running process has already decided it does not have.
    """
    for name, found in (("ffmpeg", frames_mod.FFMPEG), ("ffprobe", frames_mod.FFPROBE)):
        if not found:
            problems.append(Problem(
                f"{name} not found on PATH",
                "install ffmpeg in the image (apt-get install -y ffmpeg); video "
                "uploads cannot be probed or sampled without it",
            ))


def _probe_write(where: Path, label: str, problems: list[Problem]) -> None:
    """Create the directory and prove a byte can be written into it.

    Existence is not the question. A volume that failed to mount leaves an empty
    directory in the image that accepts writes and loses them on redeploy, and a
    volume mounted read-only or owned by another uid looks identical to a
    working one until the first upload.
    """
    try:
        where.mkdir(parents=True, exist_ok=True)
        marker = where / f".sealv-preflight-{os.getpid()}"
        marker.write_bytes(b"")
        marker.unlink()
    except OSError as exc:
        problems.append(Problem(
            f"{label} {where} is not writable ({exc.strerror or exc})",
            "mount the persistent volume there and make sure the container user "
            "owns it - anything written outside it is lost on the next deploy",
        ))


def _check_volume(problems: list[Problem]) -> None:
    """Prove the persistent volume is mounted, where one is expected.

    This is the one storage failure `_probe_write` cannot see, and it is the
    expensive one. A platform volume that was never attached leaves an ordinary
    directory on the container's writable layer: `mkdir -p` creates it, the
    write probe passes, uploads succeed, runs are served back, /healthz says
    ok - and the entire survey archive is destroyed by the next deploy with
    nothing anywhere having reported a problem. Read-only and wrong-uid mounts
    announce themselves on the first write; a missing one never does.

    `$SEALV_REQUIRE_VOLUME` names the path that has to be a mount point. The
    Dockerfile sets it to /data, matching `deploy.requiredMountPath` in
    railway.json - which is a Railway-side declaration this process cannot
    verify, so it is restated here where it can be. Unset on a dev box, where
    ~/.sealv is a plain directory and the question is meaningless; blank unsets
    it again, for deliberately running the image with no volume attached.
    """
    required = _env_path("SEALV_REQUIRE_VOLUME")
    if required is None:
        return
    # ismount() compares st_dev with the parent's, which is what actually
    # separates a mount from a directory of the same name. Existence is not
    # evidence: the Dockerfile creates /data so the mount point is there to be
    # mounted over, so `is_dir()` is true either way.
    if not required.is_dir() or not os.path.ismount(required):
        problems.append(Problem(
            f"{required} exists but is not a mount point - the persistent "
            "volume is not attached, so every upload, run and count would be "
            "written to the container's own filesystem and lost on the next "
            "deploy",
            f"attach the volume with its mount path set to {required}, or set "
            "$SEALV_REQUIRE_VOLUME empty to accept ephemeral storage on purpose",
        ))


def _check_storage(problems: list[Problem], db_path: Optional[Path]) -> None:
    _probe_write(workspace_path(), "workspace", problems)
    # The database file itself may not exist yet on a fresh volume; its
    # directory is what has to be writable, and SQLite needs to create the -wal
    # and -shm sidecars beside it, not just the database.
    _probe_write((db_path or db.default_db_path()).parent, "database directory", problems)


def _check_pins(problems: list[Problem]) -> None:
    """Report version drift on the two libraries CountGD is pinned against.

    Only meaningful when CountGD runs in *this* interpreter, which is the
    container case: one image, one python. On a dev box the pins live in
    `.venv-countgd`, this process cannot see them, and asking would produce a
    confident wrong answer - so the question is not asked at all.

    Treated as fatal, like a missing weight file, because the failure it catches
    is worse than a missing weight file. CountGD's GroundingDINO is a fork, not
    a release: newer torch and transformers import cleanly, build the model
    without complaint, and then count differently. A count that is quietly wrong
    is the one outcome a survey tool must never ship, and it is invisible in
    every log - so a version this deployment was not measured against stops the
    process rather than producing numbers nobody can defend.
    """
    if countgd_engine.PYTHON != Path(sys.executable):
        return
    try:
        from importlib.metadata import PackageNotFoundError, version
    except ImportError:  # pragma: no cover - stdlib since 3.8
        return
    for package, pinned in _PINS.items():
        try:
            found = version(package)
        except PackageNotFoundError:
            problems.append(Problem(
                f"{package} is not installed in {sys.executable}",
                f"pip install {package}=={pinned} (CPU wheels: "
                "--index-url https://download.pytorch.org/whl/cpu)",
            ))
            continue
        # Compared without the PEP 440 local segment. The CPU wheels this image
        # is built from report "2.2.1+cpu" - and a CUDA build would say
        # "2.2.1+cu121" - where "+cpu" names the build variant, not the release:
        # the upstream source is the same 2.2.1 and cannot count differently.
        # Matching the raw string would reject the exact wheel the Dockerfile
        # installs, so a correctly-built image would refuse to boot. The full
        # string is still what gets reported, because which variant is installed
        # is the first thing worth knowing when this does fire.
        if found.split("+", 1)[0] != pinned:
            problems.append(Problem(
                f"{package} is {found}, not the pinned {pinned}",
                f"pin {package}=={pinned} - CountGD's vendored GroundingDINO "
                "fork imports fine on newer releases and then counts differently",
            ))


# --------------------------------------------------------------------- entry

def check(*, db_path: Optional[Path] = None, probe_writes: bool = True) -> list[Problem]:
    """Everything that would make a job fail, in the order it would fail in.

    `probe_writes=False` skips the two filesystem probes so /healthz can report
    the same picture without touching the disk on every health check. The mount
    check is not one of them - it is a stat, it costs nothing, and "this
    container is writing the archive somewhere that vanishes" is exactly the
    kind of thing that has to be answerable from outside the box.
    """
    problems: list[Problem] = []

    _check_volume(problems)

    # Which engine is configured decides which half of this is even a question.
    # An image built for the Modal backend ships neither the weights nor the
    # pinned torch on purpose, so demanding them here would fail exactly the
    # deployment that backend exists to enable. ffmpeg and storage are local
    # either way: frames are extracted in this container and the survey archive
    # lives on this volume.
    local_engine = not countgd_engine.remote_enabled()
    if local_engine:
        _check_engine(problems)
    else:
        _check_remote_engine(problems)

    _check_ffmpeg(problems)
    if probe_writes:
        _check_storage(problems, db_path)
    if local_engine:
        _check_pins(problems)
    return problems


def summary(*, db_path: Optional[Path] = None) -> dict:
    """Preflight as a payload, for /healthz.

    Same checks, no write probes, and the fixes are dropped: a health endpoint
    reports state, and the instructions belong in the startup banner where the
    person who can act on them is already reading.
    """
    problems = check(db_path=db_path, probe_writes=False)
    remote = countgd_engine.remote_enabled()
    return {
        "ok": not problems,
        # Named, because "weights: false" on a Modal deployment is correct and
        # would otherwise read as the fault it is not.
        "backend": "modal" if remote else "local",
        "weights": True if remote else countgd_engine.available(),
        "ffmpeg": bool(frames_mod.FFMPEG and frames_mod.FFPROBE),
        "problems": [p.what for p in problems],
    }


class PreflightError(RuntimeError):
    """Raised by `require` when this process cannot run detection jobs.

    A plain RuntimeError subclass, deliberately not SystemExit: it is raised
    inside a FastAPI lifespan, where uvicorn catches startup exceptions, logs
    "Application startup failed" and exits non-zero. A SystemExit would unwind
    through the event loop instead and turn a clear message into asyncio noise.
    """


def require(component: str, *, db_path: Optional[Path] = None) -> None:
    """Refuse to start a process that cannot do its job. Prints either way."""
    problems = check(db_path=db_path)
    if not problems:
        print(
            f"[preflight] {component}: engine, ffmpeg and storage all present",
            file=sys.stderr, flush=True,
        )
        return

    lenient = (os.environ.get("SEALV_PREFLIGHT") or "").strip().lower() == "warn"
    rule = "=" * 72
    lines = [
        "",
        rule,
        f"  PREFLIGHT {'WARNING' if lenient else 'FATAL'} - {component} cannot "
        "run detection jobs",
        rule,
    ]
    for i, problem in enumerate(problems, 1):
        lines.append(f"  {i}. {problem.what}")
        lines.append(f"     fix: {problem.fix}")
    lines.append(rule)
    if lenient:
        lines.append(
            "  SEALV_PREFLIGHT=warn is set, so this process is starting anyway. "
            "Jobs will fail."
        )
    else:
        lines.append(
            "  Set SEALV_PREFLIGHT=warn to start anyway (the UI will serve past "
            "runs; new jobs will fail)."
        )
    lines.append("")
    print("\n".join(lines), file=sys.stderr, flush=True)

    if not lenient:
        raise PreflightError(
            f"{component}: {len(problems)} preflight problem(s) - "
            + "; ".join(p.what for p in problems)
        )
