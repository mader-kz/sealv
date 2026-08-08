import type { TrackPoint } from "../types";

export type JSONSidecar = {
  track?: TrackPoint[];
  points?: Array<{ t: number; lat: number; lng: number; alt?: number }>;
  gps?: Array<{ t: number; lat: number; lng: number }>;
  // also support DJI-like json with flight path array
  [k: string]: any;
};

export function parseJSONSidecar(content: string): TrackPoint[] {
  let data: JSONSidecar;
  try {
    data = JSON.parse(content);
  } catch (e) {
    throw new Error("Invalid JSON: " + (e as Error).message);
  }

  // try known keys
  const raw: any[] | undefined =
    (Array.isArray(data) ? data : null) ||
    data.track ||
    data.points ||
    data.gps ||
    data.flightPath ||
    data.path ||
    data.locations;

  if (!raw || !Array.isArray(raw)) {
    // maybe single object with lat/lng
    if (typeof data.lat === "number" && typeof data.lng === "number") {
      return [{ t: 0, lat: data.lat, lng: data.lng, alt: data.alt }];
    }
    throw new Error("JSON: no track array found. Expected {track:[{t,lat,lng}]} or array itself.");
  }

  const track: TrackPoint[] = raw
    .map((p: any, i: number) => {
      const t = typeof p.t === "number" ? p.t : typeof p.time === "number" ? p.time : i;
      const lat = typeof p.lat === "number" ? p.lat : typeof p.latitude === "number" ? p.latitude : parseFloat(p.lat);
      const lng = typeof p.lng === "number" ? p.lng : typeof p.lon === "number" ? p.lon : typeof p.longitude === "number" ? p.longitude : parseFloat(p.lng ?? p.lon);
      if (isNaN(lat) || isNaN(lng)) return null;
      return { t, lat, lng, alt: p.alt ?? p.altitude } as TrackPoint;
    })
    .filter(Boolean) as TrackPoint[];

  if (track.length === 0) throw new Error("JSON: no valid lat/lng points found");

  track.sort((a, b) => a.t - b.t);
  return track;
}

/** The track as the JSON sidecar this module's own parser reads back, and as
 *  the ingest path uploads it for the service to georeference against. One
 *  definition rather than an inlined `JSON.stringify` at the call site: the
 *  writer and the reader of this format belong in the same file. Compact on
 *  purpose — a season sortie carries thousands of points and indentation is
 *  pure upload weight. */
export function trackToJSON(track: TrackPoint[]): string {
  return JSON.stringify({ track });
}
