#!/usr/bin/env node
/**
 * Self-test for lib/colony.ts — no test runner.
 *
 * Compiles colony.ts with tsc into a temp dir, imports the compiled module,
 * and asserts the geometry invariants below with an independent
 * point-in-polygon implementation. Run from frontend/:
 *
 *   node lib/colony.selftest.mjs
 *
 * Exit code 0 = all invariants hold.
 *
 * Invariants:
 *   1) 100 m square -> hull of exactly the 4 corners, area ~ side²;
 *   2) 200 seeded-random points in a circle -> every point inside/on hull;
 *   3) crescent (two arcs) -> concave hull area noticeably below convex;
 *   4) 2 points -> [], 5 collinear points -> [];
 *   5) expandHull(square, 5 m) -> all original points strictly inside.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "colony-selftest-"));

execFileSync(
  "npx",
  [
    "tsc",
    "lib/colony.ts",
    "--outDir",
    outDir,
    "--module",
    "es2020",
    "--target",
    "es2020",
    "--moduleResolution",
    "node",
    "--skipLibCheck",
    "--types",
    "node",
  ],
  { cwd: frontendDir, stdio: "inherit" }
);

const mod = await import(pathToFileURL(path.join(outDir, "colony.js")).href);
const { colonyHull, convexHull, colonyBounds, expandHull, polygonAreaM2 } = mod;

/* ---------- independent reference helpers (deliberately re-implemented) --- */

const M = 111320; // meters per degree of latitude

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function metersToLL(lat0, lng0, dxM, dyM) {
  const cos = Math.cos((lat0 * Math.PI) / 180);
  return { lat: lat0 + dyM / M, lng: lng0 + dxM / (M * cos) };
}

function frame(points) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  const refLat = (minLat + maxLat) / 2;
  const refLng = (minLng + maxLng) / 2;
  return { refLat, refLng, cos: Math.cos((refLat * Math.PI) / 180) };
}

function proj(p, f) {
  return { x: (p.lng - f.refLng) * f.cos * M, y: (p.lat - f.refLat) * M };
}

function distToSeg(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function rayCastInside(P, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (
      (a.y > P.y) !== (b.y > P.y) &&
      P.x < ((b.x - a.x) * (P.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** Inside the polygon, or within epsMeters of its boundary. */
function pointInOrOn(pt, polygon, epsM = 1e-6) {
  const f = frame(polygon);
  const P = proj(pt, f);
  const poly = polygon.map((v) => proj(v, f));
  for (let i = 0; i < poly.length; i++) {
    if (distToSeg(P, poly[i], poly[(i + 1) % poly.length]) <= epsM) return true;
  }
  return rayCastInside(P, poly);
}

/** Strictly inside: ray-cast inside AND farther than epsMeters from every edge. */
function pointStrictlyIn(pt, polygon, epsM = 1e-6) {
  const f = frame(polygon);
  const P = proj(pt, f);
  const poly = polygon.map((v) => proj(v, f));
  for (let i = 0; i < poly.length; i++) {
    if (distToSeg(P, poly[i], poly[(i + 1) % poly.length]) <= epsM) return false;
  }
  return rayCastInside(P, poly);
}

/* ---------- assertion harness ------------------------------------------- */

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`PASS  ${name}${detail ? `  [${detail}]` : ""}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `  [${detail}]` : ""}`);
  }
}

/* ---------- case 1: 100 m square ----------------------------------------- */
{
  const side = 100;
  const square = [
    [0, 0],
    [side, 0],
    [side, side],
    [0, side],
  ].map(([dx, dy]) => metersToLL(44.6, 50.3, dx, dy));

  const hull = colonyHull(square);
  check("case1: square hull has 4 vertices", hull.length === 4, `got ${hull.length}`);

  const area = polygonAreaM2(hull);
  check(
    "case1: hull area ~ side^2",
    Math.abs(area - side * side) / (side * side) < 0.02,
    `area=${area.toFixed(2)} m^2, expected ~${side * side} m^2`
  );

  const open =
    hull.length > 0 &&
    (hull[0].lat !== hull[hull.length - 1].lat || hull[0].lng !== hull[hull.length - 1].lng);
  check("case1: ring is open (last point does not repeat first)", open);

  const allCorners = square.every((p) =>
    hull.some((h) => Math.abs(h.lat - p.lat) < 1e-12 && Math.abs(h.lng - p.lng) < 1e-12)
  );
  check("case1: hull vertices are exactly the input corners", allCorners);

  const b = colonyBounds(square);
  const boundsOk =
    b !== null &&
    b.minLat === Math.min(...square.map((p) => p.lat)) &&
    b.maxLat === Math.max(...square.map((p) => p.lat)) &&
    b.minLng === Math.min(...square.map((p) => p.lng)) &&
    b.maxLng === Math.max(...square.map((p) => p.lng));
  check("case1: colonyBounds matches min/max", boundsOk);
}

/* ---------- case 2: 200 seeded-random points in a circle ------------------ */
{
  const rand = mulberry32(42);
  const R = 300;
  const pts = [];
  for (let i = 0; i < 200; i++) {
    const r = R * Math.sqrt(rand());
    const t = 2 * Math.PI * rand();
    pts.push(metersToLL(44.5, 50.5, r * Math.cos(t), r * Math.sin(t)));
  }

  const hull = colonyHull(pts);
  check("case2: random-circle hull is a polygon", hull.length >= 3, `vertices=${hull.length}`);

  const outside = pts.filter((p) => !pointInOrOn(p, hull));
  check(
    "case2: all 200 points inside/on the concave hull",
    outside.length === 0,
    `${outside.length} outside`
  );
}

/* ---------- case 3: crescent — concave must beat convex ------------------- */
{
  const pts = [];
  for (let i = 0; i < 25; i++) {
    const t = (Math.PI * i) / 24; // outer arc, 0..180 deg, r = 100 m
    pts.push(metersToLL(44.5, 50.5, 100 * Math.cos(t), 100 * Math.sin(t)));
  }
  for (let i = 0; i < 25; i++) {
    const t = ((5 + (170 * i) / 24) * Math.PI) / 180; // inner arc, 5..175 deg, r = 70 m
    pts.push(metersToLL(44.5, 50.5, 70 * Math.cos(t), 70 * Math.sin(t)));
  }

  const concave = colonyHull(pts);
  const convex = convexHull(pts);
  const aConcave = polygonAreaM2(concave);
  const aConvex = polygonAreaM2(convex);
  check(
    "case3: concave hull area noticeably below convex",
    aConcave < 0.75 * aConvex,
    `concave=${aConcave.toFixed(0)} m^2, convex=${aConvex.toFixed(0)} m^2, ratio=${(
      aConcave / aConvex
    ).toFixed(2)}`
  );

  const outside = pts.filter((p) => !pointInOrOn(p, concave));
  check(
    "case3: all crescent points inside/on the concave hull",
    outside.length === 0,
    `${outside.length} outside`
  );
}

/* ---------- case 4: degenerate inputs ------------------------------------- */
{
  const two = colonyHull([
    { lat: 44, lng: 50 },
    { lat: 44.001, lng: 50.001 },
  ]);
  check("case4: 2 points -> []", two.length === 0, `got ${two.length}`);

  const line = Array.from({ length: 5 }, (_, i) => ({
    lat: 44 + i * 0.001,
    lng: 50 + i * 0.002,
  }));
  const collinear = colonyHull(line);
  check("case4: 5 collinear points -> []", collinear.length === 0, `got ${collinear.length}`);

  check("case4: colonyBounds([]) -> null", colonyBounds([]) === null);
}

/* ---------- case 5: expandHull buffer ------------------------------------- */
{
  const side = 10;
  const square = [
    [0, 0],
    [side, 0],
    [side, side],
    [0, side],
  ].map(([dx, dy]) => metersToLL(44.55, 50.25, dx, dy));

  const hull = colonyHull(square);
  const grown = expandHull(hull, 5);
  check("case5: expandHull keeps vertex count", grown.length === hull.length);

  const inside = square.every((p) => pointStrictlyIn(p, grown));
  check("case5: all original points strictly inside the 5 m buffer", inside);
}

/* ---------- summary ------------------------------------------------------- */

if (failures === 0) {
  console.log("\nALL INVARIANTS HOLD");
} else {
  console.error(`\n${failures} FAILURE(S)`);
  process.exitCode = 1;
}
