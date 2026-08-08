import type { Detection, TrackPoint } from "../types";
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
