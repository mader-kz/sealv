"""CountGD engine - runs in its own interpreter, called as a subprocess.

CountGD needs torch 2.2.1 + transformers 4.39.1; the LocateAnything path needs
MLX and transformers 5.x. Those cannot share a process, so this shells out to
`.venv-countgd`. Model load there is ~0.7s, which is cheap enough that a
process per request beats the complexity of a persistent sidecar.

Measured against LocateAnything on the same 1698x1082 aerial still, same
hand-verified empty ground:

    LocateAnything 400px tiles   248 found   0 false positives   67.0s
    CountGD        400px tiles   329 found   0 false positives   18.7s
    CountGD        whole frame   389 found   -                    2.2s

Same precision, ~33% more animals, and it does not need tiling at all.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _env_path(name: str) -> "Path | None":
    """An environment override, with unset and blank treated alike.

    A declared-but-empty variable arrives as "", and `Path("")` is `Path(".")` -
    a silently wrong answer that would look like deliberate configuration.
    """
    raw = (os.environ.get(name) or "").strip()
    return Path(raw).expanduser() if raw else None


REPO = _env_path("COUNTGD_REPO") or ROOT / "vendor/CountGD"


def _interpreter() -> Path:
    """The python that has torch 2.2.1 + transformers 4.39.1.

    On a dev box those pins live in a side venv, because the LocateAnything path
    in this same tree needs transformers 5.x and the two cannot share a process.
    A container has no such conflict: one image, one interpreter, the CountGD
    pins installed straight into it - and no `.venv-countgd` anywhere.

    Treating that venv as a requirement rather than a preference is what broke
    containerised runs: `available()` returned False forever, so every job died
    on "CountGD not installed" while the weights sat right there in the image.
    So the venv is used when it exists, and `sys.executable` - the interpreter
    already running this code, which in the container is the one that has the
    pins - is the fallback. $COUNTGD_PYTHON overrides both.
    """
    override = _env_path("COUNTGD_PYTHON")
    if override is not None:
        return override
    venv = ROOT / ".venv-countgd" / "bin" / "python"
    return venv if venv.is_file() else Path(sys.executable)


PYTHON = _interpreter()

WORKER = r'''
import sys, json, torch
from pathlib import Path
from PIL import Image
REPO = Path(sys.argv[1]); sys.path.insert(0, str(REPO))
import datasets_inference.transforms as T
from util.slconfig import SLConfig

img_path, text, thresh = sys.argv[2], sys.argv[3], float(sys.argv[4])

class A: pass
args = A()
cfg = SLConfig.fromfile(str(REPO / "config/cfg_fsc147_vit_b.py"))
cfg.merge_from_dict({"text_encoder_type": str(REPO / "checkpoints/bert-base-uncased")})
for k, v in cfg._cfg_dict.to_dict().items(): setattr(args, k, v)
args.device = "cpu"
for k, v in dict(options=None, remove_difficult=False, fix_size=False, note="", resume="",
    pretrain_model_path="", image_path="", output_image_name="", text="",
    confidence_thresh=thresh, finetune_ignore=None, start_epoch=0, eval=True,
    num_workers=0, test=False, debug=False, find_unused_params=False,
    save_results=False, save_log=False, world_size=1, dist_url="env://", rank=0,
    local_rank=0, amp=False, distributed=False).items():
    if not hasattr(args, k): setattr(args, k, v)

from models.registry import MODULE_BUILD_FUNCS
model, _, _ = MODULE_BUILD_FUNCS.get(args.modelname)(args)
model.load_state_dict(
    torch.load(REPO / "checkpoints/checkpoint_best_regular.pth", map_location="cpu")["model"],
    strict=False)
model.eval()

tr = T.Compose([T.RandomResize([800], max_size=1333),
                T.Compose([T.ToTensor(),
                           T.Normalize([0.485,0.456,0.406],[0.229,0.224,0.225])])])
full = Image.open(img_path).convert("RGB")
W, H = full.size
im, tgt = tr(full, {"exemplars": torch.tensor([])})
with torch.no_grad():
    out = model(im.unsqueeze(0), [tgt["exemplars"]], [torch.tensor([0])],
                captions=[text + " ."])
lg = out["pred_logits"][0].sigmoid(); bx = out["pred_boxes"][0]
keep = lg.max(dim=-1).values > thresh
b = bx[keep].numpy(); s = lg[keep].max(dim=-1).values.numpy()
dets = []
for q, sc in zip(b, s):
    x, y = float(q[0]) * W, float(q[1]) * H
    dets.append({"label": text, "kind": "point", "score": float(sc),
                 "x1": x, "y1": y, "x2": x, "y2": y,
                 "nx1": x/W, "ny1": y/H, "nx2": x/W, "ny2": y/H})
print("__RESULT__" + json.dumps({"detections": dets, "width": W, "height": H}))
'''


CHECKPOINT = REPO / "checkpoints/checkpoint_best_regular.pth"

# The text encoder, as a local directory. WORKER hands this to CountGD as
# `text_encoder_type`, which transformers resolves as a path rather than as a hub
# id - so inference never reaches for the network, and an offline box or a
# container with no egress counts exactly like a connected one.
BERT_DIR = REPO / "checkpoints/bert-base-uncased"


def available() -> bool:
    """Can this box actually run CountGD?

    All three parts, not just the checkpoint. The text encoder is loaded in the
    same breath as the weights, so leaving it out of the answer only moves the
    failure from a clear False into a transformers stack trace inside a job.
    """
    return PYTHON.is_file() and CHECKPOINT.is_file() and BERT_DIR.is_dir()


# Resolved once per process: the weights do not change under a running worker,
# and stat()-ing them per frame would be noise on a hot path. `_UNRESOLVED` is a
# module-level sentinel because None is a real answer here - "the checkpoint is
# missing" has to cache as firmly as a version string does.
_UNRESOLVED = object()
_VERSION: "str | None | object" = _UNRESOLVED


def version() -> "str | None":
    """Which engine produced a count, in a form someone can check later.

    CountGD is vendored rather than installed, so there is no package version to
    read and no upstream version string anywhere in the tree. What actually
    decides the numbers is the checkpoint, so that is what gets reported: its
    name and exact size in bytes - the identity of the weights on disk.

    Returns None - never a placeholder - when the checkpoint is absent. A run
    that cannot say which weights it used should say so, because a made-up
    version is worse than a missing one for anyone trying to reproduce a count.
    """
    global _VERSION
    if _VERSION is not _UNRESOLVED:
        return _VERSION  # type: ignore[return-value]
    try:
        _VERSION = f"{CHECKPOINT.name}/{CHECKPOINT.stat().st_size}"
    except OSError:
        _VERSION = None
    return _VERSION  # type: ignore[return-value]


# ------------------------------------------------------------------- remote
#
# Modal runs the same model on a GPU and scales to zero between sorties, which
# suits a workload that is idle for days and then busy for minutes. It is opt-in
# via $TULEN_MODAL_APP so a dev box keeps working with no network and no account.
#
# The local path is a subprocess because torch 2.2.1 cannot share an interpreter
# with the transformers 5.x the rest of the tree needs. Swapping that process
# boundary for a network one changes the transport, not the contract - both
# return the identical dict, so nothing downstream knows which ran.

MODAL_APP = (os.environ.get("TULEN_MODAL_APP") or "").strip()


def remote_enabled() -> bool:
    return bool(MODAL_APP)


def _modal_cls():
    """Resolve the deployed class. Cached by modal itself, so this is cheap."""
    import modal

    return modal.Cls.from_name(MODAL_APP, "CountGD")()


def detect_many(images: list[Path], prompt: str = "seal",
                threshold: float = 0.23, timeout: int = 1800) -> list[dict]:
    """Detect over several images, remotely in one visit when Modal is on.

    Batching is the whole reason this exists. A tiled sortie is 60+ crops; sent
    one at a time the scheduling overhead costs more than the inference, and on
    a per-second biller that is the difference between pennies and pounds.
    Locally there is no such penalty, so it just loops.
    """
    if remote_enabled():
        payloads = [Path(p).read_bytes() for p in images]
        return _modal_cls().detect_batch.remote(payloads, prompt, threshold)
    return [detect(p, prompt, threshold, timeout=timeout) for p in images]


def detect(image: Path, prompt: str = "seal", threshold: float = 0.23,
           timeout: int = 600) -> dict:
    """Run CountGD on one image. Returns the same shape as the MLX worker."""
    if remote_enabled():
        return _modal_cls().detect_one.remote(
            Path(image).read_bytes(), prompt, threshold)
    if not available():
        # Name the piece that is actually missing. "CountGD not installed" sent
        # whoever read it to check the interpreter when the real answer was a
        # 1.2GB download that never landed in the image.
        missing = [
            what for what, ok in (
                (f"interpreter {PYTHON}", PYTHON.is_file()),
                (f"checkpoint {CHECKPOINT}", CHECKPOINT.is_file()),
                (f"text encoder {BERT_DIR}", BERT_DIR.is_dir()),
            ) if not ok
        ]
        raise RuntimeError("CountGD cannot run - missing: " + ", ".join(missing))
    proc = subprocess.run(
        # The image path is made absolute here because the child is free to run
        # with a different working directory than the caller assumed, and a
        # relative path that resolves in one and not the other fails as "no
        # result" several layers away from the cause.
        [str(PYTHON), "-c", WORKER, str(REPO), str(Path(image).resolve()),
         prompt, str(threshold)],
        capture_output=True, text=True, timeout=timeout,
    )
    for line in proc.stdout.splitlines():
        if line.startswith("__RESULT__"):
            return json.loads(line[len("__RESULT__"):])
    raise RuntimeError(f"CountGD produced no result: {proc.stderr[-400:]}")
