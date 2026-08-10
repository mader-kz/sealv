/** Typed client and display geometry for reported pollution evidence. */

export type PollutionProperties = {
  id: string;
  source_id: string;
  source_name?: string | null;
  source_url?: string | null;
  source_link?: string | null;
  title?: string | null;
  root_cause?: string | null;
  status?: string | null;
  observed_at: string | null;
  lat: number;
  lng: number;
  radius_m: number;
  radius_meaning?: "location_uncertainty";
  kind: string;
  area_km2?: number | null;
  confidence?: number | null;
  location_precision: string;
  raw?: Record<string, unknown>;
  change_seq?: number;
  change_action?: "inserted" | "updated";
};

export type PollutionFeature = {
  type: "Feature";
  geometry:
    | { type: "Point"; coordinates: [number, number] }
    | { type: "Polygon"; coordinates: number[][][] };
  properties: PollutionProperties;
};

export type PollutionFC = {
  type: "FeatureCollection";
  features: PollutionFeature[];
  removed?: string[];
  count?: number;
  generated_at?: string;
  cursor?: number;
  has_more?: boolean;
};

export type PollutionStatus = {
  summary: {
    statuses: Record<string, number>;
    stale: number;
  };
};

export type PollutionAgeBucket =
  | "day"
  | "week"
  | "month"
  | "quarter"
  | "older"
  | "unknown";

const API = process.env.NEXT_PUBLIC_API_BASE ?? "";

export async function fetchPollution(
  opts?: { bbox?: string; since?: string; kind?: string; limit?: number; signal?: AbortSignal },
): Promise<PollutionFC> {
  const p = new URLSearchParams();
  if (opts?.bbox) p.set("bbox", opts.bbox);
  if (opts?.since) p.set("since", opts.since);
  if (opts?.kind) p.set("kind", opts.kind);
  if (opts?.limit) p.set("limit", String(opts.limit));
  const url = `${API}/v1/pollution${p.toString() ? `?${p}` : ""}`;
  const res = await fetch(url, { signal: opts?.signal });
  if (!res.ok) throw new Error(`pollution fetch ${res.status}`);
  return (await res.json()) as PollutionFC;
}


export async function fetchPollutionChanges(
  after: number,
  opts?: { bbox?: string; limit?: number; signal?: AbortSignal },
): Promise<PollutionFC> {
  const p = new URLSearchParams({ after: String(after) });
  if (opts?.bbox) p.set("bbox", opts.bbox);
  if (opts?.limit) p.set("limit", String(opts.limit));
  const res = await fetch(`${API}/v1/pollution/changes?${p}`, { signal: opts?.signal });
  if (!res.ok) throw new Error(`pollution changes fetch ${res.status}`);
  return (await res.json()) as PollutionFC;
}


export async function fetchPollutionStatus(
  signal?: AbortSignal,
): Promise<PollutionStatus> {
  const res = await fetch(`${API}/v1/pollution/status`, { signal });
  if (!res.ok) throw new Error(`pollution status fetch ${res.status}`);
  return (await res.json()) as PollutionStatus;
}


export function mergePollution(
  current: PollutionFC,
  changes: PollutionFC,
): PollutionFC {
  const removed = new Set(changes.removed ?? []);
  if (!changes.features.length && !removed.size) {
    return { ...current, cursor: changes.cursor ?? current.cursor };
  }
  const byId = new Map(
    current.features
      .filter(feature => !removed.has(feature.properties.id))
      .map(feature => [feature.properties.id, feature]),
  );
  for (const feature of changes.features) byId.set(feature.properties.id, feature);
  const features = [...byId.values()];
  return {
    type: "FeatureCollection",
    features,
    count: features.length,
    generated_at: changes.generated_at ?? current.generated_at,
    cursor: changes.cursor ?? current.cursor,
  };
}

export function pollutionAgeBucket(
  observedAt: string | null,
  referenceAt?: string | null,
): PollutionAgeBucket {
  const observed = observedAt ? Date.parse(observedAt) : Number.NaN;
  const reference = referenceAt ? Date.parse(referenceAt) : Date.now();
  if (!Number.isFinite(observed) || !Number.isFinite(reference)) return "unknown";
  const days = Math.max(0, reference - observed) / 86_400_000;
  if (days <= 1) return "day";
  if (days <= 7) return "week";
  if (days <= 30) return "month";
  if (days <= 90) return "quarter";
  return "older";
}

export function pollutionColor(
  properties: PollutionProperties,
  referenceAt?: string | null,
): string {
  switch (pollutionAgeBucket(properties.observed_at, referenceAt)) {
    case "day": return "#f04e45";
    case "week": return "#e96b3c";
    case "month": return "#dc8733";
    case "quarter": return "#b49a56";
    case "older": return "#718094";
    case "unknown": return "#7c828a";
  }
}

type DisplayProperties = PollutionProperties & {
  color: string;
  age_bucket: PollutionAgeBucket;
  selected: boolean;
};

export type PollutionDisplayFC = {
  type: "FeatureCollection";
  features: Array<Omit<PollutionFeature, "properties"> & { properties: DisplayProperties }>;
};

export function pollutionDisplay(
  collection: PollutionFC,
  referenceAt: string | null | undefined,
  selectedId: string | null,
): PollutionDisplayFC {
  const reference = referenceAt ? Date.parse(referenceAt) : Date.now();
  return {
    type: "FeatureCollection",
    features: collection.features
      .filter((feature) => {
        const observed = feature.properties.observed_at
          ? Date.parse(feature.properties.observed_at)
          : Number.NaN;
        return !Number.isFinite(reference) || !Number.isFinite(observed) || observed <= reference;
      })
      .map((feature) => ({
        ...feature,
        properties: {
          ...feature.properties,
          color: pollutionColor(feature.properties, referenceAt),
          age_bucket: pollutionAgeBucket(feature.properties.observed_at, referenceAt),
          selected: feature.properties.id === selectedId,
        },
      })),
  };
}

/** Actual metre-based uncertainty rings. Marker size remains a visibility aid. */
export function pollutionUncertainty(collection: PollutionDisplayFC): PollutionDisplayFC {
  const earthRadius = 6_371_008.8;
  return {
    type: "FeatureCollection",
    features: collection.features.flatMap((feature) => {
      const { lat, lng, radius_m: radius } = feature.properties;
      if (![lat, lng, radius].every(Number.isFinite) || radius <= 0) return [];
      const angular = radius / earthRadius;
      const latitude = lat * Math.PI / 180;
      const longitude = lng * Math.PI / 180;
      const ring: number[][] = [];
      for (let step = 0; step <= 48; step += 1) {
        const bearing = step / 48 * Math.PI * 2;
        const targetLat = Math.asin(
          Math.sin(latitude) * Math.cos(angular)
          + Math.cos(latitude) * Math.sin(angular) * Math.cos(bearing),
        );
        const targetLng = longitude + Math.atan2(
          Math.sin(bearing) * Math.sin(angular) * Math.cos(latitude),
          Math.cos(angular) - Math.sin(latitude) * Math.sin(targetLat),
        );
        ring.push([targetLng * 180 / Math.PI, targetLat * 180 / Math.PI]);
      }
      return [{
        ...feature,
        geometry: { type: "Polygon" as const, coordinates: [ring] },
      }];
    }),
  };
}
