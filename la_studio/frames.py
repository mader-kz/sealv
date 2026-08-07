"""Video probing and frame extraction via ffmpeg."""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")


class FFmpegMissing(RuntimeError):
    pass


@dataclass
class VideoInfo:
    duration: float
    width: int
    height: int
    fps: float


def _require() -> None:
    if not FFMPEG or not FFPROBE:
        raise FFmpegMissing(
            "ffmpeg/ffprobe not found on PATH - install with: brew install ffmpeg"
        )


def probe(path: Path) -> VideoInfo:
    _require()
    proc = subprocess.run(
        [
            FFPROBE, "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height,r_frame_rate",
            "-show_entries", "format=duration",
            "-of", "json", str(path),
        ],
        capture_output=True, text=True, check=True,
    )
    data = json.loads(proc.stdout)
    stream = (data.get("streams") or [{}])[0]

    num, _, den = (stream.get("r_frame_rate") or "0/1").partition("/")
    try:
        fps = float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        fps = 0.0

    return VideoInfo(
        duration=float(data.get("format", {}).get("duration") or 0.0),
        width=int(stream.get("width") or 0),
        height=int(stream.get("height") or 0),
        fps=fps,
    )


def extract(
    path: Path,
    out_dir: Path,
    every: float,
    start: float = 0.0,
    end: float | None = None,
    max_frames: int = 240,
    long_edge: int = 2048,
) -> list[dict]:
    """Sample one frame every `every` seconds into `out_dir`.

    Returns a list of {index, t, file} in timestamp order. Frames are capped at
    `long_edge` on the long side - the model supports up to 2.5K, and throwing
    resolution away here is exactly what breaks small-target detection later,
    since tiled inference crops from these files.
    """
    _require()
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("frame_*.jpg"):
        stale.unlink()

    every = max(0.05, float(every))
    cmd = [FFMPEG, "-v", "error", "-y"]
    if start > 0:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", str(path)]
    if end is not None and end > start:
        cmd += ["-t", f"{end - start:.3f}"]

    scale = (
        f"scale='if(gt(iw,ih),min({long_edge},iw),-2)':"
        f"'if(gt(iw,ih),-2,min({long_edge},ih))'"
    )
    cmd += [
        "-vf", f"fps=1/{every},{scale}",
        "-frames:v", str(max_frames),
        "-q:v", "3",
        str(out_dir / "frame_%05d.jpg"),
    ]
    subprocess.run(cmd, capture_output=True, text=True, check=True)

    frames = []
    for i, f in enumerate(sorted(out_dir.glob("frame_*.jpg"))):
        frames.append({"index": i, "t": round(start + i * every, 3), "file": f.name})
    return frames
