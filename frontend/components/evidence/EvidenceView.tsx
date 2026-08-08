"use client";
/* Evidence view: the number is not from a black box - here is the actual
   frame, and here is every animal the count stands on. The <img> is the
   source file straight from the service (mediaFileUrl); the SVG overlay
   lives in the frame's own pixel space (viewBox = naturalWidth/Height),
   which is exactly the coordinate system `pixels` was measured in, so a
   point lands on its animal at any display size. */

import { useEffect, useRef, useState } from "react";
import { mediaFileUrl, type CountBand } from "@/lib/api";
import type { DetectionPixel } from "@/lib/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/* ------------------------------------------------------------ the overlay */

function Overlay({
  w,
  h,
  pixels,
  interactive = false,
}: {
  w: number;
  h: number;
  pixels: DetectionPixel[];
  interactive?: boolean;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  /* r scales with the frame, not the screen: 0.35% of the frame width reads
     the same on a 4000px drone still and a 340px inspector preview. */
  const r = Math.max(2, w * 0.0035);
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="absolute inset-0 w-full h-full pointer-events-none"
      aria-hidden="true"
    >
      {pixels.map((p) => {
        if (!Number.isFinite(p.px) || !Number.isFinite(p.py)) return null;
        const validated = p.status === "validated";
        const rr = interactive && hovered === p.id ? r * 1.45 : r;
        return (
          <circle
            key={p.id}
            cx={p.px}
            cy={p.py}
            r={rr}
            fill={validated ? "var(--good)" : "var(--accent)"}
            fillOpacity={validated ? 0.55 : 0.4}
            stroke={validated ? "var(--good)" : "#fff"}
            strokeOpacity={0.9}
            strokeWidth={Math.max(0.75, r * 0.3)}
            style={
              interactive
                ? { pointerEvents: "auto", transition: "r 90ms ease-out" }
                : undefined
            }
            onMouseEnter={interactive ? () => setHovered(p.id) : undefined}
            onMouseLeave={interactive ? () => setHovered(null) : undefined}
          >
            {interactive && (
              <title>
                {p.score != null ? `score ${p.score.toFixed(2)}` : "no score"}
              </title>
            )}
          </circle>
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------- frame + overlay, shared */

/** The real frame with every animal marked. Fills its parent; the image is
    object-contain and the SVG letterboxes identically (xMidYMid meet), so
    the two stay registered without any measuring. Used as the inspector's
    inline preview and, wrapped in pan/zoom, inside the dialog. */
export function EvidenceFrame({
  mediaId,
  pixels,
  interactive = false,
}: {
  mediaId: string;
  pixels: DetectionPixel[];
  interactive?: boolean;
}) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);

  /* A new sortie means a new file: drop the old frame's geometry instead of
     drawing new points over it while the new image is still in flight. */
  useEffect(() => {
    setDims(null);
    setFailed(false);
  }, [mediaId]);

  if (failed) {
    return (
      <div className="w-full h-full grid place-items-center p-4 text-center">
        <p className="text-xs text-ink3 max-w-[220px] leading-relaxed">
          The source frame could not be loaded. The count and its points are
          unaffected - only this preview is missing.
        </p>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={mediaFileUrl(mediaId)}
        alt="Source frame with detected animals"
        draggable={false}
        className="absolute inset-0 w-full h-full object-contain select-none"
        onLoad={(e) => {
          const img = e.currentTarget;
          if (img.naturalWidth > 0 && img.naturalHeight > 0)
            setDims({ w: img.naturalWidth, h: img.naturalHeight });
        }}
        onError={() => setFailed(true)}
      />
      {dims && (
        <Overlay w={dims.w} h={dims.h} pixels={pixels} interactive={interactive} />
      )}
    </div>
  );
}

/* -------------------------------------------------- fullscreen dialog view */

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export default function EvidenceView({
  open,
  onOpenChange,
  mediaId,
  pixels,
  band,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mediaId: string;
  pixels: DetectionPixel[];
  band?: CountBand | null;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [t, setT] = useState({ scale: 1, tx: 0, ty: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  const reset = () => setT({ scale: 1, tx: 0, ty: 0 });

  /* Wheel zoom toward the cursor. Native listener because React registers
     onWheel passively and we must preventDefault to keep the gesture ours. */
  useEffect(() => {
    if (!open) return;
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setT((prev) => {
        const scale = clamp(prev.scale * Math.exp(-e.deltaY * 0.0015), MIN_SCALE, MAX_SCALE);
        if (scale === MIN_SCALE) return { scale: 1, tx: 0, ty: 0 };
        const k = scale / prev.scale;
        /* Keep the frame pixel under the cursor stationary while scaling. */
        return { scale, tx: mx - k * (mx - prev.tx), ty: my - k * (my - prev.ty) };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [open]);

  /* Fresh sortie or a re-open: start from the whole frame, not last zoom. */
  useEffect(() => {
    reset();
  }, [mediaId, open]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragStart.current = { x: e.clientX, y: e.clientY, tx: t.tx, ty: t.ty };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragStart.current;
    if (!d) return;
    setT((prev) => ({
      ...prev,
      tx: d.tx + (e.clientX - d.x),
      ty: d.ty + (e.clientY - d.y),
    }));
  };
  const endDrag = () => {
    dragStart.current = null;
    setDragging(false);
  };

  const n = pixels.length;
  const hasRange =
    !!band && band.low != null && band.high != null && band.low !== band.high;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="max-w-[92vw] w-[92vw] h-[88vh] p-0 gap-0 flex flex-col overflow-hidden bg-surface border-line rounded"
      >
        <DialogHeader className="flex-row items-baseline gap-3 space-y-0 px-4 py-3 pr-12 border-b border-line shrink-0">
          <DialogTitle className="text-sm font-medium text-ink tracking-normal">
            Evidence — <span className="tnum">{n}</span>{" "}
            {n === 1 ? "animal" : "animals"} marked
          </DialogTitle>
          {hasRange && band && (
            <span className="text-xs text-ink2 tnum">
              range {band.low}–{band.high}
            </span>
          )}
          <span className="ml-auto text-2xs text-ink3 hidden sm:block">
            scroll to zoom · drag to pan · double-click to reset
          </span>
        </DialogHeader>

        <div
          ref={viewportRef}
          className="flex-1 relative overflow-hidden bg-bg touch-none"
          style={{ cursor: dragging ? "grabbing" : "grab" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={reset}
        >
          <div
            className="absolute inset-0"
            style={{
              transform: `translate(${t.tx}px, ${t.ty}px) scale(${t.scale})`,
              transformOrigin: "0 0",
            }}
          >
            <EvidenceFrame mediaId={mediaId} pixels={pixels} interactive />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
