"use client";
/**
 * frames.ts — one frame per second out of a video, in the browser, with no
 * dependencies.
 *
 * This exists so an operator can SEE what is in a clip before committing to a
 * count, and so the "quick count" path has a real image to send: a JPEG the
 * browser drew from the video, not a server-side re-encode nobody watched.
 *
 * Two resolutions on purpose. `dataUrl` is a small preview (a 12-thumbnail
 * strip of a 4K clip must not cost 24 MB of base64), and `toBlob()` re-seeks
 * the source file to draw the SAME instant at full sensor resolution. The
 * count runs on the full-resolution frame; a downscaled one would silently
 * change the ground sample distance under every animal.
 *
 * Nothing here reports a failure as a picture. A codec the browser cannot
 * decode, or a seek that never fires `seeked`, returns a machine-readable
 * reason and whatever frames were extracted before it — the caller falls back
 * to full analysis rather than showing an empty strip that looks like an empty
 * video. Every object URL minted here is revoked on every exit path.
 */

import type { TrackPoint } from "@/lib/types";

/** Longer clips are sampled rather than exhausted: 12 evenly-spaced frames. */
export const MAX_FRAMES = 12;

/** Preview width in CSS pixels. The strip is thumbnails, not evidence. */
const PREVIEW_WIDTH = 320;
/** JPEG quality: 0.7 for the previews, 0.92 for the frame that gets counted. */
const PREVIEW_QUALITY = 0.7;
const EXPORT_QUALITY = 0.92;

/** A seek that never lands must not hang the picker. */
const SEEK_TIMEOUT_MS = 6000;
const METADATA_TIMEOUT_MS = 8000;

/** Why extraction stopped. A key, not a sentence — the UI says it in the
 *  operator's language, the same discipline `validateTrackInCaspian` uses. */
export type FrameErrorCode =
  | "no_metadata"
  | "no_duration"
  | "seek_timeout"
  | "draw_failed"
  | "no_frames";

export type ExtractedFrame = {
  /** Position in the clip, seconds from its start. */
  atSeconds: number;
  /** Small JPEG preview as a `data:` URL — nothing to revoke. */
  dataUrl: string;
  /** The same instant at the video's native resolution, as a JPEG blob.
   *  Re-opens the file and seeks again: the preview is not the evidence. */
  toBlob: () => Promise<Blob>;
};

export type FrameExtraction = {
  frames: ExtractedFrame[];
  /** Playback duration in seconds, as the browser decoded it. */
  duration: number;
  /** True when the clip was longer than {@link MAX_FRAMES} seconds and the
   *  frames are a SAMPLE spread across it rather than one per second. The
   *  picker says so — "12 frames" over a three-minute clip is not the clip. */
  evenlySpaced: boolean;
  /** Null on a clean extraction. Set (with `frames` possibly non-empty) when
   *  the browser gave up part-way. */
  error: FrameErrorCode | null;
};

type Session = { video: HTMLVideoElement; release: () => void };

/** Open a file as a decoded <video>, metadata loaded, or throw. */
async function openVideo(file: File): Promise<Session> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      video.removeAttribute("src");
      video.load();
    } catch {
      /* the element is being discarded either way */
    }
    URL.revokeObjectURL(url);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no_metadata")), METADATA_TIMEOUT_MS);
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error("no_metadata"));
      };
      video.src = url;
    });
  } catch (e) {
    release();
    throw e;
  }
  return { video, release };
}

/** Seek and wait for the frame to actually be there. Resolves false on a seek
 *  the decoder never completes — the one failure that would otherwise leave
 *  the picker spinning on a codec the browser half-supports. */
function seekTo(video: HTMLVideoElement, t: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      resolve(ok);
    };
    const onSeeked = () => done(true);
    const onError = () => done(false);
    const timer = setTimeout(() => done(false), SEEK_TIMEOUT_MS);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    try {
      video.currentTime = t;
    } catch {
      done(false);
    }
  });
}

function drawToCanvas(video: HTMLVideoElement, maxWidth: number | null): HTMLCanvasElement | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  const scale = maxWidth && w > maxWidth ? maxWidth / w : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  } catch {
    /* a tainted or undecodable frame */
    return null;
  }
  return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), "image/jpeg", quality);
    } catch {
      resolve(null);
    }
  });
}

/** Which instants to take. One per whole second up to the cap; past it, the
 *  cap spread evenly across the clip. Always whole seconds — beyond 12 s the
 *  step is over a second, so rounding cannot collide. */
export function frameSeconds(duration: number, max = MAX_FRAMES): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const whole = Math.max(1, Math.floor(duration));
  if (whole <= max) return Array.from({ length: whole }, (_, i) => i);
  const step = duration / max;
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(Math.floor(i * step));
  return out;
}

/** Extract the picker strip. Never throws: a failure comes back as `error`
 *  with however many frames were drawn before it. */
export async function extractFrames(file: File): Promise<FrameExtraction> {
  let session: Session | null = null;
  try {
    session = await openVideo(file);
  } catch {
    return { frames: [], duration: 0, evenlySpaced: false, error: "no_metadata" };
  }
  const { video, release } = session;
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (duration <= 0) {
    release();
    return { frames: [], duration: 0, evenlySpaced: false, error: "no_duration" };
  }
  const seconds = frameSeconds(duration);
  const evenlySpaced = Math.floor(duration) > MAX_FRAMES;
  const frames: ExtractedFrame[] = [];
  let error: FrameErrorCode | null = null;

  try {
    for (const at of seconds) {
      const ok = await seekTo(video, Math.min(at, Math.max(0, duration - 0.05)));
      if (!ok) {
        error = "seek_timeout";
        break;
      }
      const canvas = drawToCanvas(video, PREVIEW_WIDTH);
      if (!canvas) {
        error = "draw_failed";
        break;
      }
      let dataUrl = "";
      try {
        dataUrl = canvas.toDataURL("image/jpeg", PREVIEW_QUALITY);
      } catch {
        error = "draw_failed";
        break;
      }
      frames.push({ atSeconds: at, dataUrl, toBlob: () => exportFrame(file, at) });
    }
  } finally {
    release();
  }

  if (!frames.length && !error) error = "no_frames";
  return { frames, duration, evenlySpaced, error };
}

/** The frame the operator picked, at the video's native resolution. A fresh
 *  session so this is safe long after the strip was built (and after the
 *  extraction's own video element was released). */
export async function exportFrame(file: File, atSeconds: number): Promise<Blob> {
  const session = await openVideo(file);
  try {
    const duration = Number.isFinite(session.video.duration) ? session.video.duration : 0;
    const at = duration > 0 ? Math.min(atSeconds, Math.max(0, duration - 0.05)) : atSeconds;
    const ok = await seekTo(session.video, at);
    if (!ok) throw new Error("seek_timeout");
    const canvas = drawToCanvas(session.video, null);
    if (!canvas) throw new Error("draw_failed");
    const blob = await canvasToBlob(canvas, EXPORT_QUALITY);
    if (!blob) throw new Error("draw_failed");
    return blob;
  } finally {
    session.release();
  }
}

/** `FIELD_0001.MP4` + 3 s -> `FIELD_0001_t3s.jpg`. The name carries the claim:
 *  this is one instant of that clip, and every screen downstream can say so
 *  without consulting anything. */
export function frameFileName(sourceName: string, atSeconds: number): string {
  const stem = sourceName.replace(/\.[^.]+$/, "") || "frame";
  const label = Number.isInteger(atSeconds) ? String(atSeconds) : atSeconds.toFixed(1);
  return `${stem}_t${label}s.jpg`;
}

/** Where the aircraft was at that instant, from the clip's own telemetry.
 *
 *  Linear interpolation between the two surrounding fixes, clamped at both
 *  ends. Returns null when the track is empty — a quick count with no
 *  telemetry goes to the pin flow rather than inheriting the sortie's
 *  midpoint, which is a coordinate the frame has no relationship to. */
export function trackAt(track: TrackPoint[], atSeconds: number): { lat: number; lng: number } | null {
  if (!track.length) return null;
  const pts = [...track].sort((a, b) => a.t - b.t);
  if (pts.length === 1 || atSeconds <= pts[0].t) return { lat: pts[0].lat, lng: pts[0].lng };
  const last = pts[pts.length - 1];
  if (atSeconds >= last.t) return { lat: last.lat, lng: last.lng };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (atSeconds > b.t) continue;
    const span = b.t - a.t;
    const k = span > 0 ? (atSeconds - a.t) / span : 0;
    return { lat: a.lat + (b.lat - a.lat) * k, lng: a.lng + (b.lng - a.lng) * k };
  }
  return { lat: last.lat, lng: last.lng };
}
