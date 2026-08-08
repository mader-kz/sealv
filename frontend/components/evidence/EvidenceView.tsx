"use client";
/* Evidence view: the number is not from a black box - here is the actual
   frame, and here is every animal the count stands on. The <img> is the
   source file straight from the service (mediaFileUrl); the SVG overlay
   lives in the frame's own pixel space (viewBox = naturalWidth/Height),
   which is exactly the coordinate system `pixels` was measured in, so a
   point lands on its animal at any display size. */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { mediaFileUrl, type CountBand } from "@/lib/api";
import type { DetectionPixel } from "@/lib/types";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/primitives";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/* A rejected point is not an animal: it must not be drawn as one and it must
   not be in the header's count. The service withholds them today, but the
   points endpoint is being widened to carry them, and this view must not
   start crediting them the day it does. One predicate, used by both. */
const isMark = (p: DetectionPixel) => p.status !== "false_positive";

/* ------------------------------------------------------------ the overlay */

/* memo: the overlay is the expensive half of this component (one <circle>
   per animal, ~2000 at the design target) and its inputs are four values
   that only change when a different sortie is opened. Without it every
   parent render — every pan commit, every zoom step — reconciled the lot. */
const Overlay = memo(function Overlay({
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
  const { t } = useT();
  /* r scales with the frame, not the screen: 0.35% of the frame width reads
     the same on a 4000px drone still and a 340px inspector preview. */
  const r = Math.max(2, w * 0.0035);
  /* Hover emphasis is a CSS rule, not React state. It used to be
     `useState(hovered)` read inside the map, so pointing at one animal
     re-rendered every mark on the frame — twice, once in and once out. The
     class name is keyed by the radius so two overlays over different frames
     cannot inherit each other's rule; inside a viewBox one CSS px is one user
     unit, which is why the hovered radius can be written as a length. */
  const cls = `evm-${Math.round(r * 1000)}`;
  const css =
    `.${cls}{pointer-events:auto;transition:r 90ms ease-out}` +
    `.${cls}:hover{r:${(r * 1.45).toFixed(3)}px}`;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="absolute inset-0 w-full h-full pointer-events-none"
      aria-hidden="true"
    >
      {interactive && <style>{css}</style>}
      {pixels.map((p) => {
        if (!isMark(p)) return null;
        if (!Number.isFinite(p.px) || !Number.isFinite(p.py)) return null;
        const validated = p.status === "validated";
        return (
          <circle
            key={p.id}
            cx={p.px}
            cy={p.py}
            r={r}
            className={interactive ? cls : undefined}
            fill={validated ? "var(--good)" : "var(--accent)"}
            fillOpacity={validated ? 0.55 : 0.4}
            stroke={validated ? "var(--good)" : "#fff"}
            strokeOpacity={0.9}
            strokeWidth={Math.max(0.75, r * 0.3)}
          >
            {interactive && (
              <title>
                {p.score != null ? t("ev.score", { n: p.score.toFixed(2) }) : t("ev.noScore")}
              </title>
            )}
          </circle>
        );
      })}
    </svg>
  );
});

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
  const { t } = useT();
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
          {t("ev.loadFailed")}
        </p>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={mediaFileUrl(mediaId)}
        alt={t("ev.alt")}
        draggable={false}
        /* The source file is the original still — 4000px and tens of MB of
           bitmap once decoded — and it is shown here at 340px in the
           inspector. Decoding off the main thread and skipping it entirely
           while the box is off-screen is what this file can do about that;
           the real win is a downscaled variant from the media route, which
           lives on the service side. */
        decoding="async"
        loading="lazy"
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
  /* `t` is taken by the pan/zoom transform state below — the translator
     rides under `tr` in this one component. */
  const { t: tr, tp } = useT();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [t, setT] = useState({ scale: 1, tx: 0, ty: 0 });
  const [dragging, setDragging] = useState(false);
  /* The viewport size and the transform at grab time. Captured once per drag
     so a pointermove never reads layout. */
  const dragStart = useRef<
    { x: number; y: number; tx: number; ty: number; w: number; h: number; scale: number } | null
  >(null);
  /* Where the drag has got to. The DOM is written directly during the gesture
     and React state only at pointer-up, so a pan costs no reconciliation. */
  const pending = useRef<{ tx: number; ty: number } | null>(null);

  const reset = () => setT({ scale: 1, tx: 0, ty: 0 });
  const atRest = t.scale === MIN_SCALE && t.tx === 0 && t.ty === 0;

  /* The content box is the viewport (absolute inset-0) scaled from its own
     top-left corner, so it spans [tx, tx + w*scale]. Keeping the viewport
     covered means tx ∈ [w(1 - scale), 0] — which collapses to exactly 0 at
     scale 1. That is the whole fix for "one stray drag leaves a black box":
     the frame can no longer be pushed off its own viewport at any zoom. */
  const clampPan = (tx: number, ty: number, scale: number, w: number, h: number) => ({
    tx: clamp(tx, w * (1 - scale), 0),
    ty: clamp(ty, h * (1 - scale), 0),
  });

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
        /* Keep the frame pixel under the cursor stationary while scaling —
           then pull the result back inside the viewport, or zooming out from
           a corner would leave the same empty gap a drag used to. */
        return {
          scale,
          ...clampPan(mx - k * (mx - prev.tx), my - k * (my - prev.ty), scale, rect.width, rect.height),
        };
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
    /* Nothing to pan at 1×: the frame already fills the viewport, so a drag
       here could only move it away. Start no gesture at all. */
    if (t.scale === MIN_SCALE) return;
    const rect = e.currentTarget.getBoundingClientRect();
    dragStart.current = {
      x: e.clientX,
      y: e.clientY,
      tx: t.tx,
      ty: t.ty,
      w: rect.width,
      h: rect.height,
      scale: t.scale,
    };
    pending.current = { tx: t.tx, ty: t.ty };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragStart.current;
    if (!d) return;
    const p = clampPan(d.tx + (e.clientX - d.x), d.ty + (e.clientY - d.y), d.scale, d.w, d.h);
    pending.current = p;
    /* Written straight to the node. Going through setState re-rendered this
       component, EvidenceFrame and every animal mark on every pointer event. */
    const el = contentRef.current;
    if (el) el.style.transform = `translate(${p.tx}px, ${p.ty}px) scale(${d.scale})`;
  };
  const endDrag = () => {
    const p = pending.current;
    dragStart.current = null;
    pending.current = null;
    setDragging(false);
    if (p) setT((prev) => ({ ...prev, tx: p.tx, ty: p.ty }));
  };

  /* Rejected points are not animals and are not counted here either. */
  const n = useMemo(() => pixels.filter(isMark).length, [pixels]);
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
            {tr("ev.title")} — <span className="tnum">{n}</span>{" "}
            {tp(n, "ev.animalsMarked")}
          </DialogTitle>
          {hasRange && band && (
            <span className="text-xs text-ink2 tnum">
              {tr("misc.range", { low: band.low as number, high: band.high as number })}
            </span>
          )}
          {/* Reset is a control, not a hint. It used to exist only inside
              `ev.hint`, which is `hidden sm:block` — so on the narrow screens
              where a stray drag is most likely, the only way back was a
              double-click nobody had been told about. */}
          <div className="ml-auto self-center flex items-center gap-2">
            <span className="text-2xs text-ink3 hidden sm:block">{tr("ev.hint")}</span>
            <Button onClick={reset} disabled={atRest} title={tr("btn.reset")}>
              {tr("btn.reset")}
            </Button>
          </div>
        </DialogHeader>

        <div
          ref={viewportRef}
          className="flex-1 relative overflow-hidden bg-bg touch-none"
          /* At 1× there is nothing to grab, so the cursor must not promise a
             gesture that is (now correctly) inert. */
          style={{ cursor: t.scale === MIN_SCALE ? "default" : dragging ? "grabbing" : "grab" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={reset}
        >
          <div
            ref={contentRef}
            className="absolute inset-0 will-change-transform"
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
