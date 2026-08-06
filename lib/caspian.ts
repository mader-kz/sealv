/**
 * Caspian Sea water mask — tight hull around actual water, not including steppe.
 * [lng, lat] GeoJSON order. Hand-tightened to keep seals off land.
 * Hull traced from Carto dark_tiles visual + Natural Earth approx.
 */
export const CASPIAN_HULL: [number, number][] = [
  [47.1, 47.4], [48.2, 47.0], [49.4, 46.1], [50.4, 45.0], [51.0, 44.2],
  [51.3, 43.4], [51.55, 42.6], [51.7, 41.6], [51.6, 40.3], [51.1, 39.1],
  [50.3, 38.0], [49.2, 37.1], [48.0, 36.9], [47.1, 37.3], [46.6, 38.2],
  [46.4, 39.6], [46.45, 41.0], [46.7, 42.6], [47.0, 44.2], [47.1, 47.4],
];

// Kazakh east coast — anything east of this at given lat is steppe/land
function isEastOfKazakhCoast(lat: number, lng: number): boolean {
  if (lat > 45.2) return lng > 50.85;  // north Durneva
  if (lat > 44.2) return lng > 51.05;  // Tyuleniy/Bautino north
  if (lat > 43.6) return lng > 51.00;  // Aktau north
  if (lat > 42.8) return lng > 51.00;  // Aktau proper — 51.18 is land, 50.92 is water
  if (lat > 41.8) return lng > 51.45;  // Kendirli
  if (lat > 39.5) return lng > 51.4;
  return lng > 51.0;
}

// West coast — anything west of this is land (Dagestan/Azerbaijan side)
function isWestOfCaspian(lat: number, lng: number): boolean {
  if (lat > 44.5) return lng < 47.0;
  if (lat > 42.5) return lng < 47.0;
  if (lat > 40.5) return lng < 46.8;
  if (lat > 38.5) return lng < 46.6;
  return lng < 47.5;
}

export function isWater(lat: number, lng: number): boolean {
  if (lat < 36.6 || lat > 47.6 || lng < 46.0 || lng > 52.0) return false;
  if (!pointInPolygon([lng, lat], CASPIAN_HULL)) return false;
  if (isEastOfKazakhCoast(lat, lng)) return false;
  if (isWestOfCaspian(lat, lng)) return false;
  return true;
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

export function snapToWater(lat: number, lng: number, seaCenter: { lat: number; lng: number } = { lat: 42.8, lng: 50.1 }): { lat: number; lng: number } {
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
  // deep fallback: central sea + small jitter (guaranteed water)
  return { lat: 43.1 + (Math.random()-0.5)*0.6, lng: 50.15 + (Math.random()-0.5)*0.6 };
}
