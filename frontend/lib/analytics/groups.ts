/**
 * groups.ts — real group sizes, measured from where the animals lie.
 *
 * The engine emits one detection per animal (count === 1), so a histogram
 * over detection.count is a column of ones and says nothing. What a biologist
 * actually reads off a haul-out is how animals bunch: singles, small family
 * groups, dense aggregations. That is a spatial question and is answered
 * spatially — single-linkage clustering at a contact radius (5 m by default:
 * two seals within 5 m of each other are lying together).
 *
 * Single linkage chains on purpose: a line of touching animals along the
 * waterline is one group, which is what the eye sees from the air. It is also
 * why the radius is a parameter — it is the one assumption in the number, and
 * the UI must state it.
 *
 * Distance math runs in the same local metric projection as lib/colony.ts
 * (equirectangular around the cloud's mid-latitude, cos-corrected), so metres
 * are metres in both axes. Points are bucketed into a grid of radius-sized
 * cells, so only the 3x3 neighbourhood of each point is ever tested.
 *
 * Non-finite points are dropped. Exact duplicates are NOT dropped: two
 * detections at identical coordinates are two animals, and deduplicating them
 * would silently undercount.
 */
import type { LL } from "../colony";

/** Meters per degree of latitude (spherical Earth approximation). */
const METERS_PER_DEG = 111320;
/** Smallest usable cell size, meters — guards a zero/negative radius. */
const MIN_CELL = 1e-9;

export type GroupBin = {
  /** Bin label as rendered; a range, not a translated word. */
  label: "1" | "2–5" | "6–20" | "21+";
  min: number;
  /** Open-ended top bin has no max. */
  max: number | null;
  /** How many groups fall in this bin. */
  count: number;
  /** How many animals those groups hold. */
  animals: number;
};

type XY = { x: number; y: number; i: number };

function isFiniteLL(p: LL): boolean {
  return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
}

function projectAll(points: LL[]): XY[] {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  const kept: { p: LL; i: number }[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!isFiniteLL(p)) continue;
    kept.push({ p, i });
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  if (kept.length === 0) return [];
  const refLat = (minLat + maxLat) / 2;
  const refLng = (minLng + maxLng) / 2;
  // Clamp so a (nonsensical) polar cluster cannot divide east–west by ~zero.
  const cosRef = Math.max(Math.cos((refLat * Math.PI) / 180), 0.01);
  return kept.map(({ p, i }) => ({
    x: (p.lng - refLng) * cosRef * METERS_PER_DEG,
    y: (p.lat - refLat) * METERS_PER_DEG,
    i,
  }));
}

function makeDSU(n: number) {
  const parent = new Int32Array(n);
  const size = new Int32Array(n).fill(1);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    let ra = find(a);
    let rb = find(b);
    if (ra === rb) return;
    if (size[ra] < size[rb]) {
      const t = ra;
      ra = rb;
      rb = t;
    }
    parent[rb] = ra;
    size[ra] += size[rb];
  };
  return { find, union };
}

/**
 * Single-linkage clusters of `points` at `radiusM`, as indices into the INPUT
 * array. Non-finite points belong to no cluster and are simply absent.
 * Clusters are ordered by their smallest member index and their members
 * ascending, so the output is deterministic.
 */
export function clusterIndices(points: LL[], radiusM: number): number[][] {
  const pts = projectAll(points);
  if (pts.length === 0) return [];
  const r = Number.isFinite(radiusM) && radiusM > 0 ? radiusM : 0;
  const cell = Math.max(r, MIN_CELL);
  const grid = new Map<string, number[]>();
  for (let k = 0; k < pts.length; k++) {
    const key = Math.floor(pts[k].x / cell) + ":" + Math.floor(pts[k].y / cell);
    const bucket = grid.get(key);
    if (bucket) bucket.push(k);
    else grid.set(key, [k]);
  }

  const dsu = makeDSU(pts.length);
  for (let k = 0; k < pts.length; k++) {
    const gx = Math.floor(pts[k].x / cell);
    const gy = Math.floor(pts[k].y / cell);
    // Cells are radius-sized, so every point within r sits in this 3x3 block.
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(gx + dx + ":" + (gy + dy));
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= k) continue; // each unordered pair once
          if (dsu.find(j) === dsu.find(k)) continue; // already linked
          if (Math.hypot(pts[j].x - pts[k].x, pts[j].y - pts[k].y) <= r) dsu.union(k, j);
        }
      }
    }
  }

  const byRoot = new Map<number, number[]>();
  for (let k = 0; k < pts.length; k++) {
    const root = dsu.find(k);
    const members = byRoot.get(root);
    if (members) members.push(pts[k].i);
    else byRoot.set(root, [pts[k].i]);
  }
  return Array.from(byRoot.values());
}

/**
 * Sizes of the animal groups in a point cloud, largest first. Two animals
 * within `radiusM` metres of each other are in one group (transitively).
 */
export function groupSizes(points: LL[], radiusM = 5): number[] {
  return clusterIndices(points, radiusM)
    .map((c) => c.length)
    .sort((a, b) => b - a);
}

/** Distribution of group sizes over four fixed bins. Always four bins, even
 *  when empty — a missing bin would read as "not measured". */
export function histogram(sizes: number[]): GroupBin[] {
  const bins: GroupBin[] = [
    { label: "1", min: 1, max: 1, count: 0, animals: 0 },
    { label: "2–5", min: 2, max: 5, count: 0, animals: 0 },
    { label: "6–20", min: 6, max: 20, count: 0, animals: 0 },
    { label: "21+", min: 21, max: null, count: 0, animals: 0 },
  ];
  for (const raw of sizes) {
    if (!Number.isFinite(raw)) continue;
    const n = Math.floor(raw);
    if (n < 1) continue;
    const bin = n === 1 ? bins[0] : n <= 5 ? bins[1] : n <= 20 ? bins[2] : bins[3];
    bin.count++;
    bin.animals += n;
  }
  return bins;
}
