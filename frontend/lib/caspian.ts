/**
 * Caspian Sea water mask — an outline of the actual water, not the steppe.
 * [lng, lat] GeoJSON order. Kept in step with `service/env.py`'s CASPIAN_HULL,
 * which samples the environment grid against the same shape.
 *
 * The previous version was wrong in both directions, and the environment layer
 * made it visible. It called the Iranian coast (37.0 N, 48.0 E) water, so 28%
 * of the collected grid landed on dry ground; and between a hard `lng > 52.0`
 * cut and an east-coast rule that put the shoreline at ~51 E for every
 * latitude, it called Turkmenbashi, Kara-Bogaz-Gol and the whole north-east
 * shelf land — the eastern half of the sea could never hold a sample.
 *
 * This traces the coast instead: Volga delta, Ural mouth, Buzachi,
 * Tyub-Karagan, Aktau, Kendirli, the Kara-Bogaz throat, the Turkmen shelf, the
 * Iranian shore, and the Caucasus coast back to the delta. Still an
 * approximation — the service treats it as a fallback and prefers the 1 km IMS
 * land mask, which is measured rather than traced.
 */
export const CASPIAN_HULL: [number, number][] = [
  [47.9, 46.30], [48.6, 46.60], [49.5, 46.60], [50.5, 46.80], [51.5, 46.90],
  [52.3, 45.60], [51.8, 45.20], [51.2, 45.00], [50.6, 44.80], [50.3, 44.50],
  [51.0, 44.00], [51.2, 43.60], [51.8, 43.00], [52.4, 42.40], [52.7, 41.60],
  [52.9, 41.20], [53.2, 40.60], [53.3, 40.00], [53.7, 39.20], [53.9, 38.40],
  [54.0, 37.70], [53.8, 36.90], [53.0, 36.80], [52.3, 36.70], [51.5, 36.65],
  [50.6, 36.80], [50.0, 37.20], [49.5, 37.50], [49.1, 37.90], [48.9, 38.40],
  [49.0, 39.00], [49.2, 39.50], [49.4, 40.00], [50.0, 40.20], [50.4, 40.40],
  [49.9, 40.70], [49.3, 41.20], [48.8, 41.60], [48.5, 41.90], [48.3, 42.20],
  [47.9, 42.60], [47.6, 43.00], [47.4, 43.60], [47.2, 44.30], [47.2, 45.00],
  [47.4, 45.60], [47.9, 46.30],
];

export function isWater(lat: number, lng: number): boolean {
  if (lat < 36.6 || lat > 47.6 || lng < 46.0 || lng > 55.0) return false;
  return pointInPolygon([lng, lat], CASPIAN_HULL);
}

function pointInPolygon(pt: [number, number], poly: [number, number][]): boolean {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Nearest water point to a coordinate the mask rejects — or `null` when there
 * is none within reach.
 *
 * SYNTHETIC DATA ONLY. This must never touch a measured coordinate: moving a
 * measurement is fabricating one, and the mask is an approximation (it calls
 * the Aktau shoreline land, which is where a real sortie launches from). The
 * ingest path used to run every rejected track point through here before
 * packing that same track into the sidecar the service georeferences animals
 * against — so a mask disagreement propagated into per-animal positions, site
 * clustering, the GeoJSON export and the PDF's five decimals. It no longer
 * does; ingest states the disagreement and keeps the measurement.
 *
 * The old deep fallback returned `43.1 ± 0.3, 50.15 ± 0.3` — up to ~33 km of
 * invented offset, a different answer on every run. A caller that cannot find
 * water now gets `null` and has to decide honestly what that means.
 */
export function snapToWater(lat: number, lng: number, seaCenter: { lat: number; lng: number } = { lat: 42.8, lng: 50.1 }): { lat: number; lng: number } | null {
  if (isWater(lat, lng)) return { lat, lng };
  // bias strongly toward central Caspian, not just coast
  for (let r = 0.04; r < 0.8; r += 0.06) {
    const candidates: Array<{lat:number,lng:number}> = [];
    // 8 dirs + toward center
    for (const [dx, dy] of [[0,-1],[0,1],[-1,0],[1,0],[-1,-1],[1,-1],[-1,1],[1,1]] as const) {
      candidates.push({ lat: lat + dy * r, lng: lng + dx * r });
    }
    candidates.push({ lat: lat + (seaCenter.lat - lat) * 0.5, lng: lng + (seaCenter.lng - lng) * 0.5 });
    for (const c of candidates) if (isWater(c.lat, c.lng)) return c;
  }
  return null;
}
