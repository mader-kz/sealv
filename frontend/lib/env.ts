"use client";
/* The environment API, exactly as the service serves it.
 *
 * One rule runs through every type here and it is the reason the shapes look
 * verbose: a value never travels without its source, the time of the SLICE it
 * came from, the size of the cell that was actually measured, and how far that
 * is from what the caller asked for. `values` carries ONLY what was measured —
 * an unmeasured variable is ABSENT from the object, never zero — so every
 * reader must treat `undefined` as "not measured" and render it as missing.
 *
 * Nothing in this module averages, interpolates or picks a winner between two
 * sources. MUR (1 km, two days old) and CoralTemp (5 km, same day) disagree
 * about the water temperature; both are returned, and the UI names whichever
 * one it draws.
 */

import type { I18nKey } from "./i18n";

const API = process.env.NEXT_PUBLIC_API_BASE ?? "";

export type EnvScope = "point" | "basin";

/** One row of the source catalogue — returned by every endpoint, always all
 *  nine, so a source with no data still has a name and a latency note to show
 *  next to its "no data". */
export type EnvSourceInfo = {
  source: string;
  dataset: string;
  vars: string[];
  /** The footprint of ONE measured cell, in metres. Null for a basin figure. */
  resolution_m: number | null;
  /** The same thing in words, from the service ("0.01° (~1 km)"). */
  resolution: string;
  scope: EnvScope;
  latency_note: string;
};

/** Everything one source measured at one point and one moment. */
export type EnvSample = {
  source: string;
  dataset: string;
  /** The slice's own time. NOT the time that was asked for. */
  measured_at: string;
  /** The CELL CENTRE the service returned, not the requested coordinate. */
  lat: number;
  lng: number;
  values: Record<string, number>;
  resolution_m: number | null;
  resolution: string;
  scope: EnvScope;
  latency_note: string;
  fetched_at?: string;
  /** |measured_at − requested|, hours. */
  gap_hours: number;
  /** Cell centre to the requested point, km. Genuinely large for a basin
   *  figure — that is what `scope: "basin"` is for. */
  distance_km: number;
};

export type EnvMissing = { source?: string; var?: string; vars?: string[]; reason: string };

export type EnvAt = {
  point: { lat: number; lng: number };
  time: string;
  radius_km: number;
  max_gap_h: number;
  max_gap_basin_h: number;
  live: boolean;
  samples: EnvSample[];
  missing: EnvMissing[];
  sources: EnvSourceInfo[];
};

export type EnvCell = { lat: number; lng: number; value: number };

/** One (source, var) pair at one slice. Never merged with another layer: a
 *  9 km chlorophyll cell and a 1 km temperature cell are different claims
 *  about different areas and drawing them as one field would invent data. */
export type EnvGridLayer = {
  source: string;
  dataset: string;
  var: string;
  /** One slice for the whole layer — every cell in it shares this time. */
  measured_at: string;
  gap_hours: number;
  /** How wide one MEASURED cell is. This is what gets drawn. */
  resolution_m: number | null;
  resolution: string;
  scope: EnvScope;
  latency_note: string;
  /** How far apart the samples we hold are — much coarser than the cell. The
   *  collector samples real product cells and spaces them out; nothing between
   *  them was measured, and nothing here fills that in. Null when the layer is
   *  a single cell (no spacing to state). */
  spacing_deg: number | null;
  count: number;
  cells: EnvCell[];
};

export type EnvGrid = {
  time: string;
  vars: string[];
  max_gap_h: number;
  layers: EnvGridLayer[];
  missing: EnvMissing[];
  sources: EnvSourceInfo[];
};

async function jsonOrThrow(r: Response): Promise<any> {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || d.detail || `${r.status} ${r.statusText}`);
  return d;
}

export type EnvGridQuery = {
  /** ISO 8601. Omitted = now. The service accepts future times: the
   *  atmospheric feeds are forecasts. */
  time?: string | null;
  vars?: string[];
  maxGapH?: number;
  limit?: number;
  signal?: AbortSignal;
};

export async function fetchEnvGrid(q: EnvGridQuery = {}): Promise<EnvGrid> {
  const p = new URLSearchParams();
  if (q.time) p.set("time", q.time);
  if (q.vars?.length) p.set("vars", q.vars.join(","));
  if (q.maxGapH != null) p.set("max_gap_h", String(q.maxGapH));
  if (q.limit != null) p.set("limit", String(q.limit));
  const qs = p.toString();
  const d = await jsonOrThrow(
    await fetch(`${API}/v1/env/grid${qs ? `?${qs}` : ""}`, { signal: q.signal }),
  );
  return {
    time: d.time,
    vars: d.vars ?? [],
    max_gap_h: d.max_gap_h,
    layers: Array.isArray(d.layers) ? d.layers : [],
    missing: Array.isArray(d.missing) ? d.missing : [],
    sources: Array.isArray(d.sources) ? d.sources : [],
  };
}

export type EnvAtQuery = {
  lat: number;
  lng: number;
  time?: string | null;
  radiusKm?: number;
  signal?: AbortSignal;
  /* `live` is deliberately not exposed here. It makes the service go out to
     eight third parties and can take two minutes; it belongs to a deliberate
     "collect this coordinate" action, never to a map interaction. */
};

export async function fetchEnvAt(q: EnvAtQuery): Promise<EnvAt> {
  const p = new URLSearchParams({ lat: String(q.lat), lng: String(q.lng) });
  if (q.time) p.set("time", q.time);
  if (q.radiusKm != null) p.set("radius_km", String(q.radiusKm));
  const d = await jsonOrThrow(await fetch(`${API}/v1/env/at?${p}`, { signal: q.signal }));
  return {
    ...d,
    samples: Array.isArray(d.samples) ? d.samples : [],
    missing: Array.isArray(d.missing) ? d.missing : [],
    sources: Array.isArray(d.sources) ? d.sources : [],
  } as EnvAt;
}

/* ------------------------------------------------------------- geometry */

/** Metres per degree of latitude. Constant enough for a cell footprint; the
 *  error over the Caspian's span is well under one metre in a thousand. */
const M_PER_DEG_LAT = 111320;

export const metresPerDegLng = (lat: number) =>
  Math.max(1, M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));

/** Half the height of a measured cell, in degrees of latitude. The renderer
 *  projects the cell's corners rather than styling an approximation, so a
 *  1 km cell is a 1 km square on the chart — at basin zoom that is half a
 *  pixel, and that is the honest picture. */
export const halfCellDegLat = (resolutionM: number) => resolutionM / 2 / M_PER_DEG_LAT;

/** Ground metres one screen pixel covers, Web Mercator. */
export const metresPerPixel = (zoom: number, lat: number) =>
  (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);

/** The zoom at which one measured cell is finally `minPx` pixels wide — i.e.
 *  the first zoom at which drawing the cell at true size says anything. Below
 *  it the layer draws sample MARKERS instead, and the panel says so. */
export function legibleZoom(resolutionM: number, lat: number, minPx = 4): number {
  const z = Math.log2((minPx * 156543.03392 * Math.cos((lat * Math.PI) / 180)) / resolutionM);
  return Math.round(z * 10) / 10;
}

/* --------------------------------------------------------------- values */

/** Decimal places each measurable is worth printing. A wind direction to one
 *  decimal claims a precision the model does not have; a wave height to zero
 *  throws the whole signal away. */
const DECIMALS: Record<string, number> = {
  wind_ms: 1,
  wind_dir: 0,
  gust_ms: 1,
  air_t: 1,
  pressure: 0,
  cloud: 0,
  wave_m: 2,
  wave_period_s: 1,
  sst_c: 1,
  sst_anomaly_c: 1,
  ice_class: 0,
  ice_conc: 2,
  ice_thickness_m: 2,
  chl_a: 2,
  sea_level_m: 2,
};

/** The unit key for a measurable, or null where the number carries none
 *  (ice_class is an enum, ice_conc is a 0..1 fraction). */
const UNIT_KEY: Record<string, string | null> = {
  wind_ms: "env.unit.ms",
  wind_dir: "env.unit.deg",
  gust_ms: "env.unit.ms",
  air_t: "env.unit.celsius",
  pressure: "env.unit.hpa",
  cloud: "env.unit.percent",
  wave_m: "env.unit.m",
  wave_period_s: "env.unit.s",
  sst_c: "env.unit.celsius",
  sst_anomaly_c: "env.unit.celsius",
  ice_class: null,
  ice_conc: null,
  ice_thickness_m: "env.unit.m",
  chl_a: "env.unit.chl",
  sea_level_m: "env.unit.m",
};

export const decimalsFor = (v: string) => DECIMALS[v] ?? 2;
export const unitKeyFor = (v: string): I18nKey | null => UNIT_KEY[v] as I18nKey | null;
export const varKeyFor = (v: string) => `env.var.${v}` as I18nKey;
export const sourceKeyFor = (s: string) => `env.source.${s}` as I18nKey;
export const latencyKeyFor = (s: string) => `env.latency.${s}` as I18nKey;
export const iceClassKeyFor = (c: number) => `env.iceClass.${Math.round(c)}` as I18nKey;

export const formatValue = (v: string, n: number) => n.toFixed(decimalsFor(v));

/** A slice's own time, printed in UTC. Local time on a map that spans one sea
 *  and three source agencies would be a fourth thing to reconcile; every
 *  measured_at the service sends is UTC and it is shown as UTC. */
export function formatSliceTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(
    d.getUTCHours(),
  )}:${p(d.getUTCMinutes())} UTC`;
}

/** ISO instant → the `YYYY-MM-DDTHH:mm` a datetime-local input wants, in UTC.
 *  The input is labelled UTC, so no timezone conversion happens in either
 *  direction: what is typed is the instant that is asked for. */
export function isoToInputUtc(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toISOString().slice(0, 16);
}

export function inputUtcToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(`${v}:00Z`);
  return Number.isFinite(d.getTime()) ? d.toISOString().replace(/\.\d{3}Z$/, "Z") : null;
}

/* ---------------------------------------------------------------- colour */

/** A colour ramp is a list of [value, colour] stops, interpolated linearly by
 *  MapLibre. The stops are published in the legend — a colour on a chart that
 *  cannot be read back as a number is decoration. */
export type Ramp = { stops: Array<[number, string]> };

/* Ice classes are an enum, not a scale: 1 open water, 2 land, 3 sea ice,
   4 snow-covered land. Land is in the grid and stays visible as land — hiding
   it would make the ice edge look like it ran to the shore of a map we drew,
   and colouring it as ice would be a lie. */
export const ICE_CLASS_COLOURS: Record<number, string> = {
  1: "#1f4b73", // open water
  2: "#3b3f46", // land
  3: "#dff3ff", // sea ice — the one thing on this layer that should shout
  4: "#9fb3c8", // snow-covered land
};

const RAMPS: Record<string, Ramp> = {
  sst_c: {
    stops: [
      [0, "#2c7bb6"],
      [5, "#5aa7cc"],
      [10, "#9dcfc4"],
      [15, "#dbe8a4"],
      [20, "#fdd68b"],
      [25, "#f18a51"],
      [30, "#d7191c"],
    ],
  },
  sst_anomaly_c: {
    stops: [
      [-4, "#2c7bb6"],
      [-2, "#9dcfc4"],
      [0, "#efefef"],
      [2, "#fdae61"],
      [4, "#d7191c"],
    ],
  },
  chl_a: {
    stops: [
      [0, "#08243b"],
      [1, "#0d5c4a"],
      [3, "#2f8f3f"],
      [8, "#93c447"],
      [15, "#e8e34a"],
      [25, "#f4a23c"],
    ],
  },
  ice_conc: {
    stops: [
      [0, "#1f4b73"],
      [0.5, "#8fbcd8"],
      [1, "#ffffff"],
    ],
  },
  ice_thickness_m: {
    stops: [
      [0, "#123c5c"],
      [0.3, "#5f9fc4"],
      [0.8, "#c8e4f2"],
      [1.5, "#ffffff"],
    ],
  },
  wave_m: {
    stops: [
      [0, "#123c5c"],
      [0.5, "#3f8fbf"],
      [1.5, "#9fd0e0"],
      [3, "#f2e9a0"],
    ],
  },
  air_t: {
    stops: [
      [-20, "#3a5fa8"],
      [0, "#7fb4d6"],
      [15, "#dbe8a4"],
      [30, "#e8703a"],
      [45, "#a01020"],
    ],
  },
  wind_ms: {
    stops: [
      [0, "#14324a"],
      [5, "#3f8fbf"],
      [10, "#e0c341"],
      [18, "#d7481c"],
    ],
  },
  gust_ms: {
    stops: [
      [0, "#14324a"],
      [8, "#3f8fbf"],
      [16, "#e0c341"],
      [28, "#d7481c"],
    ],
  },
};

/** The published ramp for a measurable, or null when there is none — then the
 *  caller builds one from the layer's own min/max and SAYS SO in the legend,
 *  because a scale that changes with the data is a different promise from a
 *  fixed one. */
export const rampFor = (v: string): Ramp | null => RAMPS[v] ?? null;

/** A ramp derived from this slice's own extremes. Used only where no fixed
 *  ramp exists; the legend states that the scale is the slice's, not absolute. */
export function rampFromRange(min: number, max: number): Ramp {
  if (!(max > min)) return { stops: [[min, "#6b8fa8"]] };
  return {
    stops: [
      [min, "#14324a"],
      [min + (max - min) / 2, "#5f9fc4"],
      [max, "#e8e34a"],
    ],
  };
}

/** Look a value up in a ramp without MapLibre — for legend swatches and for
 *  the DOM overlays, which have no GL expression to lean on. */
export function rampColour(ramp: Ramp, v: number): string {
  const s = ramp.stops;
  if (!s.length) return "#6b8fa8";
  if (v <= s[0][0]) return s[0][1];
  if (v >= s[s.length - 1][0]) return s[s.length - 1][1];
  for (let i = 1; i < s.length; i++) {
    if (v <= s[i][0]) {
      const [v0, c0] = s[i - 1];
      const [v1, c1] = s[i];
      const f = (v - v0) / (v1 - v0 || 1);
      return mix(c0, c1, f);
    }
  }
  return s[s.length - 1][1];
}

function mix(a: string, b: string, f: number): string {
  const pa = hex(a), pb = hex(b);
  const ch = (i: number) => Math.round(pa[i] + (pb[i] - pa[i]) * f);
  return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
}

function hex(c: string): [number, number, number] {
  const m = c.replace("#", "");
  return [
    parseInt(m.slice(0, 2), 16),
    parseInt(m.slice(2, 4), 16),
    parseInt(m.slice(4, 6), 16),
  ];
}
