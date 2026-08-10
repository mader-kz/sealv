"use client";
/* Count replay: the number, replayed as it was earned. Left — the counted
   frame, every animal appearing dot by dot with the tally ticking up. Right —
   the same animals landing on their measured coordinates on satellite imagery,
   with the media GPS track still shown when scale is missing.
   One clock drives both, so scrubbing the strip scrubs the map.

   This is presentation over the archive, not a second pipeline: the dots are
   the run's own points in the reference frame's pixel space, the positions are
   the georeferenced lat/lng the worker wrote, and the media track is the
   location source when individual projection is unavailable. The tally ends on the same
   mark count the Evidence view's header states. Nothing here is animated that
   was not measured.

   The engine lives outside React on purpose. A replay advances ~60×/s and a
   sortie is up to ~2000 animals; the frame dots are canvas draws and the map
   reveal is a GL filter swap, with React re-rendered only for the plural label
   (throttled) and the transport buttons. Everything per-tick goes through refs. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchRun, mediaFileUrl, mediaFrameUrl } from "@/lib/api";
import type { Footage } from "@/lib/types";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/primitives";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/* One revealed animal: pixel position in the reference frame, and — when the
   worker could georeference it — the map position. `seq` is the reveal order,
   which is the backend point id order: stable, so the same sortie replays the
   same way tomorrow. */
type Mark = {
  seq: number;
  px: number;
  py: number;
  lng: number;
  lat: number;
  placed: boolean;
};

/* Satellite, not the platform's dark carto: the replay is the one screen where
   the basemap is the subject's habitat rather than context, and dots landing on
   real shoreline read as evidence in a way dots on grey water do not. GL cannot
   read CSS vars, so --accent is baked in — same note as CaspianMap. */
const ACCENT = "#3fd8a3";
const SAT_STYLE: any = {
  version: 8,
  sources: {
    esri: {
      type: "raster",
      tiles: [
        /* blankTile=false: missing imagery 404s instead of serving a grey
           placeholder plate, and MapLibre keeps the overzoomed parent
           imagery on screen — same note as CaspianMap. */
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?blankTile=false",
      ],
      tileSize: 256,
      attribution: "Esri",
    },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#0d0f11" } },
    {
      id: "sat",
      type: "raster",
      source: "esri",
      paint: { "raster-brightness-max": 0.92, "raster-saturation": -0.1 },
    },
  ],
};

/* ~35 ms per animal, clamped: a 40-animal sortie should not be over before it
   registers, and a 2000-animal colony should not be a screensaver. */
const MS_PER_MARK = 35;
const MIN_MS = 6000;
const MAX_MS = 20000;
/* How long a landing stays visibly a landing. */
const POP_MS = 420;

export default function ReplayView({
  open,
  onOpenChange,
  footage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  footage: Footage;
}) {
  const { t } = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="max-w-[94vw] w-[94vw] h-[88vh] p-0 gap-0 flex flex-col overflow-hidden bg-surface border-line"
      >
        <DialogHeader className="flex-row items-baseline gap-3 space-y-0 px-4 py-3 pr-12 border-b border-line shrink-0">
          <DialogTitle className="text-sm font-medium text-ink tracking-normal">
            {t("replay.title")}
          </DialogTitle>
          <span className="text-xs text-ink3 font-mono truncate">{footage.filename}</span>
        </DialogHeader>
        {/* The stage mounts with the dialog and unmounts with it — its unmount
            is what stops the clock and tears the GL map down. */}
        <ReplayStage f={footage} />
      </DialogContent>
    </Dialog>
  );
}

/* Exported for the ingest scan stage: the moment a count lands is the moment
   the reader most wants to see it earned, and mounting THIS component inline
   is what keeps "the replay in the dialog" and "the replay in the row" the
   same replay forever. */
export function ReplayStage({ f }: { f: Footage }) {
  const { t, tp } = useT();

  /* ------------------------------------------------------------- the marks */
  /* The reviewer's verdicts live on `detections`; `pixels` is the engine's
     original list. A point either list calls a false positive is not an animal
     and is not replayed — the tally must end on the number the product shows. */
  const marks: Mark[] = useMemo(() => {
    const det = new Map(f.detections.map((d) => [d.id, d]));
    const out: Mark[] = [];
    for (const p of [...(f.pixels ?? [])].sort((a, b) => a.id - b.id)) {
      if (!Number.isFinite(p.px) || !Number.isFinite(p.py)) continue;
      const d = det.get(`${f.id}-p${p.id}`);
      if ((d?.status ?? p.status) === "false_positive") continue;
      const placed = d != null && Number.isFinite(d.lat) && Number.isFinite(d.lng);
      out.push({
        seq: out.length,
        px: p.px,
        py: p.py,
        lng: placed ? (d as any).lng : 0,
        lat: placed ? (d as any).lat : 0,
        placed,
      });
    }
    return out;
  }, [f]);
  const n = marks.length;
  const placedMarks = useMemo(() => marks.filter((m) => m.placed), [marks]);
  const trackPoints = useMemo(
    () => f.track.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)),
    [f.track],
  );
  const mapTrackPoints = useMemo(() => {
    if (trackPoints.length > 0) return trackPoints;
    return Number.isFinite(f.center.lat) && Number.isFinite(f.center.lng)
      ? [{ t: 0, lat: f.center.lat, lng: f.center.lng }]
      : [];
  }, [f.center, trackPoints]);
  const hasMapPosition = placedMarks.length > 0 || mapTrackPoints.length > 0;
  const durationMs = Math.min(MAX_MS, Math.max(MIN_MS, n * MS_PER_MARK));

  /* -------------------------------------------------------------- the frame */
  /* A photo (or quick-count) sortie: the media file IS the counted frame. A
     video run: the points are pinned to the reference frame the consensus was
     assembled in, and only the run's quality ledger knows which sampled frame
     that was — fetched here, served from the job's own frames directory. */
  const [frame, setFrame] = useState<"loading" | "none" | { url: string }>("loading");
  useEffect(() => {
    let cancelled = false;
    const ctl = new AbortController();
    (async () => {
      if (!f.videoUrl && f.mediaId) {
        setFrame({ url: mediaFileUrl(f.mediaId) });
        return;
      }
      if (f.runId) {
        try {
          const run = await fetchRun(f.runId, { signal: ctl.signal });
          const q = run.quality;
          const file = q?.frames?.find((fr) => fr.index === q?.reference_frame)?.file;
          const mediaId = run.media_id ?? f.mediaId;
          if (!cancelled && file && mediaId) {
            setFrame({ url: mediaFrameUrl(mediaId, file, run.job_id) });
            return;
          }
        } catch {
          /* fall through to the frameless stage */
        }
      }
      if (!cancelled) setFrame("none");
    })();
    return () => {
      cancelled = true;
      ctl.abort();
    };
  }, [f]);

  /* The frame's own pixel size — the coordinate system the points were
     measured in. From the loaded image when there is one; from the points'
     own extent when there is not, so a purged archive still replays. */
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const dimsRef = useRef(dims);
  dimsRef.current = dims;
  useEffect(() => {
    if (frame !== "none" || n === 0) return;
    const w = Math.max(...marks.map((m) => m.px)) * 1.06 + 24;
    const h = Math.max(...marks.map((m) => m.py)) * 1.06 + 24;
    setDims({ w, h });
  }, [frame, marks, n]);

  /* -------------------------------------------------------------- the clock */
  const tRef = useRef(0);
  const lastTsRef = useRef<number | null>(null);
  const rafRef = useRef(0);
  const startedRef = useRef(false);
  const playingRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  /* Throttled mirror of the reveal count, for the parts React must render:
     the plural label and the end-state band. The big digits are written to the
     DOM directly every tick. */
  const [k, setK] = useState(0);
  const kRef = useRef(0);
  const labelAtRef = useRef(0);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const counterRef = useRef<HTMLSpanElement | null>(null);
  const sliderRef = useRef<HTMLInputElement | null>(null);
  const boxRef = useRef({ w: 0, h: 0, dpr: 1 });

  const mapWrapRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const mapReadyRef = useRef(false);
  const mapKRef = useRef(-1);

  /* Draw the frame dots for the current clock and return the reveal count.
     Canvas, not SVG: this runs every animation frame over up to ~2000 marks,
     and reconciling that many circles per tick is exactly the cost the
     Evidence view's memo note warns about. */
  const draw = useCallback((): number => {
    const c = canvasRef.current;
    const d = dimsRef.current;
    const box = boxRef.current;
    const per = durationMs / Math.max(1, n);
    const kNow = Math.min(n, Math.floor(tRef.current / per));
    if (!c || !d || !box.w) return kNow;
    const ctx = c.getContext("2d");
    if (!ctx) return kNow;
    ctx.setTransform(box.dpr, 0, 0, box.dpr, 0, 0);
    ctx.clearRect(0, 0, box.w, box.h);
    /* object-contain letterboxing, the same fit rule the Evidence view uses,
       so a dot lands on its animal at any pane size. */
    const fit = Math.min(box.w / d.w, box.h / d.h);
    const ox = (box.w - d.w * fit) / 2;
    const oy = (box.h - d.h * fit) / 2;
    /* Half a percent of the displayed frame width — deliberately larger than
       the Evidence view's 0.35% rule. There a mark must stay out of the way
       of a verdict; here the marks ARE the show, and they have to read from
       across a room on a demo screen. */
    const r = Math.max(3, Math.min(9, d.w * fit * 0.006));
    /* A surveyor's mark, not a signal-green ring: green rings vanish on pale
       turquoise water, so legibility is carried by a WHITE reticle over a dark
       halo (that pair survives green water, grey sand and dark rock alike) and
       the accent survives only as the small centre dot. Still a ring, not a
       filled dot, so the animal stays visible inside its own mark (the Evidence
       view's reasoning). Three Path2Ds built once per frame and stroked/filled
       in five calls, so the marks stay a constant cost at any count. */
    const ring = new Path2D();
    const ticks = new Path2D();
    const cores = new Path2D();
    const tIn = r * 1.35;
    const tOut = tIn + r * 0.5;
    const cr = r * 0.35;
    for (let i = 0; i < kNow; i++) {
      const m = marks[i];
      const x = ox + m.px * fit;
      const y = oy + m.py * fit;
      ring.moveTo(x + r, y);
      ring.arc(x, y, r, 0, Math.PI * 2);
      ticks.moveTo(x, y - tIn);
      ticks.lineTo(x, y - tOut);
      ticks.moveTo(x, y + tIn);
      ticks.lineTo(x, y + tOut);
      ticks.moveTo(x - tIn, y);
      ticks.lineTo(x - tOut, y);
      ticks.moveTo(x + tIn, y);
      ticks.lineTo(x + tOut, y);
      cores.moveTo(x + cr, y);
      cores.arc(x, y, cr, 0, Math.PI * 2);
    }
    const ringW = Math.max(1.2, r * 0.34);
    const tickW = Math.max(1, ringW * 0.7);
    ctx.lineCap = "butt";
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = ringW + 2.5;
    ctx.stroke(ring);
    ctx.lineWidth = tickW + 2;
    ctx.stroke(ticks);
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = ringW;
    ctx.stroke(ring);
    ctx.lineWidth = tickW;
    ctx.stroke(ticks);
    ctx.fillStyle = ACCENT;
    ctx.fill(cores);
    /* The newest arrivals pop — an expanding, fading ACCENT ring (a live state,
       so it keeps the signal colour) with a brief white core flash under it. */
    for (let i = Math.max(0, kNow - 14); i < kNow; i++) {
      const age = tRef.current - (i + 1) * per;
      if (age < 0 || age > POP_MS) continue;
      const p = age / POP_MS;
      const m = marks[i];
      const x = ox + m.px * fit;
      const y = oy + m.py * fit;
      if (p < 0.34) {
        ctx.beginPath();
        ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.globalAlpha = (1 - p * 3) * 0.9;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(x, y, r * (1 + 2.6 * p), 0, Math.PI * 2);
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = Math.max(1, r * 0.45);
      ctx.globalAlpha = (1 - p) * 0.9;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    return kNow;
  }, [marks, n, durationMs]);

  /* Push the current clock everywhere it is shown: canvas, GL filters, the
     digits, the scrub position, and (throttled) the React label. */
  const sync = useCallback(() => {
    const kNow = draw();
    const map = mapRef.current;
    if (map && mapReadyRef.current && kNow !== mapKRef.current) {
      mapKRef.current = kNow;
      map.setFilter("replay-dots", ["<", ["get", "seq"], kNow]);
      map.setFilter("replay-pop", ["==", ["get", "seq"], kNow - 1]);
    }
    if (counterRef.current) counterRef.current.textContent = String(kNow);
    if (sliderRef.current)
      sliderRef.current.value = String(Math.round((tRef.current / durationMs) * 1000));
    if (kNow !== kRef.current) {
      kRef.current = kNow;
      const now = performance.now();
      if (now - labelAtRef.current > 120 || kNow >= n) {
        labelAtRef.current = now;
        setK(kNow);
      }
    }
    return kNow;
  }, [draw, durationMs, n]);

  const tick = useCallback(
    (ts: number) => {
      if (lastTsRef.current == null) lastTsRef.current = ts;
      tRef.current = Math.min(durationMs, tRef.current + (ts - lastTsRef.current));
      lastTsRef.current = ts;
      sync();
      if (tRef.current >= durationMs) {
        playingRef.current = false;
        setPlaying(false);
        setEnded(true);
        setK(n);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    },
    [durationMs, sync, n],
  );

  const play = useCallback(() => {
    if (n === 0) return;
    if (tRef.current >= durationMs) {
      tRef.current = 0;
      mapKRef.current = -1;
    }
    setEnded(false);
    playingRef.current = true;
    setPlaying(true);
    lastTsRef.current = null;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }, [n, durationMs, tick]);

  const pause = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    cancelAnimationFrame(rafRef.current);
  }, []);

  const seek = useCallback(
    (frac: number) => {
      tRef.current = Math.max(0, Math.min(1, frac)) * durationMs;
      if (ended && frac < 1) setEnded(false);
      if (!playingRef.current) sync();
    },
    [durationMs, ended, sync],
  );

  /* The stage unmounts with the dialog: stop the clock with it. */
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  /* Autoplay, once, as soon as there is a coordinate system to draw in. */
  useEffect(() => {
    if (startedRef.current || !dims || n === 0 || frame === "loading") return;
    startedRef.current = true;
    play();
  }, [dims, frame, n, play]);

  /* Keep the canvas bitmap the size of its pane, at device resolution. */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      boxRef.current = { w: rect.width, h: rect.height, dpr };
      const c = canvasRef.current;
      if (c) {
        c.width = Math.round(rect.width * dpr);
        c.height = Math.round(rect.height * dpr);
      }
      sync();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [sync]);

  /* ---------------------------------------------------------------- the map */
  const fc = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: placedMarks.map((m) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [m.lng, m.lat] },
        properties: { seq: m.seq },
      })),
    }),
    [placedMarks],
  );
  const trackFc = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: [
        ...(mapTrackPoints.length > 1
          ? [{
              type: "Feature" as const,
              geometry: {
                type: "LineString" as const,
                coordinates: mapTrackPoints.map((p) => [p.lng, p.lat]),
              },
              properties: {},
            }]
          : []),
        ...mapTrackPoints.map((p) => ({
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
          properties: {},
        })),
      ],
    }),
    [mapTrackPoints],
  );

  useEffect(() => {
    if (!hasMapPosition) return;
    let disposed = false;
    (async () => {
      /* Imported here, not at module top: this component sits in the static
         export's main bundle, and the GL runtime is only a cost the moment a
         replay actually opens. */
      const mod: any = await import("maplibre-gl");
      const el = mapWrapRef.current;
      if (disposed || !el) return;
      const maplibregl = mod.default ?? mod;
      /* Same worker-URL repair as CaspianMap — whichever map is created
         first spawns the shared pool, so both callers must set it. */
      (mod.setWorkerUrl ?? maplibregl.setWorkerUrl)?.("/maplibre-gl-worker.js");
      const map = new maplibregl.Map({ container: el, style: SAT_STYLE });
      mapRef.current = map;
      if (process.env.NODE_ENV === "development") (window as any).__replayMap = map;
      map.on("load", () => {
        if (disposed) return;
        map.addSource("replay-track", { type: "geojson", data: trackFc });
        if (mapTrackPoints.length > 1) {
          map.addLayer({
            id: "replay-track-line",
            type: "line",
            source: "replay-track",
            filter: ["==", ["geometry-type"], "LineString"],
            paint: {
              "line-color": ACCENT,
              "line-width": 2,
              "line-opacity": 0.72,
              "line-dasharray": [2, 2],
            },
          });
        }
        if (mapTrackPoints.length > 0) {
          map.addLayer({
            id: "replay-track-points",
            type: "circle",
            source: "replay-track",
            filter: ["==", ["geometry-type"], "Point"],
            paint: {
              "circle-color": "#0d0f11",
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 4, 16, 7, 18, 9],
              "circle-stroke-color": ACCENT,
              "circle-stroke-width": 2,
              "circle-opacity": 0.95,
            },
          });
        }
        map.addSource("replay", { type: "geojson", data: fc });
        map.addLayer({
          id: "replay-dots",
          type: "circle",
          source: "replay",
          filter: ["<", ["get", "seq"], 0],
          paint: {
            "circle-color": ACCENT,
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 2, 12, 3.5, 16, 7, 18, 10],
            "circle-opacity": 0.85,
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 1.5,
            "circle-stroke-opacity": 0.9,
          },
        });
        /* The landing flash: the single newest dot, big and soft under the
           solid layer's own copy of it. */
        map.addLayer(
          {
            id: "replay-pop",
            type: "circle",
            source: "replay",
            filter: ["==", ["get", "seq"], -1],
            paint: {
              "circle-color": ACCENT,
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 7, 16, 16, 18, 24],
              "circle-opacity": 0.3,
              "circle-blur": 0.5,
            },
          },
          "replay-dots",
        );
        const b = new maplibregl.LngLatBounds();
        for (const p of mapTrackPoints) b.extend([p.lng, p.lat]);
        for (const m of placedMarks) b.extend([m.lng, m.lat]);
        /* How deep the camera may go depends on what the position IS. Placed
           animals are a measured colony on a shoreline — imagery there runs
           deep, and the cluster deserves a close look. A track fix or a
           hand-dropped pin is one point of rough provenance: fitting z16 onto
           it fakes precision the pin does not have, and over open water the
           imagery bottoms out around z11 — deeper tiles are served as grey
           "map data not yet available" plates. */
        const camMax = placedMarks.length > 0 ? 15 : 11;
        map.fitBounds(b, { padding: 70, maxZoom: camMax, duration: 0 });
        mapReadyRef.current = true;
        mapKRef.current = -1;
        /* The dialog is still animating open when `load` fires, so the first
           fit was computed against a half-sized pane and can leave the colony
           off-screen entirely. Resizing alone does not re-aim the camera —
           measure again once the dialog has settled AND refit. */
        setTimeout(() => {
          if (disposed) return;
          map.resize();
          map.fitBounds(b, { padding: 70, maxZoom: camMax, duration: 0 });
        }, 300);
        sync();
      });
    })();
    return () => {
      disposed = true;
      mapReadyRef.current = false;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    /* `sync` is deliberately not a dependency: it changes identity with the
       throttle state, and tearing the GL map down over that would restart the
       basemap mid-replay. The ref pattern above is what it actually needs. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fc, hasMapPosition, mapTrackPoints, placedMarks, trackFc]);

  const low = f.band?.low ?? null;
  const best = f.band?.best ?? null;
  const high = f.band?.high ?? null;
  const hasRange = low != null && high != null && low !== high;

  return (
    <>
      {/* One pane: the frame IS the stage. The replay opens from the map,
          so the place is already on screen behind this dialog — a second map
          in here split the reader's attention with a pane of open water. The
          GL map code below stays but never mounts (mapWrapRef never renders),
          so restoring the split is a layout change, not an excavation. */}
      <div className="flex-1 flex min-h-0">
        <div
          ref={wrapRef}
          className="relative bg-bg flex-1 min-h-0 overflow-hidden"
        >
          {frame === "loading" && (
            <div className="absolute inset-0 grid place-items-center">
              <span className="text-xs text-ink3">{t("replay.loadingFrame")}</span>
            </div>
          )}
          {typeof frame === "object" && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={frame.url}
              alt={t("ev.alt")}
              draggable={false}
              decoding="async"
              className="absolute inset-0 w-full h-full object-contain select-none"
              onLoad={(e) => {
                const img = e.currentTarget;
                if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                  setDims({ w: img.naturalWidth, h: img.naturalHeight });
                }
              }}
              onError={() => setFrame("none")}
            />
          )}
          <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />
          {frame === "none" && (
            <span className="absolute bottom-2 left-2.5 text-2xs text-ink3">
              {t("replay.noFrame")}
            </span>
          )}
          {/* The tally. The digits are ref-written every tick; the label and
              the end-state range are the throttled React half. */}
          <div className="absolute top-3 left-3 plate px-3.5 py-2.5">
            <div className="flex items-baseline gap-2">
              <span ref={counterRef} className="text-hero tnum font-medium leading-none">
                0
              </span>
              <span className="text-sm text-ink2">{tp(k, "insp.sealsCounted")}</span>
            </div>
            {ended && hasRange && (
              <div className="text-2xs text-ink3 tnum mt-1">
                {t("misc.range", { low: low as number, high: high as number })}
                {best != null ? ` · ${best}` : ""}
              </div>
            )}
          </div>
          {!!f.unplaced && placedMarks.length > 0 && (
            <span className="absolute bottom-2 left-2.5 plate text-2xs text-ink3 px-1.5 py-0.5">
              {t("insp.withoutCoords", { n: f.unplaced })}
            </span>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------- transport */}
      <div className="px-4 py-3 border-t border-line flex items-center gap-3 shrink-0">
        <Button
          icon={playing ? "pause" : "play"}
          variant="primary"
          disabled={n === 0}
          onClick={() => (playing ? pause() : play())}
        >
          {playing ? t("replay.pause") : ended ? t("replay.again") : t("replay.play")}
        </Button>
        <input
          ref={sliderRef}
          type="range"
          min={0}
          max={1000}
          defaultValue={0}
          aria-label={t("replay.title")}
          onInput={(e) => seek(Number(e.currentTarget.value) / 1000)}
          className="flex-1 h-1 accent-accent cursor-pointer"
        />
        <span className="text-2xs tnum text-ink3 shrink-0">
          {n} · {Math.round(durationMs / 1000)}
          {t("unit.s")}
        </span>
      </div>
    </>
  );
}
