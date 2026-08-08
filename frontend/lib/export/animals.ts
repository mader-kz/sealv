/* Per-animal exports — the artifact an ecologist actually opens somewhere
   else. One row/feature per animal the engine found and the map could place,
   nothing aggregated, nothing invented: QGIS reads the .geojson directly
   (RFC 7946 is always WGS84, so no CRS member is written), Excel/R read the
   .csv.

   False positives are excluded — a reviewer's verdict is the whole point of
   having verdicts. Animals without coordinates are excluded too: they exist,
   they are in the count band, but a point export cannot place them. The
   Evidence view is where they are visible. */
import type { Footage, Detection } from "../types";

const text = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" ? null : s;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/* One animal, and everything about the sortie behind it that a GIS reader
   needs to filter, join or defend the point without the app open: which run
   and which survey produced it, the named place, the method and the band the
   count came with, whether the scale and the position were measured or
   guessed, who recorded it, and when the footage was actually flown.

   `date` stays the sortie's timeline date (the flight date when the survey
   recorded one, the count's clock when it did not) so existing consumers are
   untouched; `captured_at` is the raw flight date, empty when never recorded —
   the two together are what let a reader tell one from the other. */
export type AnimalProps = {
  sortie: string;
  date: string;
  status: Detection["status"];
  score: number | null;
  run_id: string | null;
  survey_id: string | null;
  site: string | null;
  basis: string | null;
  low: number | null;
  best: number | null;
  high: number | null;
  gsd_source: string | null;
  location_source: string | null;
  operator: string | null;
  captured_at: string | null;
};

export type AnimalFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: AnimalProps;
};

export type AnimalCollection = { type: "FeatureCollection"; features: AnimalFeature[] };

/** Placed, non-false-positive detections, in sortie order. The single filter
 *  both builders share, so GeoJSON and CSV can never disagree on the count. */
function exportable(footages: Footage[]): Array<{ f: Footage; d: Detection }> {
  const out: Array<{ f: Footage; d: Detection }> = [];
  for (const f of footages) {
    for (const d of f.detections) {
      if (d.status === "false_positive") continue;
      if (!Number.isFinite(d.lat) || !Number.isFinite(d.lng)) continue;
      out.push({ f, d });
    }
  }
  return out;
}

const scoreOf = (d: Detection): number | null => (Number.isFinite(d.confidence) ? d.confidence : null);

/** The sortie half of a row. One builder, so the GeoJSON properties and the
 *  CSV columns cannot drift apart the way the count once drifted across four
 *  panels. */
function sortieProps(f: Footage): Omit<AnimalProps, "status" | "score"> {
  return {
    sortie: f.filename,
    date: f.uploadedAt,
    run_id: f.runId ?? null,
    survey_id: text(f.surveyId),
    site: text(f.siteName),
    basis: text(f.band?.basis),
    low: num(f.band?.low),
    best: num(f.band?.best),
    high: num(f.band?.high),
    gsd_source: text(f.gsdSource),
    location_source: text(f.locationSource),
    operator: text(f.operator),
    captured_at: text(f.capturedAt),
  };
}

/** Column order, written once. The header and every row read from this list,
 *  so a column can never end up under the wrong heading. */
const CSV_COLUMNS = [
  "run_id",
  "survey_id",
  "site",
  "basis",
  "low",
  "best",
  "high",
  "gsd_source",
  "location_source",
  "operator",
  "captured_at",
] as const;

export function buildAnimalsGeoJSON(footages: Footage[]): AnimalCollection {
  return {
    type: "FeatureCollection",
    features: exportable(footages).map(({ f, d }) => ({
      type: "Feature",
      // GeoJSON is [lng, lat] — the order every GIS expects and the one this
      // codebase gets wrong the moment it stops being written down.
      geometry: { type: "Point", coordinates: [d.lng, d.lat] },
      properties: { ...sortieProps(f), status: d.status, score: scoreOf(d) },
    })),
  };
}

/** RFC 4180 cell: quote when the value could otherwise break the row. */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildAnimalsCSV(footages: Footage[]): string {
  /* The first six columns are unchanged and stay first: a saved QGIS style or
     an R script that reads them by position keeps working, and everything the
     wave added is appended. */
  const rows = [["lat", "lng", "status", "score", "sortie", "date", ...CSV_COLUMNS].join(",")];
  for (const { f, d } of exportable(footages)) {
    const score = scoreOf(d);
    const p = sortieProps(f);
    rows.push(
      [
        d.lat,
        d.lng,
        d.status,
        score === null ? "" : score,
        csvCell(p.sortie),
        p.date,
        // Free text out of the database — a site name or a note-writer's name
        // with a comma in it must not be able to shift every later column.
        ...CSV_COLUMNS.map((k) => csvCell(p[k])),
      ].join(","),
    );
  }
  return rows.join("\n");
}

const stamp = () => new Date().toISOString().slice(0, 10);

/** Browser download of an in-memory text file. */
export function downloadText(filename: string, mime: string, text: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportAnimalsGeoJSON(footages: Footage[]) {
  downloadText(
    `sealv-animals-${stamp()}.geojson`,
    "application/geo+json",
    JSON.stringify(buildAnimalsGeoJSON(footages), null, 2),
  );
}

export function exportAnimalsCSV(footages: Footage[]) {
  downloadText(`sealv-animals-${stamp()}.csv`, "text/csv", buildAnimalsCSV(footages));
}
