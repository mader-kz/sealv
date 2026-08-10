import type { Detection, Footage, TrackPoint } from "../types";
import { isWater, snapToWater } from "../caspian";

export function mockDetections(track: TrackPoint[], footageId: string): Detection[] {
  if (track.length === 0) return [];
  // whole-video count — not per-timestamp (per your spec: video location → map, count per video wholly)
  let seed = hash(footageId);
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  // single detection per video at its centre, count = total seals in that sortie
  const center = track[Math.floor(track.length/2)];
  let lat = center.lat + (rand()-0.5)*0.006;
  let lng = center.lng + (rand()-0.5)*0.006;
  if (!isWater(lat, lng)) {
    // snapToWater gives up rather than inventing a point when no water is in
    // reach — then the jittered centre stands as it is. Synthetic either way.
    const s = snapToWater(lat, lng, center);
    if (s) { lat = s.lat; lng = s.lng; }
  }
  const count = 2 + Math.floor(rand()*18) + Math.floor(rand()*7); // 2-26 whole-video count
  const confidence = 0.76 + rand()*0.18;
  return [{
    id: `${footageId}-det-0`,
    footageId,
    t: 0,
    lat,
    lng,
    count,
    confidence: Math.round(confidence*100)/100,
    bbox: [rand()*0.6, rand()*0.6, 0.15+rand()*0.2, 0.12+rand()*0.15] as [number,number,number,number],
    status: "auto" as const,
  }];
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h<<5)-h + s.charCodeAt(i) | 0;
  return Math.abs(h) % 100000;
}

export function generateSeedTrack(center: {lat:number, lng:number}, durationSec: number, points: number = 50): TrackPoint[] {
  // ensure center is on water — snap if user gave land coordinate
  const start = (isWater(center.lat, center.lng) ? center : snapToWater(center.lat, center.lng)) ?? center;
  const track: TrackPoint[] = [];
  let lat = start.lat;
  let lng = start.lng;
  for (let i=0;i<points;i++) {
    const t = (i/points)*durationSec;
    // 30-40km track — visible at z6.8
    let nlat = lat + (Math.sin(i*0.5)*0.008 + (Math.random()-0.5)*0.004);
    let nlng = lng + (Math.cos(i*0.7)*0.008 + (Math.random()-0.5)*0.004);
    // keep track on water — if next step hits land, stay or nudge toward sea center
    if (!isWater(nlat, nlng)) {
      // try to stay, or snap toward start (which is water)
      const toward = { lat: lat + (start.lat - lat)*0.4, lng: lng + (start.lng - lng)*0.4 };
      if (isWater(toward.lat, toward.lng)) { nlat = toward.lat; nlng = toward.lng; }
      else { // try snapped version near start; null = no water in reach, keep the step
        const s = snapToWater(nlat, nlng, start);
        if (s) { nlat = s.lat; nlng = s.lng; }
      }
    }
    lat = nlat; lng = nlng;
    track.push({ t, lat, lng, alt: 80 + Math.sin(i*0.3)*20 });
  }
  return track;
}

type DemoMarker = {
  key: string;
  lat: number;
  lng: number;
  count: number;
};

const DEMO_DAY_MS = 86_400_000;
const DEMO_EARTH_RADIUS_KM = 6371.0088;

/** A deterministic offset used to lay out the demo's observable movements. */
function offsetKm(
  origin: { lat: number; lng: number },
  eastKm: number,
  northKm: number,
): { lat: number; lng: number } {
  const lat = origin.lat + (northKm / DEMO_EARTH_RADIUS_KM) * (180 / Math.PI);
  const lng = origin.lng + (eastKm / (DEMO_EARTH_RADIUS_KM * Math.cos(origin.lat * Math.PI / 180))) * (180 / Math.PI);
  return { lat, lng };
}

/**
 * A small repeatable drone footprint around a survey's marker centroid.
 * It is deliberately deterministic: refreshing the demo must never redraw a
 * different story or change which groups the tracker links.
 */
function demoFlight(center: { lat: number; lng: number }, duration: number): TrackPoint[] {
  return Array.from({ length: 28 }, (_, index) => {
    const phase = (index / 27) * Math.PI * 2;
    return {
      t: (index / 27) * duration,
      lat: center.lat + Math.sin(phase) * 0.018,
      lng: center.lng + Math.sin(phase * 2) * 0.026,
      alt: 82 + Math.cos(phase) * 9,
    };
  });
}

function demoSurvey(input: {
  id: string;
  filename: string;
  capturedAt: string;
  markers: DemoMarker[];
  siteId?: string;
  siteName?: string;
  siteRegion?: string;
  areaM2?: number;
  note: string;
}): Footage {
  const center = {
    lat: input.markers.reduce((sum, marker) => sum + marker.lat, 0) / input.markers.length,
    lng: input.markers.reduce((sum, marker) => sum + marker.lng, 0) / input.markers.length,
  };
  const duration = 168;
  const detections: Detection[] = input.markers.map((marker, index) => ({
    id: `${input.id}-det-${marker.key}`,
    footageId: input.id,
    t: 24 + index * 18,
    lat: marker.lat,
    lng: marker.lng,
    count: marker.count,
    confidence: 0.94,
    status: "validated",
  }));
  return {
    id: input.id,
    filename: input.filename,
    size: 238_000_000,
    duration,
    uploadedAt: input.capturedAt,
    ingestedAt: input.capturedAt,
    capturedAt: input.capturedAt,
    track: demoFlight(center, duration),
    detections,
    center,
    siteId: input.siteId,
    siteName: input.siteName,
    siteRegion: input.siteRegion,
    areaM2: input.areaM2,
    status: "ready",
    source: "test",
    locationSource: "telemetry",
    notes: input.note,
    operator: "SEALv demo",
    engine: "deterministic-demo",
  };
}

/**
 * A complete, inspectable story for the movement UI.
 *
 * - four repeatedly observed groups create connected routes and forecasts;
 * - one route accelerates twice, producing a speed anomaly;
 * - one route reverses direction, producing a sharp-turn anomaly;
 * - one 100-animal aggregation splits into 45/55, while a separate pair
 *   merges 82+58 into one 140-animal aggregation;
 * - five historical seasonal baselines plus two recent visits create one
 *   regional-avoidance alert and one normal reference region.
 *
 * Counts are aggregate observations: this demonstrates anonymous group
 * matching, not individual animal identity.
 */
export function movementDemoFootages(): Footage[] {
  const started = Date.parse("2026-07-20T08:00:00.000Z");
  const ulan = { lat: 44.72, lng: 49.35 };
  const samal = { lat: 43.62, lng: 50.72 };
  const fast = { lat: 44.22, lng: 50.62 };
  const turning = { lat: 42.85, lng: 49.72 };
  const splitColony = { lat: 45.28, lng: 50.18 };
  const mergeColony = { lat: 41.90, lng: 48.55 };
  const ulanCounts = [52, 50, 54, 51, 49];
  const samalCounts = [31, 30, 29, 31, 32];
  const fastCounts = [20, 21, 20, 21, 20];
  const turningCounts = [72, 70, 73, 71, 74];
  const fastWestKm = [0, -10, -71, -132, -145];
  /* Deliberately unmistakable at basin zoom: three dates move due east, then
     the fourth reverses ~163° and the fifth continues back west. A small
     northward offset keeps the return cards inspectable without softening the
     event into an ordinary curve. */
  const turningEastKm = [0, 15, 30, 14, -2];
  const turningNorthKm = [0, 0, 0, 5, 10];

  const movement = Array.from({ length: 5 }, (_, day) => {
    const markers: DemoMarker[] = [
      { key: "ulan", ...offsetKm(ulan, day * 10, day * 3), count: ulanCounts[day] },
      { key: "samal", ...offsetKm(samal, day * -8, day * 3.5), count: samalCounts[day] },
      { key: "fast", ...offsetKm(fast, fastWestKm[day], 0), count: fastCounts[day] },
      { key: "turn", ...offsetKm(turning, turningEastKm[day], turningNorthKm[day]), count: turningCounts[day] },
    ];
    if (day === 0) {
      markers.push(
        { key: "split-colony", ...splitColony, count: 100 },
        { key: "merge-west", ...offsetKm(mergeColony, -6, 0), count: 82 },
        { key: "merge-east", ...offsetKm(mergeColony, 6, 0), count: 58 },
      );
    } else if (day === 1) {
      markers.push(
        { key: "split-west", ...offsetKm(splitColony, -5, 0), count: 45 },
        { key: "split-east", ...offsetKm(splitColony, 5, 0), count: 55 },
        { key: "merge-west", ...offsetKm(mergeColony, -3, 1), count: 80 },
        { key: "merge-east", ...offsetKm(mergeColony, 3, 1), count: 60 },
      );
    } else {
      markers.push(
        { key: "split-west", ...offsetKm(splitColony, -5 - day * 4, day), count: [0, 0, 44, 43, 46][day] },
        { key: "split-east", ...offsetKm(splitColony, 5 + day * 4, day), count: [0, 0, 56, 57, 54][day] },
      );
      if (day < 4) {
        markers.push(
          { key: "merge-west", ...offsetKm(mergeColony, -3 + day * 1.5, day), count: [0, 0, 79, 81][day] },
          { key: "merge-east", ...offsetKm(mergeColony, 3 - day * 1.5, day), count: [0, 0, 61, 59][day] },
        );
      } else {
        markers.push({ key: "merge-whole", ...offsetKm(mergeColony, 0, day), count: 140 });
      }
    }
    const capturedAt = new Date(started + day * DEMO_DAY_MS).toISOString();
    return demoSurvey({
      id: `demo-movement-${day + 1}`,
      filename: `DEMO_ROUTE_DAY_${day + 1}.MP4`,
      capturedAt,
      markers,
      siteId: "DEMO-MOVEMENT-CORRIDOR",
      siteName: "Demo movement corridor",
      note: day === 0
        ? "Demo start: four moving groups, one 100-animal aggregation, and two groups that will merge."
        : day === 1
          ? "Demo split: 100 animals become groups of 45 and 55; the separate merge pair remains 80 and 60."
          : day === 4
            ? "Demo merge: the separate 81/59 pair is now one 140-animal aggregation."
            : "Deterministic repeat observation for route, forecast, and anomaly demonstration.",
    });
  });

  const avoidance: Footage[] = [];
  const addRegionSeries = (
    regionKey: string,
    region: string,
    origin: { lat: number; lng: number },
    counts: number[],
    note: string,
  ) => {
    counts.forEach((count, index) => {
      const year = 2020 + index;
      const capturedAt = `${year}-05-15T08:00:00.000Z`;
      avoidance.push(demoSurvey({
        id: `demo-${regionKey}-${year}`,
        filename: `DEMO_${regionKey.toUpperCase()}_${year}.MP4`,
        capturedAt,
        markers: [{ key: regionKey, ...offsetKm(origin, index * 0.8, index * 0.4), count }],
        siteId: `DEMO-${regionKey.toUpperCase()}`,
        siteName: region,
        siteRegion: region,
        areaM2: 10_000_000,
        note,
      }));
    });
  };
  addRegionSeries(
    "north-alert",
    "North demo sector — avoidance signal",
    { lat: 46.05, lng: 49.10 },
    [102, 108, 97, 105, 101, 0, 0],
    "Five-year seasonal baseline followed by two fully surveyed zero-use visits; should mark the region as avoided and raise a review signal.",
  );
  addRegionSeries(
    "south-normal",
    "South demo sector — reference",
    { lat: 39.20, lng: 51.30 },
    [76, 82, 73, 79, 77, 75, 80],
    "Reference series remains inside its seasonal historical range.",
  );

  return [...avoidance, ...movement];
}

export const KZ_SITES = [
  // all coords snapped offshore (west of coast) — never on land
  { id: "KEN-04", name: "Kendirli Bay", lat: 43.25, lng: 51.45, region: "KZ-South" as const }, // was 51.8 inland → 51.45 water
  { id: "TYU-01", name: "Tyuleniy Archipelago W", lat: 44.85, lng: 50.25, region: "KZ-East" as const }, // 50.35→50.25 water
  { id: "TYU-02", name: "Tyuleniy East", lat: 44.92, lng: 50.65, region: "KZ-East" as const }, // 50.85→50.65
  { id: "BAU-03", name: "Bautino Shelf", lat: 44.58, lng: 50.12, region: "KZ-East" as const }, // 50.22→50.12
  { id: "KUL-02", name: "Kulaly Island", lat: 44.92, lng: 50.42, region: "KZ-East" as const }, // 50.52→50.42
  { id: "AKT-01", name: "Aktau Offshore", lat: 43.65, lng: 50.95, region: "KZ-South" as const }, // 51.18 coast → 50.95 15km offshore
  { id: "DURN-01", name: "Durneva Island", lat: 45.28, lng: 50.45, region: "KZ-North" as const }, // 50.75→50.45
  { id: "MANG-02", name: "Mangystau Cliffs", lat: 43.80, lng: 50.85, region: "KZ-South" as const }, // 51.05→50.85
];
