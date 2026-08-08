/**
 * colony.ts — pure geometry for seal haul-out ("colony") outlines.
 *
 * Detections are individual animals (lat/lng). On the map we want colonies
 * drawn as areas, not a soup of dots. This module turns a point cloud into:
 *   - colonyHull:   a concave outline that follows the shape of a haul-out
 *                   stretched along the waterline (a convex hull would bridge
 *                   across open water and overstate the area),
 *   - colonyBounds: the bounding box,
 *   - expandHull:   an outward buffer so the outline breathes around points.
 *
 * Everything is pure, dependency-free and DOM-free. Math runs in a local
 * metric projection (equirectangular around the cluster's mid-latitude):
 * x = (lng - refLng) * cos(refLat) * M, y = (lat - refLat) * M, where M is
 * meters per degree of latitude — otherwise east–west distances are inflated
 * away from the equator.
 *
 * Concave hull algorithm: convex hull (Andrew's monotone chain) followed by
 * iterative edge carving toward the nearest interior point (Park–Oh style
 * dig-in). An edge is carved only when
 *   edgeLength / min(dist(candidate, edgeEnd)) > concavity,
 * the carved-off triangle contains no other point (so no point is ever
 * stranded outside the outline), and the polygon stays simple. Every carve
 * consumes one interior point and every rejected edge is marked dead, so the
 * loop provably terminates; a hard iteration cap guards it regardless.
 */

export type LL = { lat: number; lng: number };

export type ColonyBounds = {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
};

export type ColonyHullOptions = {
  /**
   * Dig-in threshold: an edge is carved toward its nearest interior point only
   * when edgeLength / decisionDistance exceeds this. Lower = tighter, more
   * concave outline; Infinity = plain convex hull. Default 2.
   */
  concavity?: number;
  /**
   * Hard safety cap on carve iterations. The algorithm terminates on its own;
   * this is a belt-and-braces guard. Default 8 * points.length + 64.
   */
  maxIterations?: number;
};

/** Meters per degree of latitude (spherical Earth approximation). */
const METERS_PER_DEG = 111320;
/** Distance epsilon, meters. */
const EPS = 1e-9;
/** Signed-area epsilon, m² — below this a triangle is treated as degenerate. */
const AREA_EPS = 1e-7;

/** Projected point; `i` indexes back into the sanitized input array. */
type XY = { x: number; y: number; i: number };

type Frame = { refLat: number; refLng: number; cosRef: number };

function isFiniteLL(p: LL): boolean {
  return Number.isFinite(p.lat) && Number.isFinite(p.lng);
}

/** Drop non-finite and exact-duplicate points; keeps first-occurrence order. */
function sanitize(points: LL[]): LL[] {
  const seen = new Set<string>();
  const out: LL[] = [];
  for (const p of points) {
    if (!isFiniteLL(p)) continue;
    const key = p.lat + "," + p.lng;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function frameFor(points: LL[]): Frame {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  const refLat = (minLat + maxLat) / 2;
  const refLng = (minLng + maxLng) / 2;
  // Clamp so a (nonsensical) polar cluster cannot divide east–west by ~zero.
  const cosRef = Math.max(Math.cos((refLat * Math.PI) / 180), 0.01);
  return { refLat, refLng, cosRef };
}

function project(p: LL, f: Frame, i: number): XY {
  return {
    x: (p.lng - f.refLng) * f.cosRef * METERS_PER_DEG,
    y: (p.lat - f.refLat) * METERS_PER_DEG,
    i,
  };
}

function unproject(x: number, y: number, f: Frame): LL {
  return {
    lat: f.refLat + y / METERS_PER_DEG,
    lng: f.refLng + x / (f.cosRef * METERS_PER_DEG),
  };
}

/** Cross product of (a - o) x (b - o); >0 means b is left of ray o->a. */
function crossXY(o: XY, a: XY, b: XY): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function dist(a: XY, b: XY): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function distToSegment(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < EPS * EPS) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Unsigned shoelace area (m²) of an open ring in projected space. */
function shoelace(pts: XY[]): number {
  let s = 0;
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k];
    const b = pts[(k + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

function pointStrictlyInTriangle(p: XY, a: XY, b: XY, c: XY): boolean {
  const s1 = crossXY(a, b, p);
  const s2 = crossXY(b, c, p);
  const s3 = crossXY(c, a, p);
  return (
    (s1 > AREA_EPS && s2 > AREA_EPS && s3 > AREA_EPS) ||
    (s1 < -AREA_EPS && s2 < -AREA_EPS && s3 < -AREA_EPS)
  );
}

/**
 * Strict ("proper") segment intersection: interiors cross. Touching at an
 * endpoint or collinear overlap does not count.
 */
function properIntersect(a: XY, b: XY, c: XY, d: XY): boolean {
  const d1 = crossXY(c, d, a);
  const d2 = crossXY(c, d, b);
  const d3 = crossXY(a, b, c);
  const d4 = crossXY(a, b, d);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

/**
 * Collinearity epsilon (m²) scaled to the point cloud. Absolute coordinates
 * sit at ~45–50 degrees, so double rounding alone perturbs a projected point
 * by ~1e-9 m; cross products of a truly collinear cloud then carry noise of
 * ~1e-9 * extent. A wide safety factor on top of that still stays far below
 * any physically real polygon area.
 */
function collinearEps(pts: XY[]): number {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const extent = Math.max(maxX - minX, maxY - minY);
  return Math.max(AREA_EPS, 1e-6 * extent);
}

/**
 * Andrew's monotone chain. Returns the hull counter-clockwise, collinear
 * vertices dropped (within `eps` of zero turn area), without a closing
 * duplicate. [] when degenerate.
 */
function convexHullXY(pts: XY[], eps: number): XY[] {
  if (pts.length < 3) return [];
  const s = pts.slice().sort((p, q) => p.x - q.x || p.y - q.y);
  const lower: XY[] = [];
  for (const p of s) {
    while (
      lower.length >= 2 &&
      crossXY(lower[lower.length - 2], lower[lower.length - 1], p) <= eps
    ) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: XY[] = [];
  for (let i = s.length - 1; i >= 0; i--) {
    const p = s[i];
    while (
      upper.length >= 2 &&
      crossXY(upper[upper.length - 2], upper[upper.length - 1], p) <= eps
    ) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  return hull.length < 3 ? [] : hull;
}

/** True when segment p-q properly crosses any hull edge it does not touch. */
function crossesHull(p: XY, q: XY, hull: XY[]): boolean {
  for (let k = 0; k < hull.length; k++) {
    const c = hull[k];
    const d = hull[(k + 1) % hull.length];
    if (c === p || c === q || d === p || d === q) continue;
    if (properIntersect(p, q, c, d)) return true;
  }
  return false;
}

/** Iterative dig-in of long convex-hull edges toward interior points. */
function carve(
  startHull: XY[],
  all: XY[],
  concavity: number,
  maxIterations: number
): XY[] {
  let hull = startHull;
  const onHull = new Set<number>(hull.map((v) => v.i));
  let interior = all.filter((p) => !onHull.has(p.i));
  const dead = new Set<string>();
  let iterations = 0;

  while (interior.length > 0 && iterations < maxIterations) {
    iterations++;

    // Longest still-live edge (deterministic: earliest index wins ties).
    let edgeIdx = -1;
    let edgeLen = -1;
    for (let k = 0; k < hull.length; k++) {
      const a = hull[k];
      const b = hull[(k + 1) % hull.length];
      if (dead.has(a.i + ":" + b.i)) continue;
      const L = dist(a, b);
      if (L > edgeLen + EPS) {
        edgeLen = L;
        edgeIdx = k;
      }
    }
    if (edgeIdx < 0) break; // every edge settled

    const a = hull[edgeIdx];
    const b = hull[(edgeIdx + 1) % hull.length];
    const key = a.i + ":" + b.i;

    // Nearest interior point to this edge...
    let cand: XY | null = null;
    let candD = Infinity;
    for (const q of interior) {
      const d = distToSegment(q, a, b);
      if (d < candD) {
        candD = d;
        cand = q;
      }
    }
    if (cand === null) {
      dead.add(key);
      continue;
    }

    // ...pulled inward until the carved-off triangle (a, b, cand) holds no
    // other interior point — a carve must never strand a point outside.
    for (let guard = 0; guard < interior.length; guard++) {
      let better: XY | null = null;
      let betterD = Infinity;
      for (const q of interior) {
        if (q === cand || !pointStrictlyInTriangle(q, a, b, cand)) continue;
        const d = distToSegment(q, a, b);
        if (d < betterD) {
          betterD = d;
          better = q;
        }
      }
      if (better === null) break;
      cand = better;
    }

    const decision = Math.min(dist(cand, a), dist(cand, b));
    if (decision < EPS || edgeLen / decision <= concavity) {
      dead.add(key);
      continue;
    }
    // Keep the polygon simple: new edges must not cross existing ones.
    if (crossesHull(a, cand, hull) || crossesHull(cand, b, hull)) {
      dead.add(key);
      continue;
    }

    hull = hull.slice(0, edgeIdx + 1).concat([cand], hull.slice(edgeIdx + 1));
    const consumed = cand;
    interior = interior.filter((q) => q !== consumed);
  }

  return hull;
}

/**
 * Concave outline of a colony from per-animal detection points.
 *
 * Returns hull vertices counter-clockwise as fresh {lat,lng} objects taken
 * from the input coordinates (no reprojection loss). The ring is open — the
 * last point does NOT repeat the first; the consumer closes it.
 *
 * Fewer than 3 distinct finite points, or a fully collinear cloud, yield []
 * (no polygon exists — we do not invent one).
 */
export function colonyHull(points: LL[], opts: ColonyHullOptions = {}): LL[] {
  const clean = sanitize(points);
  if (clean.length < 3) return [];
  const f = frameFor(clean);
  const pts = clean.map((p, i) => project(p, f, i));
  const eps = collinearEps(pts);
  let hull = convexHullXY(pts, eps);
  if (hull.length < 3) return [];
  // Belt and braces: a hull whose area drowns in coordinate noise is a line.
  if (shoelace(hull) < eps) return [];
  const concavity = opts.concavity ?? 2;
  if (Number.isFinite(concavity)) {
    const maxIterations = opts.maxIterations ?? 8 * pts.length + 64;
    hull = carve(hull, pts, concavity, maxIterations);
  }
  return hull.map((v) => ({ lat: clean[v.i].lat, lng: clean[v.i].lng }));
}

/** Convex baseline (same contract as colonyHull) — useful for comparison. */
export function convexHull(points: LL[]): LL[] {
  return colonyHull(points, { concavity: Infinity });
}

/** Bounding box over finite points; null when there are none. */
export function colonyBounds(points: LL[]): ColonyBounds | null {
  let found = false;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of points) {
    if (!isFiniteLL(p)) continue;
    found = true;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return found ? { minLat, maxLat, minLng, maxLng } : null;
}

/**
 * Buffer a hull outward by ~`meters`: each vertex slides away from the vertex
 * centroid in the local metric projection (cos(lat)-corrected), so the outline
 * breathes around the points instead of hugging them. Negative meters shrink;
 * do not shrink by more than the hull radius. Inputs with fewer than 3
 * vertices are returned as copies unchanged (no polygon to buffer).
 */
export function expandHull(hull: LL[], meters: number): LL[] {
  const clean = hull.filter(isFiniteLL);
  if (clean.length < 3 || !Number.isFinite(meters) || meters === 0) {
    return clean.map((p) => ({ lat: p.lat, lng: p.lng }));
  }
  const f = frameFor(clean);
  const pts = clean.map((p, i) => project(p, f, i));
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pts.length;
  cy /= pts.length;
  return pts.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const len = Math.hypot(dx, dy);
    if (len < EPS) return { lat: clean[p.i].lat, lng: clean[p.i].lng };
    const k = meters / len;
    return unproject(p.x + dx * k, p.y + dy * k, f);
  });
}

/**
 * Planar polygon area in m² (shoelace in the local metric projection).
 * Expects an open ring; a closing duplicate is tolerated (zero-length term).
 */
export function polygonAreaM2(polygon: LL[]): number {
  const clean = polygon.filter(isFiniteLL);
  if (clean.length < 3) return 0;
  const f = frameFor(clean);
  const pts = clean.map((p, i) => project(p, f, i));
  return shoelace(pts);
}
