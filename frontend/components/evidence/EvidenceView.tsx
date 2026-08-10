"use client";
/* Evidence: the number is not from a black box - here is the actual frame, and
   here is every animal the count stands on. The <img> is the source file
   straight from the service (mediaFileUrl); the SVG overlay lives in the
   frame's own pixel space (viewBox = naturalWidth/Height), which is exactly
   the coordinate system `pixels` was measured in, so a point lands on its
   animal at any display size.

   This file used to BE a dialog. In the five-mode shell the frame is not a
   thing you open over the map — it is the left three quarters of Проверка, the
   screen a reviewer spends an afternoon in. So the machinery is now three
   pieces that can be housed anywhere:

     EvidenceFrame    the still with its marks. Unchanged; the inspector's
                      inline preview still uses it.
     EvidenceCanvas   that frame inside a pan/zoom viewport, with the walk's
                      camera, the cursor ring and point picking. This is the
                      piece ReviewMode embeds.
     EvidenceView     the old dialog, now a thin wrapper around the canvas.
                      Kept because the inspector still offers it; the review
                      MODE is the place this work is meant to happen, and this
                      dialog is expected to retire with that button.

   The pan/zoom, the clamp and the camera maths below moved verbatim — this is
   a re-housing, not a rewrite of a piece of geometry that took several passes
   to get right. */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { mediaFileUrl, type CountBand } from "@/lib/api";
import type { Detection, DetectionPixel, Footage } from "@/lib/types";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/primitives";
import { useFootageStore } from "@/store/useFootageStore";
import { useReviewStore } from "@/store/useReviewStore";
import TriageBar from "@/components/review/TriageBar";
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

/* useLayoutEffect on the client, useEffect on the server. The camera has to
   settle before paint or the reviewer sees the previous animal for a frame on
   every keystroke; React warns about the layout variant during SSR, and this
   component is inside a statically exported page. */
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/* ------------------------------------------------------------ the overlay */

/* memo: the overlay is the expensive half of this component (one <circle>
   per animal, ~2000 at the design target) and its inputs are four values
   that only change when a different sortie is opened. Without it every
   parent render — every pan commit, every zoom step — reconciled the lot.
   `onPick` must therefore be a STABLE callback; every caller here wraps it. */
const Overlay = memo(function Overlay({
  w,
  h,
  pixels,
  interactive = false,
  onPick,
}: {
  w: number;
  h: number;
  pixels: DetectionPixel[];
  interactive?: boolean;
  /** A point was clicked on the frame. Stable identity required. */
  onPick?: (p: DetectionPixel) => void;
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
    `.${cls}:hover{r:${(r * 1.45).toFixed(3)}px}` +
    (onPick ? `.${cls}{cursor:pointer}` : "");
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
        /* Colour means a verdict here and nothing else. A mark nobody has
           ruled on is a near-empty white ring — the frame underneath is the
           evidence, so the mark points at the animal instead of painting over
           it — and green appears only where a human has said yes. It was the
           other way round in effect: `good` and `accent` are the same green,
           so every engine mark on the frame already wore the confirmed
           colour, and a reviewer could not see what their own pass had
           changed. Rejected marks are not drawn at all (isMark, above). */
        const validated = p.status === "validated";
        return (
          <circle
            key={p.id}
            cx={p.px}
            cy={p.py}
            r={r}
            className={interactive ? cls : undefined}
            fill={validated ? "var(--good)" : "var(--ink)"}
            fillOpacity={validated ? 0.38 : 0.09}
            stroke={validated ? "var(--good)" : "#fff"}
            strokeOpacity={0.9}
            strokeWidth={Math.max(0.75, r * 0.3)}
            onClick={onPick ? () => onPick(p) : undefined}
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

/* The cursor of the walk, in its OWN svg layer over the overlay.
   Two reasons it is not a prop of Overlay: the ring must be drawn even when
   the point under it has just been rejected (the overlay stops drawing those,
   and a reviewer must still see what they ruled on), and keeping it out means
   stepping through the queue does not reconcile two thousand circles per
   keystroke. Same viewBox and the same default preserveAspectRatio, so it
   letterboxes identically to the frame and to the marks. */
function CursorRing({ w, h, p }: { w: number; h: number; p: DetectionPixel }) {
  if (!Number.isFinite(p.px) || !Number.isFinite(p.py)) return null;
  const r = Math.max(2, w * 0.0035);
  const ring = r * 3.4;
  const stroke = Math.max(1, r * 0.55);
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="absolute inset-0 w-full h-full pointer-events-none"
      aria-hidden="true"
    >
      {/* A ring, not a colour: the marks already use colour for the verdict,
          and "which animal am I ruling on" must not be a hue comparison. */}
      <circle cx={p.px} cy={p.py} r={ring} fill="none" stroke="#000" strokeOpacity={0.55}
              strokeWidth={stroke * 2.1} />
      <circle cx={p.px} cy={p.py} r={ring} fill="none" stroke="var(--accent)" strokeWidth={stroke} />
      <circle cx={p.px} cy={p.py} r={r * 0.6} fill="var(--accent)" />
    </svg>
  );
}

/* ------------------------------------------------- frame + overlay, shared */

/** The real frame with every animal marked. Fills its parent; the image is
    object-contain and the SVG letterboxes identically (xMidYMid meet), so
    the two stay registered without any measuring. Used as the inspector's
    inline preview and, wrapped in pan/zoom, inside the canvas. */
export function EvidenceFrame({
  mediaId,
  pixels,
  interactive = false,
  cursor = null,
  onDims,
  onPick,
}: {
  mediaId: string;
  pixels: DetectionPixel[];
  interactive?: boolean;
  /** The point the review walk is on, ringed above the marks. */
  cursor?: DetectionPixel | null;
  /** The frame's own pixel size, as soon as the browser knows it. The walk
   *  needs it to aim the camera at a point; the inspector preview ignores it. */
  onDims?: (dims: { w: number; h: number } | null) => void;
  /** A mark was clicked. Stable identity required (the overlay is memoised). */
  onPick?: (p: DetectionPixel) => void;
}) {
  const { t } = useT();
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);

  /* Held in a ref so a caller passing an inline arrow does not re-run the
     reset effect below on every one of its renders. */
  const emit = useRef(onDims);
  emit.current = onDims;

  /* A new sortie means a new file: drop the old frame's geometry instead of
     drawing new points over it while the new image is still in flight. */
  useEffect(() => {
    setDims(null);
    setFailed(false);
    emit.current?.(null);
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
          if (img.naturalWidth > 0 && img.naturalHeight > 0) {
            const d = { w: img.naturalWidth, h: img.naturalHeight };
            setDims(d);
            emit.current?.(d);
          }
        }}
        onError={() => setFailed(true)}
      />
      {dims && (
        <Overlay w={dims.w} h={dims.h} pixels={pixels} interactive={interactive} onPick={onPick} />
      )}
      {dims && cursor && <CursorRing w={dims.w} h={dims.h} p={cursor} />}
    </div>
  );
}

/* --------------------------------------------------------- the pan/zoom box */

const MIN_SCALE = 1;
const MAX_SCALE = 8;
/* Where the walk zooms to when it takes the camera. Enough that one animal is
   a subject rather than a speck; the reviewer can still wheel from here. */
export const WALK_SCALE = 4;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/* The content box is the viewport (absolute inset-0) scaled from its own
   top-left corner, so it spans [tx, tx + w*scale]. Keeping the viewport
   covered means tx ∈ [w(1 - scale), 0] — which collapses to exactly 0 at
   scale 1. That is the whole fix for "one stray drag leaves a black box":
   the frame can no longer be pushed off its own viewport at any zoom. */
const clampPan = (tx: number, ty: number, scale: number, w: number, h: number) => ({
  tx: clamp(tx, w * (1 - scale), 0),
  ty: clamp(ty, h * (1 - scale), 0),
});

/** Movement, in CSS pixels, past which a pointer gesture is a PAN and the
 *  click that ends it is not a pick. Without it, dragging the frame by
 *  grabbing an animal writes a verdict on that animal. */
const PICK_SLOP = 3;

export type Transform = { scale: number; tx: number; ty: number };

/** What an embedder can tell the canvas to do. Everything else is a prop —
 *  this is only for the gestures a control OUTSIDE the viewport owns (zoom
 *  buttons, a reset, focusing the frame so the keys are live). */
export type EvidenceCanvasApi = {
  /** Back to the whole frame. */
  reset: () => void;
  /** Zoom about the viewport centre. k > 1 in, k < 1 out. */
  zoomBy: (k: number) => void;
  /** Put keyboard focus on the viewport, where the verdict keys are bound. */
  focus: () => void;
  /** Centre the camera on a point, optionally zooming in at least this far. */
  centerOn: (p: DetectionPixel, minScale?: number) => void;
};

/** The frame in a viewport that pans, zooms and can be walked by a queue.
 *
 *  It owns the camera and NOTHING else: which point is under the cursor, what
 *  a verdict does and where the queue goes are the embedder's. That split is
 *  what lets the dialog and the review mode share one implementation of a
 *  piece of geometry that is easy to get subtly wrong. */
export function EvidenceCanvas({
  mediaId,
  pixels,
  cursor = null,
  follow = false,
  focusToken,
  focusScale = WALK_SCALE,
  panDisabled = false,
  focusable = false,
  onPick,
  onKeyDown,
  onTransform,
  onDims,
  apiRef,
  className = "",
}: {
  mediaId: string;
  pixels: DetectionPixel[];
  /** The point under the review cursor: ringed, and what the camera aims at. */
  cursor?: DetectionPixel | null;
  /** Keep `cursor` centred continuously — the walk's camera. While it is on,
   *  free panning is off: two authors of one transform fight. */
  follow?: boolean;
  /** Centre on `cursor` ONCE, whenever this value changes. For a selection
   *  made somewhere else (a queue row) that should move the camera, without
   *  taking the frame away from the mouse the rest of the time. */
  focusToken?: number;
  /** Minimum scale a focus step zooms to. */
  focusScale?: number;
  panDisabled?: boolean;
  /** Make the viewport keyboard-focusable — set this where `onKeyDown` carries
   *  the verdict keys. */
  focusable?: boolean;
  /** A mark on the frame was clicked (and the gesture was not a pan). */
  onPick?: (p: DetectionPixel) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  /** The live camera, for a zoom readout or to disable a Reset control. */
  onTransform?: (xf: Transform) => void;
  onDims?: (dims: { w: number; h: number } | null) => void;
  apiRef?: React.MutableRefObject<EvidenceCanvasApi | null>;
  className?: string;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [xf, setXf] = useState<Transform>({ scale: 1, tx: 0, ty: 0 });
  const [dragging, setDragging] = useState(false);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  /* The viewport size and the transform at grab time. Captured once per drag
     so a pointermove never reads layout. */
  const dragStart = useRef<
    { x: number; y: number; tx: number; ty: number; w: number; h: number; scale: number } | null
  >(null);
  /* Where the drag has got to. The DOM is written directly during the gesture
     and React state only at pointer-up, so a pan costs no reconciliation. */
  const pending = useRef<{ tx: number; ty: number } | null>(null);
  /* Did this gesture move far enough to be a pan. Read by the pick handler,
     which fires after pointerup. */
  const moved = useRef(false);

  /* Callbacks held in refs: they are read from effects and from a memoised
     child, and an inline arrow from the embedder must not re-run either. */
  const emitDims = useRef(onDims);
  emitDims.current = onDims;
  const emitXf = useRef(onTransform);
  emitXf.current = onTransform;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  const takeDims = useCallback((d: { w: number; h: number } | null) => {
    setDims(d);
    emitDims.current?.(d);
  }, []);

  useEffect(() => { emitXf.current?.(xf); }, [xf]);

  /* A new file is a new frame: start from the whole of it. */
  useEffect(() => { setXf({ scale: 1, tx: 0, ty: 0 }); }, [mediaId]);

  /* Wheel zoom toward the cursor. Native listener because React registers
     onWheel passively and we must preventDefault to keep the gesture ours. */
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setXf((prev) => {
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
  }, []);

  const endDrag = useCallback(() => {
    const p = pending.current;
    dragStart.current = null;
    pending.current = null;
    setDragging(false);
    if (p) setXf((prev) => ({ ...prev, tx: p.tx, ty: p.ty }));
  }, []);

  /* Panning just went away (a walk took the camera). Commit whatever the hand
     had already moved, or the pending DOM write would be applied over the
     camera's. */
  useEffect(() => { if (panDisabled) endDrag(); }, [panDisabled, endDrag]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    moved.current = false;
    /* While the walk owns the transform, a free pan would be a second author
       of the same three numbers — one writing the DOM node directly on every
       pointermove, the other setting state from the queue. They would fight,
       and the frame would jump between them. The walk wins. */
    if (panDisabled) return;
    /* Nothing to pan at 1×: the frame already fills the viewport, so a drag
       here could only move it away. Start no gesture at all. */
    if (xf.scale === MIN_SCALE) return;
    const rect = e.currentTarget.getBoundingClientRect();
    dragStart.current = {
      x: e.clientX,
      y: e.clientY,
      tx: xf.tx,
      ty: xf.ty,
      w: rect.width,
      h: rect.height,
      scale: xf.scale,
    };
    pending.current = { tx: xf.tx, ty: xf.ty };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragStart.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > PICK_SLOP) moved.current = true;
    const p = clampPan(d.tx + (e.clientX - d.x), d.ty + (e.clientY - d.y), d.scale, d.w, d.h);
    pending.current = p;
    /* Written straight to the node. Going through setState re-rendered this
       component, EvidenceFrame and every animal mark on every pointer event. */
    const el = contentRef.current;
    if (el) el.style.transform = `translate(${p.tx}px, ${p.ty}px) scale(${d.scale})`;
  };

  /* The camera, in the one place that knows where a frame pixel ends up on
     screen. `object-contain`: the frame is letterboxed inside the viewport at
     this fit scale, and the SVG marks use the same rule — so this is where the
     point actually is before the pan/zoom transform. */
  const cameraTo = useCallback((p: DetectionPixel, minScale?: number) => {
    const el = viewportRef.current;
    if (!el || !dims) return;
    if (!Number.isFinite(p.px) || !Number.isFinite(p.py)) return;
    const rect = el.getBoundingClientRect();
    const vw = rect.width;
    const vh = rect.height;
    if (!vw || !vh) return;
    const fit = Math.min(vw / dims.w, vh / dims.h);
    const ux = (vw - dims.w * fit) / 2 + p.px * fit;
    const uy = (vh - dims.h * fit) / 2 + p.py * fit;
    setXf((prev) => {
      const scale = minScale == null
        ? prev.scale
        : Math.max(prev.scale, clamp(minScale, MIN_SCALE, MAX_SCALE));
      const c = clampPan(vw / 2 - scale * ux, vh / 2 - scale * uy, scale, vw, vh);
      /* Same object back when nothing moved: the follow effect depends on the
         scale it also writes, and a fresh object every time would be a render
         loop. */
      if (scale === prev.scale && Math.abs(c.tx - prev.tx) < 0.5 && Math.abs(c.ty - prev.ty) < 0.5) {
        return prev;
      }
      return { scale, tx: c.tx, ty: c.ty };
    });
  }, [dims]);

  /* Layout effect, so the frame is already on the new animal in the frame the
     keystroke paints — with useEffect the reviewer sees the previous animal
     for one frame on every verdict. Reads the live scale rather than forcing
     one, so a wheel zoom during the walk re-centres instead of being undone. */
  useIsoLayoutEffect(() => {
    if (!follow || !cursor) return;
    cameraTo(cursor);
  }, [follow, cursor, cameraTo, xf.scale]);

  /* A selection made elsewhere that should take the camera exactly once. */
  const lastFocus = useRef<number | undefined>(focusToken);
  useIsoLayoutEffect(() => {
    if (focusToken === undefined || focusToken === lastFocus.current) return;
    lastFocus.current = focusToken;
    if (!cursor) return;
    cameraTo(cursor, focusScale);
  }, [focusToken, cursor, focusScale, cameraTo]);

  /* The handful of gestures whose controls live outside the viewport. */
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      reset: () => setXf({ scale: 1, tx: 0, ty: 0 }),
      zoomBy: (k: number) => {
        const el = viewportRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const mx = rect.width / 2;
        const my = rect.height / 2;
        setXf((prev) => {
          const scale = clamp(prev.scale * k, MIN_SCALE, MAX_SCALE);
          if (scale === MIN_SCALE) return { scale: 1, tx: 0, ty: 0 };
          const f = scale / prev.scale;
          return {
            scale,
            ...clampPan(mx - f * (mx - prev.tx), my - f * (my - prev.ty), scale, rect.width, rect.height),
          };
        });
      },
      focus: () => viewportRef.current?.focus(),
      centerOn: (p, minScale) => cameraTo(p, minScale),
    };
    return () => { apiRef.current = null; };
  }, [apiRef, cameraTo]);

  /* Stable for the memoised overlay, and it is where the pan/pick split is
     enforced: a click that ended a drag is not a verdict. */
  const handlePick = useCallback((p: DetectionPixel) => {
    if (moved.current) return;
    pickRef.current?.(p);
  }, []);

  return (
    <div
      ref={viewportRef}
      tabIndex={focusable ? 0 : -1}
      onKeyDown={onKeyDown}
      className={`relative overflow-hidden bg-bg touch-none outline-none ${className}`}
      /* At 1× there is nothing to grab, so the cursor must not promise a
         gesture that is (now correctly) inert — and neither must it during
         a walk, where the queue drives the frame. */
      style={{
        cursor: panDisabled || xf.scale === MIN_SCALE ? "default" : dragging ? "grabbing" : "grab",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={panDisabled ? undefined : () => setXf({ scale: 1, tx: 0, ty: 0 })}
    >
      <div
        ref={contentRef}
        className="absolute inset-0 will-change-transform"
        style={{
          transform: `translate(${xf.tx}px, ${xf.ty}px) scale(${xf.scale})`,
          transformOrigin: "0 0",
        }}
      >
        <EvidenceFrame
          mediaId={mediaId}
          pixels={pixels}
          interactive
          cursor={cursor}
          onDims={takeDims}
          onPick={onPick ? handlePick : undefined}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- the queue */

const scoreOf = (p: DetectionPixel): number | null =>
  typeof p.score === "number" && Number.isFinite(p.score) ? p.score : null;

/* Worst first. An unscored point is not a zero-scored one, so it sorts LAST
   rather than to the front of the queue; ties break on the backend id so the
   queue is the same queue tomorrow. */
export function byWorstFirst(a: DetectionPixel, b: DetectionPixel): number {
  const x = scoreOf(a);
  const y = scoreOf(b);
  if (x === null && y === null) return a.id - b.id;
  if (x === null) return 1;
  if (y === null) return -1;
  return x - y || a.id - b.id;
}

export type LiveReview = {
  /** The sortie these pixels belong to, resolved through the store. */
  footage: Footage | null;
  /** The id verdicts are addressed to (`<scopeKey>-p<pointId>`). */
  scopeKey: string;
  /** Per-animal archive rows by detection id. */
  detById: Map<string, Detection>;
  /** `pixels` with the reviewer's own verdicts folded in. */
  livePixels: DetectionPixel[];
  /** Those pixels, worst score first — the review queue. */
  order: DetectionPixel[];
  /** The archive row behind a point, or null when there is none to write to. */
  detOf: (p: DetectionPixel | null | undefined) => Detection | null;
};

/** The engine's points, the archive's verdicts, and the queue they make.
 *
 *  Without the merge the ring would go green and the mark under it would stay
 *  white: the frame would be showing the state of the archive before the
 *  reviewer touched it. Shared by the dialog and by ReviewMode so there is one
 *  answer to "what does this point say now". */
export function useLiveReview({
  pixels,
  footageId,
  mediaId,
}: {
  pixels: DetectionPixel[];
  footageId?: string;
  mediaId?: string;
}): LiveReview {
  const footages = useFootageStore((s) => s.footages);
  const footage = useMemo(
    () =>
      (footageId
        ? footages.find((f) => f.id === footageId)
        : footages.find((f) => f.mediaId === mediaId)) ?? null,
    [footages, footageId, mediaId],
  );
  const scopeKey = footage?.id ?? footageId ?? mediaId ?? "";
  const detById = useMemo(() => {
    const m = new Map<string, Detection>();
    for (const d of footage?.detections ?? []) m.set(d.id, d);
    return m;
  }, [footage]);

  const livePixels = useMemo(() => {
    if (detById.size === 0) return pixels;
    let changed = false;
    const next = pixels.map((p) => {
      const d = detById.get(`${scopeKey}-p${p.id}`);
      if (d && d.status !== p.status) {
        changed = true;
        return { ...p, status: d.status };
      }
      return p;
    });
    return changed ? next : pixels;
  }, [pixels, detById, scopeKey]);

  const order = useMemo(() => [...livePixels].sort(byWorstFirst), [livePixels]);

  const detOf = useCallback(
    (p: DetectionPixel | null | undefined) => (p ? detById.get(`${scopeKey}-p${p.id}`) ?? null : null),
    [detById, scopeKey],
  );

  return { footage, scopeKey, detById, livePixels, order, detOf };
}

/** Animals a frame is asserting: rejected points are not animals. */
export const markedCount = (pixels: DetectionPixel[]): number => pixels.filter(isMark).length;

/* -------------------------------------------------- the old dialog, wrapped */

export default function EvidenceView({
  open,
  onOpenChange,
  mediaId,
  pixels,
  band,
  footageId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mediaId: string;
  pixels: DetectionPixel[];
  band?: CountBand | null;
  /** The sortie these pixels belong to. Optional: callers that only know the
   *  media id get the same behaviour, resolved through the store. */
  footageId?: string;
}) {
  const { t, tp } = useT();
  const updateDetection = useFootageStore((s) => s.updateDetection);
  /* Package C adds `verdictsInFlight` to the footage store. Read defensively:
     this view has to work whether or not that field exists yet. */
  const saving = useFootageStore((s) => Number((s as any).verdictsInFlight ?? 0) > 0);
  const setCursor = useReviewStore((s) => s.setCursor);

  const { scopeKey, livePixels, order, detOf } = useLiveReview({ pixels, footageId, mediaId });

  /* ------------------------------------------------------------- the walk */
  const [walking, setWalking] = useState(false);
  const [idx, setIdx] = useState(0);
  const [atEnd, setAtEnd] = useState(false);
  const [focusToken, setFocusToken] = useState(0);
  /* The live camera, mirrored for the Reset control only. */
  const [xf, setXf] = useState<Transform>({ scale: 1, tx: 0, ty: 0 });
  const canvas = useRef<EvidenceCanvasApi | null>(null);

  const current = order[idx] ?? null;
  const currentDet = detOf(current);
  const atRest = xf.scale === MIN_SCALE && xf.tx === 0 && xf.ty === 0;

  /* Fresh sortie or a re-open: not in the middle of somebody else's walk. */
  useEffect(() => {
    setWalking(false);
    setAtEnd(false);
  }, [mediaId, open]);

  /* Where the reviewer stopped, kept outside this component so closing the
     dialog does not throw the pass away. */
  useEffect(() => {
    if (walking) setCursor(idx, scopeKey);
  }, [walking, idx, scopeKey, setCursor]);

  const startWalk = () => {
    if (!order.length) return;
    const st = useReviewStore.getState();
    const resume = st.cursorScope === scopeKey && st.cursor < order.length ? st.cursor : 0;
    setIdx(resume);
    setAtEnd(false);
    setWalking(true);
    // One focus step takes the camera to the animal at walking magnification;
    // `follow` keeps it there for the rest of the pass.
    setFocusToken((n) => n + 1);
    // Focus parks on the frame, which is where the keys are bound — not on a
    // control the reviewer would have to tab out of to see the animal.
    requestAnimationFrame(() => canvas.current?.focus());
  };

  const exitWalk = useCallback(() => {
    setWalking(false);
    setAtEnd(false);
  }, []);

  const step = useCallback(
    (delta: number) => {
      setAtEnd(false);
      setIdx((i) => clamp(i + delta, 0, Math.max(0, order.length - 1)));
    },
    [order.length],
  );

  const advance = useCallback(() => {
    setIdx((i) => {
      if (i + 1 >= order.length) {
        setAtEnd(true);
        return i;
      }
      return i + 1;
    });
  }, [order.length]);

  const rule = useCallback(
    (to: Detection["status"]) => {
      const d = currentDet;
      // No per-animal record behind this point: the verdict has nowhere to go,
      // and writing it to local state only would be a saved-looking lie.
      if (!d) return;
      if (d.status !== to) updateDetection(d.id, { status: to });
      advance();
    },
    [currentDet, updateDetection, advance],
  );

  /* Keys are read off `code`, not off `key`. Two of this product's three
     languages are typed on a Cyrillic layout, where the physical V key emits
     "м" — binding the letter alone would leave the keyboard pass working in
     English only. The latin letters stay as a fallback for layouts that report
     no code. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!walking) return;
    const code = e.code;
    const key = e.key;
    const hit = (c: string, k: string) => code === c || key.toLowerCase() === k;
    if (key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      exitWalk();
      return;
    }
    if (key === "ArrowRight" || key === "ArrowDown") {
      e.preventDefault();
      step(1);
      return;
    }
    if (key === "ArrowLeft" || key === "ArrowUp") {
      e.preventDefault();
      step(-1);
      return;
    }
    if (key === " " || code === "Space") {
      e.preventDefault();
      advance();
      return;
    }
    if (hit("KeyV", "v")) {
      e.preventDefault();
      rule("validated");
      return;
    }
    if (hit("KeyX", "x")) {
      e.preventDefault();
      rule("false_positive");
    }
  };

  const n = useMemo(() => markedCount(livePixels), [livePixels]);
  const hasRange =
    !!band && band.low != null && band.high != null && band.low !== band.high;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        /* Radix owns Escape for the dialog. During a walk it belongs to the
           walk — leaving the queue must not also throw away the frame the
           reviewer is looking at. */
        onEscapeKeyDown={(e) => {
          if (walking) {
            e.preventDefault();
            exitWalk();
          }
        }}
        /* No radius class: the instrument is square, and `rounded` here was a
           leftover intention that only stopped showing because the token went
           to 0. The dialog's own base carries the border and the shadow. */
        className="max-w-[92vw] w-[92vw] h-[88vh] p-0 gap-0 flex flex-col overflow-hidden bg-surface border-line"
      >
        <DialogHeader className="flex-row items-baseline gap-3 space-y-0 px-4 py-3 pr-12 border-b border-line shrink-0">
          {/* The hero of this view is the frame, so its chrome stays chrome:
              one step up from the body, no more. The count stays INSIDE the
              title — it is part of the dialog's accessible name, and pulling
              it out into a sibling span would have announced "Evidence" over a
              screen showing 1175 marked animals. */}
          <DialogTitle className="text-lead font-medium text-ink tracking-normal">
            {t("ev.title")} — <span className="tnum">{n}</span>{" "}
            {tp(n, "ev.animalsMarked")}
          </DialogTitle>
          {hasRange && band && (
            <span className="text-xs text-ink2 tnum">
              {t("misc.range", { low: band.low as number, high: band.high as number })}
            </span>
          )}
          {/* Reset is a control, not a hint. It used to exist only inside
              `ev.hint`, which is `hidden sm:block` — so on the narrow screens
              where a stray drag is most likely, the only way back was a
              double-click nobody had been told about. */}
          <div className="ml-auto self-center flex items-center gap-2">
            {!walking && (
              <span className="text-2xs text-ink3 hidden sm:block">{t("ev.hint")}</span>
            )}
            {!walking && (
              <Button
                icon="target"
                variant="primary"
                onClick={startWalk}
                disabled={order.length === 0}
                title={t("rev.startWhy")}
              >
                {t("rev.start")}
              </Button>
            )}
            <Button onClick={() => canvas.current?.reset()} disabled={atRest} title={t("btn.reset")}>
              {t("btn.reset")}
            </Button>
          </div>
        </DialogHeader>

        {walking && current && (
          <TriageBar
            index={idx + 1}
            total={order.length}
            score={scoreOf(current)}
            status={currentDet?.status ?? current.status}
            canRule={!!currentDet}
            saving={saving}
            atEnd={atEnd}
            onValidate={() => rule("validated")}
            onFalse={() => rule("false_positive")}
            onSkip={advance}
            onPrev={() => step(-1)}
            onNext={() => step(1)}
            onExit={exitWalk}
          />
        )}

        <EvidenceCanvas
          className="flex-1"
          mediaId={mediaId}
          pixels={livePixels}
          cursor={walking ? current : null}
          follow={walking}
          focusToken={focusToken}
          panDisabled={walking}
          focusable={walking}
          onKeyDown={onKeyDown}
          onTransform={setXf}
          apiRef={canvas}
        />
      </DialogContent>
    </Dialog>
  );
}
