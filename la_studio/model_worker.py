"""Single-process wrapper around LocateAnything-3B running on MLX.

MLX generation is not safe to run concurrently from several threads, so every
call goes through one lock. FastAPI handlers hand work off with
`asyncio.to_thread`, keeping the event loop free while a frame is decoding.
"""

from __future__ import annotations

import inspect
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import boxes as boxes_mod
from . import degeneracy
from . import tiling

# 8-bit by default. Measured against the 4-bit build on aerial colony footage:
# malformed box-blocks in point mode fell from 681 to 2 on the same frame, no
# tiles were rejected as decoder drift, and it found ~13% more animals. The
# 4-bit conversion quantises the tied embed_tokens/lm_head, which is exactly
# what degrades coordinate-token precision. Costs 4.14 GB vs 2.96 GB.
DEFAULT_MODEL = os.environ.get("LA_MODEL", "mlx-community/LocateAnything-3B-8bit")


def _point_radius(width: int, height: int) -> float:
    """Merge distance for point detections, scaled to the frame.

    ~1.2% of the long edge. Tight enough that neighbouring animals in a packed
    colony stay separate, loose enough to collapse the same animal reported by
    two overlapping tiles.
    """
    return max(6.0, 0.012 * max(width, height))


@dataclass
class LoadState:
    status: str = "idle"  # idle | loading | ready | error
    model_id: str = DEFAULT_MODEL
    detail: str = ""
    load_seconds: float = 0.0
    capabilities: dict = field(default_factory=dict)


class ModelWorker:
    def __init__(self, model_id: str = DEFAULT_MODEL) -> None:
        self.state = LoadState(model_id=model_id)
        self._lock = threading.Lock()
        self._load_lock = threading.Lock()
        self._model = None
        self._processor = None
        self._config = None
        self._generate = None
        self._apply_chat_template = None
        self._gen_params: set[str] = set()

    # ---------------------------------------------------------------- loading

    def ensure_loaded(self) -> None:
        if self.state.status == "ready":
            return
        with self._load_lock:
            if self.state.status == "ready":
                return
            if os.environ.get("LA_FAKE"):
                # UI development mode: no weights, synthetic boxes.
                self.state.status = "ready"
                self.state.model_id = "stub (LA_FAKE=1)"
                self.state.load_seconds = 0.0
                return
            self.state.status = "loading"
            self.state.detail = "importing mlx_vlm"
            started = time.perf_counter()
            try:
                from mlx_vlm import load, generate  # type: ignore
                from mlx_vlm.prompt_utils import apply_chat_template  # type: ignore
                from mlx_vlm.utils import load_config  # type: ignore

                self.state.detail = f"loading weights ({self.state.model_id})"
                self._model, self._processor = load(self.state.model_id)
                self._config = load_config(self.state.model_id)
                self._generate = generate
                self._apply_chat_template = apply_chat_template

                try:
                    sig = inspect.signature(generate)
                    self._gen_params = set(sig.parameters)
                    # mlx-vlm forwards tuning options through **kwargs rather
                    # than naming them, so a name-only probe finds nothing.
                    self._gen_varkw = any(
                        p.kind is inspect.Parameter.VAR_KEYWORD
                        for p in sig.parameters.values()
                    )
                except (TypeError, ValueError):
                    self._gen_params = set()
                    self._gen_varkw = True

                self.state.capabilities = {
                    "accepts_kwargs": self._gen_varkw,
                    "named": sorted(self._gen_params),
                }
                self.state.load_seconds = round(time.perf_counter() - started, 2)
                self.state.status = "ready"
                self.state.detail = ""
            except Exception as exc:  # surfaced verbatim in the UI
                self.state.status = "error"
                self.state.detail = f"{type(exc).__name__}: {exc}"
                raise

    # ------------------------------------------------------------- inference

    def _build_kwargs(
        self, max_tokens: int, temperature: float, generation_mode: str
    ) -> dict[str, Any]:
        kw: dict[str, Any] = {}
        p = self._gen_params
        free = getattr(self, "_gen_varkw", True)

        if "max_tokens" in p or free:
            kw["max_tokens"] = max_tokens
        elif "max_new_tokens" in p:
            kw["max_new_tokens"] = max_tokens

        if "temperature" in p or free:
            kw["temperature"] = temperature
        elif "temp" in p:
            kw["temp"] = temperature

        if generation_mode and ("generation_mode" in p or free):
            kw["generation_mode"] = generation_mode
        if "verbose" in p:
            kw["verbose"] = False
        return kw

    @staticmethod
    def _as_text(result: Any) -> str:
        for attr in ("text", "generated_text"):
            value = getattr(result, attr, None)
            if isinstance(value, str):
                return value
        if isinstance(result, tuple) and result:
            return ModelWorker._as_text(result[0])
        return result if isinstance(result, str) else str(result)

    def detect(
        self,
        image_path: Path,
        prompt: str,
        width: int,
        height: int,
        max_tokens: int = 1024,
        temperature: float = 0.0,
        generation_mode: str = "hybrid",
    ) -> dict:
        self.ensure_loaded()

        if os.environ.get("LA_FAKE"):
            return self._fake(image_path, prompt, width, height)

        with self._lock:
            started = time.perf_counter()
            formatted = self._apply_chat_template(
                self._processor, self._config, prompt, num_images=1
            )
            kwargs = self._build_kwargs(max_tokens, temperature, generation_mode)
            try:
                result = self._generate(
                    self._model, self._processor, formatted, [str(image_path)], **kwargs
                )
            except TypeError:
                # older signature: image passed by keyword, no mode support
                kwargs.pop("generation_mode", None)
                result = self._generate(
                    self._model,
                    self._processor,
                    formatted,
                    image=[str(image_path)],
                    **kwargs,
                )
            elapsed_ms = (time.perf_counter() - started) * 1000

        raw = self._as_text(result)
        dets = [d.as_dict() for d in boxes_mod.parse(raw, width, height)]

        # A point prompt should yield point blocks. Four-value box blocks mixed
        # into that stream are malformed output, not detections - on a frame
        # where decoding went wrong they arrived as 681 boxes alongside 658
        # points and doubled the reported count. Drop them, and say how many.
        malformed = 0
        if boxes_mod.is_point_prompt(prompt):
            kept = [d for d in dets if d["kind"] == "point"]
            malformed = len(dets) - len(kept)
            dets = kept

        return {
            "raw": raw,
            "text": boxes_mod.strip_markup(raw),
            "detections": dets,
            "malformed": malformed,
            "ms": round(elapsed_ms, 1),
        }


    # ------------------------------------------------------------ tiled run

    def detect_tiled(
        self,
        image_path: Path,
        prompt: str,
        width: int,
        height: int,
        grid_n: int,
        max_tokens: int = 2048,
        temperature: float = 0.0,
        generation_mode: str = "hybrid",
        scratch: Path | None = None,
        tile_px: int = 0,
        denoise: float = 0.0,
    ) -> dict:
        """Run the model over overlapping crops and merge the results.

        `tile_px` (source pixels per crop) is the meaningful control - see
        tiling.grid_by_size. `grid_n` is the older n x n form, kept working.

        Every tile's output is screened for decoder degeneracy before merging.
        A tile whose points march across it at a constant stride is drift, not
        detection, and merging it would inflate the count with invented targets.
        """
        if tile_px <= 0 and grid_n <= 1:
            res = self.detect(image_path, prompt, width, height,
                              max_tokens, temperature, generation_mode)
            res["detections"] = tiling.nms(
                tiling.drop_frame_sized(res["detections"], width, height),
                point_radius=_point_radius(width, height),
            )
            res["tiles"] = 1
            return res

        from PIL import Image

        scratch = scratch or image_path.parent / "_tiles"
        scratch.mkdir(parents=True, exist_ok=True)

        windows = (
            tiling.grid_by_size(width, height, tile_px)
            if tile_px > 0
            else tiling.grid(width, height, grid_n)
        )
        merged: list[dict] = []
        raws: list[str] = []
        rejected: list[str] = []
        malformed = 0
        started = time.perf_counter()

        with Image.open(image_path) as full:
            full = full.convert("RGB")
            for i, (x0, y0, x1, y1) in enumerate(windows):
                crop_path = scratch / f"{image_path.stem}_t{i}.jpg"
                crop = full.crop((x0, y0, x1, y1))
                # upscale small crops - the encoder sees more detail and the
                # model was trained well above this resolution
                cw, ch = crop.size
                if max(cw, ch) < 900:
                    scale = 900 / max(cw, ch)
                    crop = crop.resize((int(cw * scale), int(ch * scale)), Image.LANCZOS)
                if denoise > 0:
                    # Measured on aerial colony footage: a mild blur removes ~70%
                    # of false positives on ambiguous textured ground (wet sand,
                    # shingle) for ~13% of true detections. Sharpening does the
                    # reverse - +75% false positives for +4% real ones - because
                    # the spurious hits live in compression noise, not structure.
                    from PIL import ImageFilter
                    crop = crop.filter(ImageFilter.GaussianBlur(denoise))
                crop.save(crop_path, quality=92)

                res = self.detect(crop_path, prompt, x1 - x0, y1 - y0,
                                  max_tokens, temperature, generation_mode)
                raws.append(f"[tile {i}] {res['raw']}")
                local = tiling.drop_frame_sized(res["detections"], x1 - x0, y1 - y0)

                malformed += res.get("malformed", 0)

                verdict = degeneracy.analyse(local, x1 - x0, y1 - y0)
                if verdict["suspect"]:
                    rejected.append(f"tile {i}: {verdict['reasons'][0]}")
                    crop_path.unlink(missing_ok=True)
                    continue

                merged.extend(tiling.offset(local, x0, y0, width, height))
                crop_path.unlink(missing_ok=True)

        final = tiling.nms(
            tiling.drop_frame_sized(merged, width, height),
            point_radius=_point_radius(width, height),
        )
        note = f"{len(final)} detections across {len(windows)} tiles"
        if rejected:
            note += f" — {len(rejected)} tile(s) rejected as decoder drift"
        if malformed:
            note += f" — {malformed} malformed block(s) dropped"
        return {
            "raw": "\n".join(raws),
            "text": note,
            "detections": final,
            "ms": round((time.perf_counter() - started) * 1000, 1),
            "tiles": len(windows),
            "pre_nms": len(merged),
            "rejected_tiles": rejected,
            "malformed": malformed,
        }

    # ------------------------------------------------------------- dev stub

    def _fake(self, image_path: Path, prompt: str, width: int, height: int) -> dict:
        """Deterministic synthetic output, shaped exactly like the real thing."""
        import hashlib
        import random

        seed = int(hashlib.sha1(f"{image_path}{prompt}".encode()).hexdigest()[:8], 16)
        rng = random.Random(seed)
        labels = [p.strip() for p in prompt.split("</c>") if p.strip()] or ["object"]
        if len(labels) == 1 and len(labels[0].split()) > 3:
            labels = ["person", "phone", "table"]

        parts = []
        for _ in range(rng.randint(2, 5)):
            x1 = rng.randint(0, 700)
            y1 = rng.randint(0, 700)
            parts.append(
                f"<ref>{rng.choice(labels)}</ref>"
                f"<box><{x1}><{y1}><{x1 + rng.randint(80, 280)}><{y1 + rng.randint(80, 280)}></box>"
            )
        raw = "".join(parts)
        time.sleep(0.25)
        dets = boxes_mod.parse(raw, width, height)
        return {
            "raw": raw,
            "text": boxes_mod.strip_markup(raw),
            "detections": [d.as_dict() for d in dets],
            "ms": 250.0,
        }


WORKER = ModelWorker()
