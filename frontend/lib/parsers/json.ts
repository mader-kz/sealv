import type { TrackPoint } from "../types";

export type JSONSidecar = {
  track?: TrackPoint[];
  points?: Array<{ t: number; lat: number; lng: number; alt?: number }>;
  gps?: Array<{ t: number; lat: number; lng: number }>;
  // also support DJI-like json with flight path array
  [k: string]: any;
};

/* A wall clock, and only a wall clock.
   `TrackPoint.timestamp` is documented as "original SRT timestamp", and the
   SRT parser fills it with the CUE TIME LINE — "00:00:12,340 --> 00:00:13,340".
   The service reads the first non-empty `timestamp` of an uploaded track as
   the survey's CAPTURE DATE (api.py: `next(p["timestamp"] for p in track…)`),
   so passing that string through would stamp every SRT sortie with a capture
   date of "00:00:12,340 --> …" — a fabricated field where there was honestly
   none. Only a value that is actually a date-time is carried; anything else is
   dropped, and the survey keeps its "no capture date recorded" state. */
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;

/** The point's own wall clock, or undefined when it never had one. */
export function wallClock(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  return s && WALL_CLOCK.test(s) ? s : undefined;
}

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
      return [{ t: 0, lat: data.lat, lng: data.lng, alt: data.alt, timestamp: wallClock(data.timestamp) }];
    }
    throw new Error("JSON: no track array found. Expected {track:[{t,lat,lng}]} or array itself.");
  }

  const track: TrackPoint[] = raw
    .map((p: any, i: number) => {
      const t = typeof p.t === "number" ? p.t : typeof p.time === "number" ? p.time : i;
      const lat = typeof p.lat === "number" ? p.lat : typeof p.latitude === "number" ? p.latitude : parseFloat(p.lat);
      const lng = typeof p.lng === "number" ? p.lng : typeof p.lon === "number" ? p.lon : typeof p.longitude === "number" ? p.longitude : parseFloat(p.lng ?? p.lon);
      if (isNaN(lat) || isNaN(lng)) return null;
      /* The sidecar's own clock, kept. It is what the service turns into the
         survey's capture date, and dropping it here is why an archive of 2019
         sorties all landed on the day they happened to be re-counted. */
      const timestamp = wallClock(p.timestamp ?? p.datetime ?? p.date ?? p.captured_at);
      return { t, lat, lng, alt: p.alt ?? p.altitude, timestamp } as TrackPoint;
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
 *  pure upload weight.
 *
 *  `timestamp` rides along when the point genuinely carries one. The service
 *  resolves the survey's capture date from the first timestamp in the track
 *  it receives, and this writer used to drop the field on the floor — so a
 *  sortie flown in March, re-counted in August, was filed under August, on the
 *  timeline, in the dynamics chart and in the printed report. What it will
 *  NOT do is invent one: see `wallClock` above on the SRT cue-range string
 *  that would otherwise be posted as a date. */
export function trackToJSON(track: TrackPoint[]): string {
  return JSON.stringify({
    track: track.map((p) => {
      const ts = wallClock(p.timestamp);
      const out: TrackPoint = { t: p.t, lat: p.lat, lng: p.lng };
      if (p.alt !== undefined) out.alt = p.alt;
      if (ts) out.timestamp = ts;
      return out;
    }),
  });
}

/** The first real wall clock in a track — the capture date the service will
 *  derive from this same sidecar, computed here so the UI can show it before
 *  the upload rather than after. Null when the track never recorded one. */
export function capturedAtOf(track: TrackPoint[]): string | null {
  for (const p of track) {
    const ts = wallClock(p.timestamp);
    if (ts) return ts;
  }
  return null;
}
