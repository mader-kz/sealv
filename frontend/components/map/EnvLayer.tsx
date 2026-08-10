"use client";
/**
 * EnvLayer — the environment drawn on the chart, at the size it was measured.
 *
 * Three rules decide every pixel in here, and they are the product's, not this
 * component's:
 *
 * 1. A cell is drawn at its TRUE footprint. Its corners are projected through
 *    the same camera as everything else, so a 1 km MUR cell is a 1 km square —
 *    which at basin zoom is half a pixel, and that is the honest picture. Below
 *    the zoom where a cell can be seen the layer draws SAMPLE MARKERS instead,
 *    and the panel says in words that a dot marks where a measurement was taken
 *    and is not the size of anything.
 * 2. Nothing is interpolated. The service hands back the real product cells it
 *    holds, spaced roughly half a degree apart; the ground between them was
 *    never measured and nothing here paints over it. Each (source, variable) is
 *    its own layer at its own scale — a 9 km chlorophyll grid is never blurred
 *    under a 1 km temperature field.
 * 3. Every number on screen names its source and the time of the SLICE it came
 *    from. Two sources that disagree about the water temperature both stay in
 *    the list; if one of them is drawn, the readout says which.
 *
 * Why SVG and not a GL layer: for the same reason the colony chips and the
 * flight tracks are SVG. A DOM overlay renders under any GL backend — software,
 * headless, a laptop whose driver gave up — and this layer is the one that has
 * to survive a field machine. It also makes rule 1 exact: the rectangle is
 * literally the projection of the cell's corners, not a styled approximation.
 *
 * The map instance is handed in and is only ever read from (project, bounds,
 * zoom, events). This component adds nothing to the map's style and removes
 * nothing from it, so switching the layer on cannot disturb a count, a chip or
 * the pin.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useEnvStore, layerKey, nowIso } from "@/store/useEnvStore";
import { useFootageStore } from "@/store/useFootageStore";
import { useT, type I18nKey } from "@/lib/i18n";
import {
  formatSliceTime,
  halfCellDegLat,
  formatValue,
  iceClassKeyFor,
  isoToInputUtc,
  inputUtcToIso,
  latencyKeyFor,
  legibleZoom,
  metresPerDegLng,
  metresPerPixel,
  rampColour,
  rampFor,
  rampFromRange,
  sourceKeyFor,
  unitKeyFor,
  varKeyFor,
  ICE_CLASS_COLOURS,
  type EnvCell,
  type EnvGridLayer,
  type EnvMissing,
  type Ramp,
} from "@/lib/env";

/* One hour, in milliseconds — the step the time control moves by. */
const HOUR = 3600_000;

/** Under this many pixels a cell cannot be seen, let alone read, and the layer
 *  switches to sample markers instead of pretending to draw an area. */
const MIN_CELL_PX = 4;

/** A field that can honestly be drawn as coloured cells: measured at a point,
 *  with a real footprint, and not a direction (a bearing has no colour scale —
 *  wind_dir is drawn as arrows or not at all). */
const drawableField = (l: EnvGridLayer) =>
  l.scope === "point" && l.var !== "wind_dir" && !!l.resolution_m && l.cells.length > 0;

/** Server reasons are a small closed set; anything else (a live-fetch error)
 *  is real text about a real failure and is shown as it came. */
function missingReasonKey(reason: string): I18nKey | null {
  const r = (reason || "").toLowerCase();
  if (r.includes("the other atmospheric source covers it")) return "env.missing.otherSource";
  if (r.startsWith("no stored")) return "env.missing.noStored";
  if (r.includes("no value")) return "env.missing.noValue";
  return null;
}

/** One cell, projected. `w`/`h` are the true footprint in pixels; when they
 *  fall under the legibility floor the mark is drawn as a dot instead. */
type CellMark = { x: number; y: number; w: number; h: number; v: number; lat: number; lng: number };

export default function EnvLayer({ map }: { map: any }) {
  const { t, tp } = useT();
  const enabled = useEnvStore((s) => s.enabled);
  const time = useEnvStore((s) => s.time);
  const field = useEnvStore((s) => s.field);
  const wind = useEnvStore((s) => s.wind);
  const grid = useEnvStore((s) => s.grid);
  const loading = useEnvStore((s) => s.loading);
  const error = useEnvStore((s) => s.error);
  const loadedFor = useEnvStore((s) => s.loadedFor);
  const probe = useEnvStore((s) => s.probe);
  const probeLoading = useEnvStore((s) => s.probeLoading);
  const probeError = useEnvStore((s) => s.probeError);
  const setTime = useEnvStore((s) => s.setTime);
  const setField = useEnvStore((s) => s.setField);
  const setWind = useEnvStore((s) => s.setWind);
  const load = useEnvStore((s) => s.load);
  const probeAt = useEnvStore((s) => s.probeAt);
  const clearProbe = useEnvStore((s) => s.clearProbe);

  const selectedId = useFootageStore((s) => s.selectedId);
  const footages = useFootageStore((s) => s.footages);

  const [zoom, setZoom] = useState<number | null>(null);
  const [marks, setMarks] = useState<CellMark[]>([]);
  const [arrows, setArrows] = useState<Array<{ x: number; y: number; ms: number; dir: number }>>([]);
  const [hover, setHover] = useState<{ x: number; y: number; cell: EnvCell } | null>(null);

  /* ------------------------------------------------------ what is drawn */

  const fields = useMemo(() => {
    const ls = (grid?.layers ?? []).filter(drawableField);
    /* Finest footprint first: the layer that resolves the most is the one a
       reader most likely means. The source is still named, and MUR and
       CoralTemp both stay in the list as separate entries. */
    return ls
      .slice()
      .sort((a, b) => a.resolution_m! - b.resolution_m! || a.source.localeCompare(b.source));
  }, [grid]);

  const chosen = useMemo(() => {
    if (!fields.length) return null;
    if (field) {
      const hit = fields.find((l) => layerKey(l.source, l.var) === field);
      if (hit) return hit;
    }
    return fields[0];
  }, [fields, field]);

  /** The scale the chosen field is painted with. A published ramp where one
   *  exists; otherwise this slice's own min–max, and the legend says so. */
  const scale = useMemo((): { ramp: Ramp; ownRange: boolean } | null => {
    if (!chosen || chosen.var === "ice_class") return null;
    const fixed = rampFor(chosen.var);
    if (fixed) return { ramp: fixed, ownRange: false };
    let min = Infinity, max = -Infinity;
    for (const c of chosen.cells) {
      if (c.value < min) min = c.value;
      if (c.value > max) max = c.value;
    }
    if (!Number.isFinite(min)) return null;
    return { ramp: rampFromRange(min, max), ownRange: true };
  }, [chosen]);

  /** Ice classes are an enum, not a scale: there is no half way between land
   *  and sea ice. Everything else reads off the ramp. */
  const colourOf = useCallback(
    (v: number) => {
      if (!chosen) return "#6b8fa8";
      if (chosen.var === "ice_class") return ICE_CLASS_COLOURS[Math.round(v)] ?? "#6b8fa8";
      return scale ? rampColour(scale.ramp, v) : "#6b8fa8";
    },
    [chosen, scale],
  );

  /** The zoom at which one cell of the chosen field is finally worth drawing,
   *  computed at the latitude of the cells we actually hold. */
  const zLegible = useMemo(() => {
    if (!chosen?.resolution_m || !chosen.cells.length) return null;
    const lat = chosen.cells[Math.floor(chosen.cells.length / 2)].lat;
    return legibleZoom(chosen.resolution_m, lat, MIN_CELL_PX);
  }, [chosen]);

  const cellsTooSmall = zLegible != null && zoom != null && zoom < zLegible;

  /** Wind needs both speed and bearing from the SAME source at the SAME slice.
   *  Two sources spliced into one arrow would be a vector nobody measured. */
  const windField = useMemo(() => {
    const ls = grid?.layers ?? [];
    for (const speed of ls) {
      if (speed.var !== "wind_ms") continue;
      const dir = ls.find(
        (l) =>
          l.var === "wind_dir" && l.source === speed.source && l.measured_at === speed.measured_at,
      );
      if (!dir) continue;
      const byCell = new Map<string, number>();
      for (const c of dir.cells) byCell.set(`${c.lat},${c.lng}`, c.value);
      const pts: Array<{ lat: number; lng: number; ms: number; dir: number }> = [];
      for (const c of speed.cells) {
        const d = byCell.get(`${c.lat},${c.lng}`);
        if (d == null) continue; // a speed with no bearing is not an arrow
        pts.push({ lat: c.lat, lng: c.lng, ms: c.value, dir: d });
      }
      if (pts.length) return { layer: speed, pts };
    }
    return null;
  }, [grid]);

  /** Ice thickness, for the hover readout over an ice cell. Absent far more
   *  often than not — a VIIRS gap is usually cloud — and the readout says so
   *  rather than letting a blank read as "no ice". */
  const thicknessLayer = useMemo(
    () => (grid?.layers ?? []).find((l) => l.var === "ice_thickness_m") ?? null,
    [grid],
  );

  /** Figures that describe the whole sea rather than a place — sea level. Never
   *  drawn as a cell: a basin figure stored at one altimetry crossing is not a
   *  measurement of that crossing. Listed in the panel instead. */
  const basinLayers = useMemo(
    () => (grid?.layers ?? []).filter((l) => l.scope === "basin" && l.cells.length > 0),
    [grid],
  );

  /* --------------------------------------------------------- projection */

  /* One rAF pass projects everything the overlay draws: the cells' corners,
     the wind arrows and the live zoom. MapLibre fires `move` once per frame
     while dragging, and rAF parks the work entirely when the tab is in the
     background. Nothing runs at all while the layer is off. */
  useEffect(() => {
    if (!map || !enabled) {
      setMarks([]);
      setArrows([]);
      return;
    }
    let frame = 0;
    const update = () => {
      frame = 0;
      try {
        const z = map.getZoom();
        setZoom(z);

        let rect: { width: number; height: number } | null = null;
        try { rect = map.getCanvas().getBoundingClientRect(); } catch {}
        /* Cull in world coordinates first: at basin zoom most of a layer is
           off screen, and projecting it would be two matrix multiplies per
           cell for nothing. */
        let b: any = null;
        try { b = map.getBounds(); } catch {}
        const inView = (lat: number, lng: number) =>
          !b ||
          (lat >= b.getSouth() - 1 && lat <= b.getNorth() + 1 &&
            lng >= b.getWest() - 1 && lng <= b.getEast() + 1);

        if (chosen?.resolution_m) {
          const res = chosen.resolution_m;
          const dLat = halfCellDegLat(res);
          const out: CellMark[] = [];
          for (const c of chosen.cells) {
            if (!inView(c.lat, c.lng)) continue;
            const dLng = res / 2 / metresPerDegLng(c.lat);
            const sw = map.project([c.lng - dLng, c.lat - dLat]);
            const ne = map.project([c.lng + dLng, c.lat + dLat]);
            const x = Math.min(sw.x, ne.x), y = Math.min(sw.y, ne.y);
            const w = Math.abs(ne.x - sw.x), h = Math.abs(sw.y - ne.y);
            if (rect && (x > rect.width + 8 || y > rect.height + 8 || x + w < -8 || y + h < -8))
              continue;
            out.push({ x, y, w, h, v: c.value, lat: c.lat, lng: c.lng });
          }
          setMarks((prev) => (sameMarks(prev, out) ? prev : out));
        } else {
          setMarks((prev) => (prev.length ? [] : prev));
        }

        if (!wind || !windField) {
          setArrows((prev) => (prev.length ? [] : prev));
        } else {
          const out: Array<{ x: number; y: number; ms: number; dir: number }> = [];
          for (const p of windField.pts) {
            if (!inView(p.lat, p.lng)) continue;
            const pr = map.project([p.lng, p.lat]);
            if (rect && (pr.x < -60 || pr.x > rect.width + 60 || pr.y < -60 || pr.y > rect.height + 60))
              continue;
            out.push({ x: pr.x, y: pr.y, ms: p.ms, dir: p.dir });
          }
          setArrows((prev) => (sameArrows(prev, out) ? prev : out));
        }
      } catch { /* torn down mid-frame; the next event retries */ }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    map.on("move", schedule);
    map.on("zoom", schedule);
    map.on("resize", schedule);
    map.on("idle", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      try {
        map.off("move", schedule);
        map.off("zoom", schedule);
        map.off("resize", schedule);
        map.off("idle", schedule);
      } catch {}
    };
  }, [map, enabled, chosen, wind, windField]);

  /* Hover and click are hit-tested in world coordinates against the cells we
     hold, rather than by making the overlay catch pointer events — an overlay
     that catches them would swallow the drag that starts on top of a cell and
     the map would stop panning wherever the environment happened to be. */
  const hitTest = useCallback(
    (lng: number, lat: number): EnvCell | null => {
      if (!chosen?.resolution_m) return null;
      /* At low zoom the cell is smaller than the mark, so the target is the
         mark: a few pixels' worth of ground, never less than half a cell. */
      const px = zoom != null ? metresPerPixel(zoom, lat) : 0;
      const reach = Math.max(chosen.resolution_m / 2, 6 * px);
      const dLat = reach / 111320; // the hit target, in degrees of latitude
      const dLng = reach / metresPerDegLng(lat);
      let best: EnvCell | null = null;
      let bestD = Infinity;
      for (const c of chosen.cells) {
        if (Math.abs(c.lat - lat) > dLat || Math.abs(c.lng - lng) > dLng) continue;
        const d = Math.abs(c.lat - lat) + Math.abs(c.lng - lng);
        if (d < bestD) { bestD = d; best = c; }
      }
      return best;
    },
    [chosen, zoom],
  );

  useEffect(() => {
    if (!map || !enabled) {
      setHover(null);
      return;
    }
    const onMove = (e: any) => {
      const c = hitTest(e.lngLat.lng, e.lngLat.lat);
      setHover(c ? { x: e.point.x, y: e.point.y, cell: c } : null);
    };
    const onOut = () => setHover(null);
    const onClick = (e: any) => {
      if (useFootageStore.getState().pinMode) return; // the click belongs to the pin
      const c = hitTest(e.lngLat.lng, e.lngLat.lat);
      if (c) void probeAt(c.lat, c.lng);
    };
    try {
      map.on("mousemove", onMove);
      map.on("mouseout", onOut);
      map.on("click", onClick);
    } catch {}
    return () => {
      try {
        map.off("mousemove", onMove);
        map.off("mouseout", onOut);
        map.off("click", onClick);
      } catch {}
    };
  }, [map, enabled, hitTest, probeAt]);

  /* The grid for the current moment. The store aborts an in-flight request and
     keeps only the newest, so switching moments quickly cannot land an old
     slice under a new label. */
  useEffect(() => {
    if (enabled && !grid && !loading && !error) void load();
  }, [enabled, grid, loading, error, load]);

  /* ------------------------------------------------------------ actions */

  const shift = useCallback(
    (ms: number) => {
      const base = time ?? loadedFor ?? nowIso();
      setTime(new Date(new Date(base).getTime() + ms).toISOString().replace(/\.\d{3}Z$/, "Z"));
    },
    [time, loadedFor, setTime],
  );

  /** The moment the selected sortie was flown, when it recorded one. A sortie
   *  with no date has none to offer and the button does not appear — inventing
   *  one from the upload time would put a 2019 flight on today's weather. */
  const selectedCapturedAt = useMemo(() => {
    if (!selectedId) return null;
    const f = footages.find((x) => x.id === selectedId);
    const c = f?.capturedAt;
    return c && Number.isFinite(new Date(c).getTime()) ? c : null;
  }, [selectedId, footages]);

  /** Take the camera to where a cell can actually be seen. Zooming in place
   *  would usually land on empty water: the samples are half a degree apart,
   *  so at the zoom where a 1 km cell is legible the odds of one being under
   *  the centre are small. The nearest cell to the current centre is the
   *  honest destination — and it is a real measurement, not a chosen one. */
  const zoomToCells = useCallback(() => {
    if (!map || zLegible == null || !chosen?.cells.length) return;
    try {
      const c0 = map.getCenter();
      let best = chosen.cells[0];
      let bestD = Infinity;
      for (const c of chosen.cells) {
        const d = Math.abs(c.lat - c0.lat) + Math.abs(c.lng - c0.lng);
        if (d < bestD) { bestD = d; best = c; }
      }
      /* Past the legibility floor rather than onto it: at exactly `zLegible`
         the cell is four pixels, which proves the point and cannot be read. */
      map.easeTo({ center: [best.lng, best.lat], zoom: zLegible + 1.5, duration: 520 });
    } catch {}
  }, [map, zLegible, chosen]);

  const unitOf = useCallback(
    (v: string) => {
      const k = unitKeyFor(v);
      return k ? t(k) : "";
    },
    [t],
  );

  const readValue = useCallback(
    (v: string, n: number) =>
      v === "ice_class" ? t(iceClassKeyFor(n)) : `${formatValue(v, n)} ${unitOf(v)}`.trim(),
    [t, unitOf],
  );

  if (!enabled) return null;

  const requested = time ?? loadedFor ?? nowIso();
  const isIce = chosen?.var === "ice_class";
  const hoverThickness =
    hover && isIce && thicknessLayer ? nearestValue(thicknessLayer, hover.cell.lat, hover.cell.lng) : null;

  return (
    <>
      {/* The layer itself. Cells at their true footprint; below the zoom where
          that is a visible thing, sample markers instead — and the panel says
          which of the two is on screen. Never pointer-catching: the map keeps
          every drag that starts over a cell. */}
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none z-[4]"
        style={{ overflow: "hidden" }}
        data-env-cells={marks.length}
        data-env-arrows={arrows.length}
      >
        <g data-env-marks>
          {marks.map((m, i) => {
            const fill = colourOf(m.v);
            const big = m.w >= MIN_CELL_PX && m.h >= MIN_CELL_PX;
            const ice3 = isIce && Math.round(m.v) === 3;
            return big ? (
              <rect
                key={i}
                x={m.x}
                y={m.y}
                width={m.w}
                height={m.h}
                fill={fill}
                fillOpacity={0.72}
                stroke={ice3 ? "#eaf7ff" : "rgba(255,255,255,0.16)"}
                strokeWidth={ice3 ? 1.2 : 0.4}
              />
            ) : (
              /* A sample marker: fixed size, deliberately round so it cannot be
                 mistaken for a cell, and stated as such in the panel. */
              <circle
                key={i}
                cx={m.x + m.w / 2}
                cy={m.y + m.h / 2}
                r={2.6}
                fill={fill}
                fillOpacity={0.95}
                stroke={ice3 ? "#eaf7ff" : "rgba(0,0,0,0.55)"}
                strokeWidth={0.7}
              />
            );
          })}
        </g>
        {/* Wind: arrows on the coarse grid the model actually publishes,
            rotated by the measured bearing and scaled by the measured speed —
            never a heatmap, which would paint speed over water nobody sampled. */}
        <g data-env-wind>
          {arrows.map((a, i) => (
            <ArrowShape key={i} x={a.x} y={a.y} ms={a.ms} dir={a.dir} />
          ))}
        </g>
      </svg>

      {/* The readout. Everything drawn is named here: the source, the slice it
          was measured at, how far that is from the moment asked for, the size
          of one cell and how far apart the cells we hold are. */}
      <div
        className="absolute top-12 left-3 z-10 w-[300px] max-h-[calc(100%-4.5rem)] overflow-auto bg-surface border border-line rounded shadow-pop p-2 text-2xs text-ink2"
        data-testid="env-panel"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-ink">{t("env.title")}</span>
          {loading && <span className="text-ink3">{t("env.map.loading")}</span>}
        </div>

        {/* The moment. The layer answers for this instant and nothing else. */}
        <label className="block mt-2 text-ink3" htmlFor="env-time">{t("env.map.timeUtc")}</label>
        <div className="flex items-center gap-1 mt-0.5">
          <input
            id="env-time"
            type="datetime-local"
            data-testid="env-time"
            value={isoToInputUtc(requested)}
            onChange={(e) => setTime(inputUtcToIso(e.target.value))}
            className="flex-1 h-6 bg-surface2 border border-line rounded px-1 text-2xs text-ink font-mono focus:outline-none focus:border-ink3"
          />
          <button
            onClick={() => setTime(null)}
            className="h-6 px-1.5 rounded border border-line bg-surface2 text-2xs text-ink2 hover:text-ink"
          >
            {t("env.map.now")}
          </button>
        </div>
        <div className="flex items-center gap-1 mt-1 flex-wrap">
          <StepBtn onClick={() => shift(-24 * HOUR)} label={t("env.map.backDay")} />
          <StepBtn onClick={() => shift(-6 * HOUR)} label={t("env.map.backHours")} />
          <StepBtn onClick={() => shift(6 * HOUR)} label={t("env.map.fwdHours")} />
          <StepBtn onClick={() => shift(24 * HOUR)} label={t("env.map.fwdDay")} />
          {selectedCapturedAt && (
            <StepBtn
              onClick={() =>
                setTime(new Date(selectedCapturedAt).toISOString().replace(/\.\d{3}Z$/, "Z"))
              }
              label={t("env.map.toSurvey")}
            />
          )}
        </div>

        {error && (
          <div className="mt-2 text-bad leading-tight">
            {t("env.map.failed", { msg: error })}{" "}
            <button onClick={() => void load()} className="underline hover:text-ink">
              {t("env.map.retry")}
            </button>
          </div>
        )}

        {/* The field drawn as cells. Source and variable together — MUR and
            CoralTemp are separate entries because they are separate claims. */}
        <label className="block mt-2 text-ink3" htmlFor="env-field">{t("env.map.field")}</label>
        <select
          id="env-field"
          data-testid="env-field"
          value={chosen ? layerKey(chosen.source, chosen.var) : ""}
          onChange={(e) => setField(e.target.value || null)}
          disabled={!fields.length}
          className="w-full h-6 mt-0.5 bg-surface2 border border-line rounded px-1 text-2xs text-ink focus:outline-none focus:border-ink3"
        >
          {!fields.length && <option value="">{t("env.map.noField")}</option>}
          {fields.map((l) => (
            <option key={layerKey(l.source, l.var)} value={layerKey(l.source, l.var)}>
              {t(varKeyFor(l.var))} · {t(sourceKeyFor(l.source))}
            </option>
          ))}
        </select>

        {chosen ? (
          <div className="mt-2 border-t border-line pt-2 leading-tight" data-testid="env-readout">
            <div className="text-ink">{t(varKeyFor(chosen.var))}</div>
            <div className="text-ink2">
              {t("env.source")}: {t(sourceKeyFor(chosen.source))}
            </div>
            <div className="text-ink3 font-mono">{chosen.dataset}</div>
            <div className="text-ink2">
              {t("env.slice", { time: formatSliceTime(chosen.measured_at) })}
              {" · "}
              <span className={chosen.gap_hours > 24 ? "text-bad" : "text-ink3"}>
                {t("env.ageHours", { n: Math.round(chosen.gap_hours) })}
              </span>
            </div>
            <div className="text-ink3">
              {t("env.cellSize")}: {chosen.resolution} · {chosen.count}{" "}
              {tp(chosen.count, "env.map.cellsUnit")}
            </div>
            {chosen.spacing_deg != null && (
              <div className="text-ink3">{t("env.spacing", { deg: chosen.spacing_deg })}</div>
            )}
            <div className="text-ink3">
              {t("env.latency")}: {t(latencyKeyFor(chosen.source))}
            </div>
            <div className="text-ink3 mt-1">
              {cellsTooSmall && zLegible != null
                ? t("env.map.tooSmall", { z: zLegible.toFixed(1) })
                : t("env.map.trueSize")}
            </div>
            {cellsTooSmall && zLegible != null && (
              <button
                onClick={zoomToCells}
                className="mt-1 h-5 px-1.5 rounded border border-line bg-surface2 text-2xs text-ink2 hover:text-ink"
              >
                {t("env.map.zoomTo", { z: zLegible.toFixed(1) })}
              </button>
            )}

            {/* The legend. A colour that cannot be read back as a number is
                decoration, so the stops are printed with their values. */}
            <div className="mt-2 text-ink3">{t("env.map.legend")}</div>
            {isIce ? (
              <div className="mt-0.5 space-y-0.5">
                {/* Sea and sea ice only. The chart classifies land as well,
                    and the point probe still reports it — but the basin layer
                    no longer draws land cells, so listing them here would
                    describe a colour that is not on the map. */}
                {[3, 1].map((c) => (
                  <div key={c} className="flex items-center gap-1.5">
                    <span
                      className="inline-block w-3 h-3 rounded-[2px]"
                      style={{
                        background: ICE_CLASS_COLOURS[c],
                        boxShadow:
                          c === 3 ? "0 0 0 1px #eaf7ff" : "0 0 0 1px rgba(255,255,255,0.12)",
                      }}
                    />
                    <span className={c === 3 ? "text-ink" : "text-ink2"}>
                      {t(iceClassKeyFor(c))}
                      {c === 3 ? ` · ${t("env.map.iceEdge")}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            ) : scale ? (
              <div className="mt-0.5">
                <div className="flex">
                  {scale.ramp.stops.map(([v, c], i) => (
                    <span
                      key={i}
                      className="flex-1 h-2.5"
                      style={{ background: c }}
                      title={`${formatValue(chosen.var, v)} ${unitOf(chosen.var)}`}
                    />
                  ))}
                </div>
                <div className="flex justify-between text-ink3 font-mono mt-0.5">
                  <span>{formatValue(chosen.var, scale.ramp.stops[0][0])}</span>
                  <span>
                    {formatValue(chosen.var, scale.ramp.stops[scale.ramp.stops.length - 1][0])}{" "}
                    {unitOf(chosen.var)}
                  </span>
                </div>
                {scale.ownRange && <div className="text-ink3">{t("env.map.scaleSlice")}</div>}
              </div>
            ) : null}
            <div className="text-ink3 mt-1">{t("env.map.probeHint")}</div>
          </div>
        ) : (
          <div className="mt-2 border-t border-line pt-2 text-ink3" data-testid="env-readout">
            {t("env.map.noLayer")}
          </div>
        )}

        {/* Wind, its own source and its own slice — not the field's. */}
        <div className="mt-2 border-t border-line pt-2">
          <label className="flex items-center gap-1.5 text-ink2">
            <input
              type="checkbox"
              data-testid="env-wind"
              checked={wind}
              onChange={(e) => setWind(e.target.checked)}
            />
            {t("env.map.wind")}
          </label>
          {wind &&
            (windField ? (
              <div className="mt-1 leading-tight">
                <div className="text-ink2">{t(sourceKeyFor(windField.layer.source))}</div>
                <div className="text-ink2">
                  {t("env.slice", { time: formatSliceTime(windField.layer.measured_at) })}
                  {" · "}
                  <span className={windField.layer.gap_hours > 24 ? "text-bad" : "text-ink3"}>
                    {t("env.ageHours", { n: Math.round(windField.layer.gap_hours) })}
                  </span>
                </div>
                <div className="text-ink3">
                  {t("env.cellSize")}: {windField.layer.resolution} · {arrows.length}{" "}
                  {tp(arrows.length, "env.map.arrowsUnit")}
                </div>
                <div className="text-ink3">{t("env.map.windHow")}</div>
                <div className="flex items-end gap-3 mt-1">
                  {[5, 10].map((ms) => (
                    <div key={ms} className="flex items-center gap-1">
                      <svg width={arrowLen(ms) + 8} height={14} style={{ overflow: "visible" }}>
                        <ArrowShape x={arrowLen(ms) / 2 + 4} y={7} ms={ms} dir={270} />
                      </svg>
                      <span className="text-ink3">{t("env.map.windRef", { n: ms })}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mt-1 text-ink3">{t("env.map.noLayer")}</div>
            ))}
        </div>

        {/* Whole-sea figures. Never drawn as a cell: sea level is one number
            for the entire Caspian, not a measurement of the altimetry crossing
            it happens to be stored at. */}
        {basinLayers.length > 0 && (
          <div className="mt-2 border-t border-line pt-2 leading-tight">
            <div className="text-ink3">{t("env.map.basin")}</div>
            {basinLayers.map((l) => (
              <div key={layerKey(l.source, l.var)} className="mt-0.5">
                <span className="text-ink">
                  {t(varKeyFor(l.var))}: {readValue(l.var, l.cells[0].value)}
                </span>
                <div className="text-ink3">
                  {t(sourceKeyFor(l.source))} ·{" "}
                  {t("env.slice", { time: formatSliceTime(l.measured_at) })} ·{" "}
                  {t("env.ageHours", { n: Math.round(l.gap_hours) })}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* What was not measured, said out loud. A gap is never a zero and
            never an omitted row. */}
        {!!grid?.missing?.length && (
          <div className="mt-2 border-t border-line pt-2 leading-tight" data-testid="env-missing">
            <div className="text-ink3">{t("env.missing")}</div>
            {grid.missing.map((m, i) => (
              <div key={i} className="mt-0.5">
                <span className="text-ink2">{missingLabel(m, t)}</span>
                <div className="text-ink3">{reasonText(m.reason, t)}</div>
              </div>
            ))}
            <div className="text-ink3 mt-1">{t("env.missing.note")}</div>
          </div>
        )}

        {/* Every source at one point — the place where MUR and CoralTemp are
            allowed to disagree in public. */}
        {(probe || probeLoading || probeError) && (
          <div className="mt-2 border-t border-line pt-2 leading-tight" data-testid="env-probe">
            <div className="flex items-center justify-between">
              <span className="text-ink">{t("env.map.probe")}</span>
              <button onClick={clearProbe} className="text-ink3 hover:text-ink">
                {t("env.map.probeClose")}
              </button>
            </div>
            {probeLoading && <div className="text-ink3">{t("env.map.loading")}</div>}
            {probeError && (
              <div className="text-bad">{t("env.map.failed", { msg: probeError })}</div>
            )}
            {probe && (
              <>
                <div className="text-ink3 font-mono">
                  {probe.point.lat.toFixed(3)}, {probe.point.lng.toFixed(3)}
                </div>
                {probe.samples.map((s) => (
                  <div key={s.source} className="mt-1">
                    <div className="text-ink2">{t(sourceKeyFor(s.source))}</div>
                    {Object.entries(s.values).map(([v, n]) => (
                      <div key={v} className="text-ink">
                        {t(varKeyFor(v))}: {readValue(v, n)}
                      </div>
                    ))}
                    <div className="text-ink3">
                      {t("env.slice", { time: formatSliceTime(s.measured_at) })} ·{" "}
                      {t("env.ageHours", { n: Math.round(s.gap_hours) })} ·{" "}
                      {s.scope === "basin"
                        ? t("env.scope.basin")
                        : t("env.distanceKm", { km: s.distance_km })}
                    </div>
                  </div>
                ))}
                {probe.missing.map((m, i) => (
                  <div key={`m${i}`} className="mt-1">
                    <div className="text-ink3">
                      {missingLabel(m, t)} — {t("env.missing")}
                    </div>
                    <div className="text-ink3">{reasonText(m.reason, t)}</div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {/* Hover: the one cell under the cursor, with its own value and, on the
          ice layer, the thickness reading if VIIRS has one for that moment. */}
      {hover && chosen && (
        <div
          className="absolute z-[8] pointer-events-none bg-surface border border-line rounded shadow-pop px-1.5 py-1 text-2xs leading-tight"
          style={{ left: hover.x + 12, top: hover.y + 12, maxWidth: 220 }}
          data-testid="env-hover"
        >
          <div className="text-ink">
            {t(varKeyFor(chosen.var))}: {readValue(chosen.var, hover.cell.value)}
          </div>
          <div className="text-ink3 font-mono">
            {hover.cell.lat.toFixed(3)}, {hover.cell.lng.toFixed(3)}
          </div>
          <div className="text-ink3">
            {t(sourceKeyFor(chosen.source))} ·{" "}
            {t("env.slice", { time: formatSliceTime(chosen.measured_at) })}
          </div>
          {isIce && (
            /* Thickness is a DIFFERENT product from the ice chart under the
               cursor — VIIRS 750 m, a four-day composite — so it carries its
               own source and its own slice, for the same reason the wind
               arrows do: one provenance line cannot stand for two
               measurements, and this one used to print a VIIRS thickness
               under the name of the IMS chart. */
            <div className="text-ink3 mt-0.5 border-t border-line pt-0.5">
              {hoverThickness != null && thicknessLayer ? (
                <>
                  <div>
                    {t(varKeyFor("ice_thickness_m"))}:{" "}
                    {readValue("ice_thickness_m", hoverThickness)}
                  </div>
                  <div>
                    {t(sourceKeyFor(thicknessLayer.source))} ·{" "}
                    {t("env.slice", { time: formatSliceTime(thicknessLayer.measured_at) })}
                  </div>
                </>
              ) : (
                t("env.map.noThickness")
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------- helpers */

/** Arrow length in pixels for a wind speed. Linear in m/s and stated in the
 *  legend by two reference arrows, so the scale can be read off the chart
 *  rather than guessed at. Capped so a storm cannot draw across the basin. */
const arrowLen = (ms: number) => Math.min(60, 14 + ms * 4);

/** The arrow, in screen space. `dir` is meteorological — the bearing the wind
 *  comes FROM — so the shape points the other way, which is where the air is
 *  actually going. Drawn twice: a dark casing first, so a pale arrow stays
 *  legible over pale ice and over dark water alike. */
function ArrowShape({ x, y, ms, dir }: { x: number; y: number; ms: number; dir: number }) {
  const len = arrowLen(ms);
  const rad = ((dir + 180) * Math.PI) / 180;
  const dx = Math.sin(rad) * len;
  const dy = -Math.cos(rad) * len;
  const x0 = x - dx / 2, y0 = y - dy / 2;
  const x1 = x + dx / 2, y1 = y + dy / 2;
  const w = Math.max(1.4, Math.min(3.4, 1.2 + ms / 6));
  const hl = Math.min(9, 5 + ms / 4);
  const ha = 0.42;
  const back = Math.atan2(y1 - y0, x1 - x0) + Math.PI;
  const hx1 = x1 + Math.cos(back - ha) * hl, hy1 = y1 + Math.sin(back - ha) * hl;
  const hx2 = x1 + Math.cos(back + ha) * hl, hy2 = y1 + Math.sin(back + ha) * hl;
  const head = `${hx1},${hy1} ${x1},${y1} ${hx2},${hy2}`;
  return (
    <g>
      <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="#0b0e12" strokeWidth={w + 2} strokeOpacity={0.55} strokeLinecap="round" />
      <polyline points={head} fill="none" stroke="#0b0e12" strokeWidth={w + 2} strokeOpacity={0.55} strokeLinejoin="round" strokeLinecap="round" />
      <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="#e8f3ff" strokeWidth={w} strokeLinecap="round" />
      <polyline points={head} fill="none" stroke="#e8f3ff" strokeWidth={w} strokeLinejoin="round" strokeLinecap="round" />
    </g>
  );
}

function StepBtn({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className="h-5 px-1.5 rounded border border-line bg-surface2 text-2xs text-ink2 hover:text-ink hover:border-ink3 transition-colors"
    >
      {label}
    </button>
  );
}

/** The value of the nearest cell of a layer, or null when the nearest one is
 *  further away than the cell it claims to be — a neighbouring reading is not
 *  a reading here. */
function nearestValue(l: EnvGridLayer, lat: number, lng: number): number | null {
  const reach = ((l.resolution_m ?? 1000) * 1.5) / 1000; // km
  let best: number | null = null;
  let bestKm = Infinity;
  for (const c of l.cells) {
    const dy = (c.lat - lat) * 111.32;
    const dx = ((c.lng - lng) * metresPerDegLng(lat)) / 1000;
    const km = Math.hypot(dx, dy);
    if (km < bestKm) { bestKm = km; best = c.value; }
  }
  return bestKm <= reach ? best : null;
}

/** What a missing row is missing — a whole source, or one variable. */
function missingLabel(m: EnvMissing, t: (k: I18nKey, v?: any) => string): string {
  if (m.vars?.length) return m.vars.map((v) => t(varKeyFor(v))).join(", ");
  if (m.var) return t(varKeyFor(m.var));
  if (m.source) return t(sourceKeyFor(m.source));
  return t("env.missing");
}

/** The service's reasons are a closed set and are translated. Anything else is
 *  a real error message from a real failure and is shown verbatim rather than
 *  flattened into a friendlier sentence that would say less. */
function reasonText(reason: string, t: (k: I18nKey) => string): string {
  const key = missingReasonKey(reason);
  return key ? t(key) : reason;
}

/* The overlay re-projects on every frame of a drag; bail out of the state
   update when the projection has not moved, so React can stay idle. */
function sameMarks(a: CellMark[], b: CellMark[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].v !== b[i].v || a[i].lat !== b[i].lat || a[i].lng !== b[i].lng) return false;
    if (Math.abs(a[i].x - b[i].x) > 0.5 || Math.abs(a[i].y - b[i].y) > 0.5) return false;
    if (Math.abs(a[i].w - b[i].w) > 0.5 || Math.abs(a[i].h - b[i].h) > 0.5) return false;
  }
  return true;
}

function sameArrows(
  a: Array<{ x: number; y: number; ms: number; dir: number }>,
  b: Array<{ x: number; y: number; ms: number; dir: number }>,
) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].ms !== b[i].ms || a[i].dir !== b[i].dir) return false;
    if (Math.abs(a[i].x - b[i].x) > 0.5 || Math.abs(a[i].y - b[i].y) > 0.5) return false;
  }
  return true;
}
