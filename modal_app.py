"""CountGD inference on Modal — GPU, scale-to-zero, weights in a Volume.

Why this exists
---------------
The counting workload is bursty: a survey flight produces a few minutes of work,
then nothing for days. An always-on container holding 1.6 GB of weights in RAM
costs money every one of those idle days; Modal bills per second of actual
compute and scales to zero between sorties.

Split of responsibility:

    Tulen API + worker + SQLite   -> a small always-on host (Railway, Fly, a VM)
    CountGD inference             -> here, on a GPU, only while a job is running

That split is free because `la_studio/countgd_engine.py` already runs CountGD in
a separate *process* — torch 2.2.1 could never share an interpreter with the
transformers 5.x that the rest of the tree uses. Replacing a subprocess boundary
with a network boundary changes the transport, not the design.

Two things dominate cost, and both are handled here rather than left to chance:

1. **Cold start**, not inference. Loading the checkpoint is seconds; the actual
   forward pass is a fraction of one. The weights therefore live in a Volume
   (not re-pulled per container) and the model is loaded once per container in
   `@modal.enter()`, not once per call.
2. **Per-call overhead.** A tiled sortie is 60+ inferences. Sixty round trips
   would spend most of the money on scheduling, so `detect_batch` takes a list
   of images and runs them in one container visit. Callers should batch.

Deploy:   modal deploy modal_app.py
Weights:  modal run modal_app.py::fetch_weights      (once, ~1.6 GB)
Smoke:    modal run modal_app.py::smoke --image-path some.jpg
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import modal

APP_NAME = "tulen-countgd"

# T4 is deliberate. CountGD is a Swin-B GroundingDINO derivative; it does not
# need an A10G, which costs ~1.9x for no useful gain at this model size.
# Override with TULEN_GPU if a sortie ever proves otherwise - and measure first.
GPU = os.environ.get("TULEN_GPU", "T4")

WEIGHTS_DIR = "/weights"
REPO_DIR = "/root/CountGD"

# Weights are a Volume, not image layers: an image rebuild would otherwise
# re-download 1.6 GB, and Volumes are $0.09/GiB-month with the first TiB free.
weights = modal.Volume.from_name("tulen-countgd-weights", create_if_missing=True)

# torch 2.2.1 / transformers 4.39.1 are hard pins - CountGD vendors a
# GroundingDINO fork that newer versions break. See docs/DEPLOY.md.
image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("libgl1", "libglib2.0-0")
    .pip_install(
        "torch==2.2.1", "torchvision==0.17.1",
        extra_index_url="https://download.pytorch.org/whl/cu121",
    )
    .pip_install(
        "transformers==4.39.1", "numpy==1.26.4", "timm", "addict", "yapf",
        "opencv-python-headless", "pycocotools", "scipy", "termcolor",
        "colorlog", "pyyaml", "safetensors", "matplotlib", "pillow",
        "huggingface_hub", "hf_transfer",
    )
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1"})
    # The vendored CountGD source, without its checkpoints - those are the
    # Volume's job. Sending them in the build context would upload 1.6 GB per
    # deploy for nothing.
    .add_local_dir(
        Path(__file__).parent / "vendor/CountGD",
        REPO_DIR,
        ignore=["checkpoints/**", "**/__pycache__/**", "*.pyc", "data/**", "img/**"],
        copy=True,
    )
)

app = modal.App(APP_NAME, image=image)


@app.function(volumes={WEIGHTS_DIR: weights}, timeout=3600)
def fetch_weights() -> dict:
    """Populate the weights Volume. Run once; re-running is a cheap no-op.

    Only the files inference actually opens are fetched. bert-base-uncased ships
    onnx/flax/rust copies of the same model that PyTorch never reads - 1.4 GB of
    download and storage for nothing.
    """
    from huggingface_hub import hf_hub_download

    root = Path(WEIGHTS_DIR)
    (root / "bert-base-uncased").mkdir(parents=True, exist_ok=True)
    got = {}

    ckpt = root / "checkpoint_best_regular.pth"
    if not ckpt.exists():
        src = hf_hub_download("nikigoli/countgd", "checkpoint_best_regular.pth",
                              repo_type="space")
        ckpt.write_bytes(Path(src).read_bytes())
    got["checkpoint"] = ckpt.stat().st_size

    for name in ("config.json", "model.safetensors", "tokenizer.json",
                 "tokenizer_config.json", "vocab.txt"):
        dst = root / "bert-base-uncased" / name
        if not dst.exists():
            src = hf_hub_download("google-bert/bert-base-uncased", name)
            dst.write_bytes(Path(src).read_bytes())
        got[name] = dst.stat().st_size

    weights.commit()
    return got


@app.cls(
    gpu=GPU,
    volumes={WEIGHTS_DIR: weights},
    # Idle containers are the thing that quietly spends money. 60s keeps a
    # container alive across the tiles of one sortie without paying to idle
    # between sorties; raise it only if measurement shows cold starts hurting.
    scaledown_window=60,
    timeout=1800,
)
class CountGD:
    @modal.enter()
    def load(self) -> None:
        """Load once per container, not once per call.

        This is the expensive step - the whole point of batching is to amortise
        it. `@modal.enter()` runs on container start, so a batch of 60 tiles
        pays it once.
        """
        import sys
        import torch

        sys.path.insert(0, REPO_DIR)
        import datasets_inference.transforms as T  # noqa: E402
        from util.slconfig import SLConfig  # noqa: E402

        self.device = "cuda" if torch.cuda.is_available() else "cpu"

        class A:
            pass

        args = A()
        cfg = SLConfig.fromfile(f"{REPO_DIR}/config/cfg_fsc147_vit_b.py")
        cfg.merge_from_dict(
            {"text_encoder_type": f"{WEIGHTS_DIR}/bert-base-uncased"})
        for k, v in cfg._cfg_dict.to_dict().items():
            setattr(args, k, v)
        args.device = self.device
        for k, v in dict(
            options=None, remove_difficult=False, fix_size=False, note="",
            resume="", pretrain_model_path="", image_path="",
            output_image_name="", text="", confidence_thresh=0.23,
            finetune_ignore=None, start_epoch=0, eval=True, num_workers=0,
            test=False, debug=False, find_unused_params=False,
            save_results=False, save_log=False, world_size=1,
            dist_url="env://", rank=0, local_rank=0, amp=False,
            distributed=False,
        ).items():
            if not hasattr(args, k):
                setattr(args, k, v)

        from models.registry import MODULE_BUILD_FUNCS  # noqa: E402

        model, _, _ = MODULE_BUILD_FUNCS.get(args.modelname)(args)
        state = torch.load(f"{WEIGHTS_DIR}/checkpoint_best_regular.pth",
                           map_location="cpu")["model"]
        model.load_state_dict(state, strict=False)
        self.model = model.to(self.device).eval()
        self.torch = torch

        self.tr = T.Compose([
            T.RandomResize([800], max_size=1333),
            T.Compose([T.ToTensor(),
                       T.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])]),
        ])
        # Reported back with every result so a count can be traced to the exact
        # weights that produced it, the same identity the local engine reports.
        size = Path(f"{WEIGHTS_DIR}/checkpoint_best_regular.pth").stat().st_size
        self.version = f"checkpoint_best_regular.pth/{size}"

    def _one(self, payload: bytes, prompt: str, threshold: float) -> dict:
        import io

        from PIL import Image

        torch = self.torch
        full = Image.open(io.BytesIO(payload)).convert("RGB")
        W, H = full.size
        im, tgt = self.tr(full, {"exemplars": torch.tensor([])})
        with torch.no_grad():
            out = self.model(
                im.unsqueeze(0).to(self.device),
                [tgt["exemplars"].to(self.device)],
                [torch.tensor([0]).to(self.device)],
                captions=[prompt + " ."],
            )
        lg = out["pred_logits"][0].sigmoid()
        bx = out["pred_boxes"][0]
        keep = lg.max(dim=-1).values > threshold
        boxes = bx[keep].cpu().numpy()
        scores = lg[keep].max(dim=-1).values.cpu().numpy()

        dets = []
        for q, sc in zip(boxes, scores):
            x, y = float(q[0]) * W, float(q[1]) * H
            dets.append({
                "label": prompt, "kind": "point", "score": float(sc),
                "x1": x, "y1": y, "x2": x, "y2": y,
                "nx1": x / W, "ny1": y / H, "nx2": x / W, "ny2": y / H,
            })
        return {"detections": dets, "width": W, "height": H}

    @modal.method()
    def detect_batch(self, images: list[bytes], prompt: str = "seal",
                     threshold: float = 0.23) -> list[dict]:
        """One container visit for many images. Order matches the input.

        A tiled sortie is 60+ crops; sending them one at a time would spend most
        of the budget on scheduling rather than inference.
        """
        return [self._one(b, prompt, threshold) for b in images]

    @modal.method()
    def detect_one(self, payload: bytes, prompt: str = "seal",
                   threshold: float = 0.23) -> dict:
        return self._one(payload, prompt, threshold)

    @modal.method()
    def info(self) -> dict:
        return {"device": self.device, "gpu": GPU, "version": self.version}


@app.local_entrypoint()
def smoke(image_path: str = "", prompt: str = "seal") -> None:
    """Time a real image end to end, so the GPU speedup is measured not assumed."""
    import time

    engine = CountGD()
    print("engine:", engine.info.remote())
    if not image_path:
        print("pass --image-path to run a detection")
        return

    payload = Path(image_path).read_bytes()
    t0 = time.time()
    first = engine.detect_one.remote(payload, prompt)
    print(f"cold-ish single: {len(first['detections'])} detections "
          f"in {time.time() - t0:.1f}s wall")

    t0 = time.time()
    warm = engine.detect_batch.remote([payload] * 8, prompt)
    dt = time.time() - t0
    print(f"warm batch of 8: {sum(len(r['detections']) for r in warm)} detections "
          f"in {dt:.1f}s wall ({dt / 8:.2f}s per image)")
