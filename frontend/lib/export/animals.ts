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

export type AnimalProps = {
  sortie: string;
  date: string;
  status: Detection["status"];
  score: number | null;
  run_id: string | null;
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

export function buildAnimalsGeoJSON(footages: Footage[]): AnimalCollection {
  return {
    type: "FeatureCollection",
    features: exportable(footages).map(({ f, d }) => ({
      type: "Feature",
      // GeoJSON is [lng, lat] — the order every GIS expects and the one this
      // codebase gets wrong the moment it stops being written down.
      geometry: { type: "Point", coordinates: [d.lng, d.lat] },
      properties: {
        sortie: f.filename,
        date: f.uploadedAt,
        status: d.status,
        score: scoreOf(d),
        run_id: f.runId ?? null,
      },
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
  const rows = ["lat,lng,status,score,sortie,date"];
  for (const { f, d } of exportable(footages)) {
    const score = scoreOf(d);
    rows.push(
      [d.lat, d.lng, d.status, score === null ? "" : score, csvCell(f.filename), f.uploadedAt].join(","),
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
