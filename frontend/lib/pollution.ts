/** Pollution helpers — encapsulated, additive. No existing map logic touched. */

export type PollutionFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] } | { type: "Polygon"; coordinates: number[][][] };
  properties: {
    id: string;
    source_id: string;
    observed_at: string | null;
    lat: number;
    lng: number;
    radius_m: number;
    kind: string;
    area_km2?: number | null;
    confidence?: number | null;
    location_precision: string;
  };
};

export type PollutionFC = { type: "FeatureCollection"; features: PollutionFeature[] };

const API = process.env.NEXT_PUBLIC_API_BASE ?? "";

export async function fetchPollution(opts?: { bbox?: string; since?: string; kind?: string; limit?: number }): Promise<PollutionFC> {
  const p = new URLSearchParams();
  if (opts?.bbox) p.set("bbox", opts.bbox);
  if (opts?.since) p.set("since", opts.since);
  if (opts?.kind) p.set("kind", opts.kind);
  if (opts?.limit) p.set("limit", String(opts.limit));
  const url = `${API}/v1/pollution${p.toString() ? `?${p}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`pollution fetch ${res.status}`);
  return (await res.json()) as PollutionFC;
}

export function pollutionColor(p: PollutionFeature["properties"]): string {
  if (p.kind === "flare") return "#ffaa00";
  if (p.kind === "slick") return "#ff6b5e";
  if (p.location_precision === "exact") return "#ff6b5e";
  if (p.location_precision === "field") return "#f5c451";
  return "#8b96a5";
}

export function pollutionRadius(p: PollutionFeature["properties"]): number {
  // radius_m -> circle radius in pixels approx, clamp
  const r = p.radius_m ?? 500;
  return Math.max(6, Math.min(22, Math.round(r / 800)));
}
