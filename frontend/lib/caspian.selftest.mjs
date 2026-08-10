/**
 * caspian.selftest.mjs — the water mask, checked against places that exist.
 *
 * This file exists because the mask failed silently for months and only the
 * environment layer made it visible: it called the Iranian coast water (28% of
 * the collected grid landed on dry ground) and called Turkmenbashi, the
 * Kara-Bogaz throat and the whole north-east shelf land, so the eastern half of
 * the sea could never hold a sample. Nothing crashed. Nothing was red. The dots
 * were simply in the wrong places, and only a human looking at a satellite
 * basemap noticed.
 *
 * So the assertions below are named coastal places rather than abstract
 * geometry, and the last one guards the thing that makes the bug reappear: the
 * service carries its own copy of this polygon, and the two must agree or the
 * map draws one basin while the collector samples another.
 *
 * Run: node lib/caspian.selftest.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(here, "..");
const repoDir = path.resolve(frontendDir, "..");
const outDir = mkdtempSync(path.join(tmpdir(), "caspian-selftest-"));

execFileSync(
  "npx",
  ["tsc", "lib/caspian.ts", "--outDir", outDir, "--rootDir", "lib",
   "--module", "es2020", "--target", "es2020", "--moduleResolution", "node",
   "--lib", "es2020", "--skipLibCheck"],
  { cwd: frontendDir, stdio: "inherit" },
);

const { isWater, snapToWater, CASPIAN_HULL } =
  await import(pathToFileURL(path.join(outDir, "caspian.js")).href);

let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}${extra ? " — " + extra : ""}`); failed++; }
};

/* --------------------------------------------------------------- the sea */
/* Water, with a reason to be in the list: Tyuleniy and Tyub-Karagan are where
   the seals actually haul out, and the eastern three are the ones the old mask
   denied existed. */
const WATER = [
  ["Tyuleniy islands", 44.85, 50.35],
  ["Tyub-Karagan", 44.6, 50.3],
  ["off Aktau", 43.65, 50.9],
  ["north-east shelf", 46.5, 51.5],
  ["Turkmenbashi", 40.0, 53.0],
  ["central basin", 42.0, 50.5],
  ["south basin", 38.5, 51.5],
];
for (const [name, lat, lng] of WATER) ok(`${name} is water`, isWater(lat, lng), `${lat},${lng}`);

/* -------------------------------------------------------------- the land */
/* Dry ground the old mask called sea (the first) or that any mask must reject.
   Each one would have put a "measurement" marker on a city or a steppe. */
const LAND = [
  ["Rasht, Iran", 37.0, 48.0],
  ["steppe east of Aktau", 43.6, 52.5],
  ["Astrakhan", 47.2, 47.0],
  ["west of Baku", 40.4, 49.0],
  ["Kazakh steppe, north", 47.4, 52.0],
  ["Elbrus side, far west", 42.0, 46.2],
];
for (const [name, lat, lng] of LAND) ok(`${name} is not water`, !isWater(lat, lng), `${lat},${lng}`);

/* The eastern half must be reachable at all — the specific defect that made
   most of the sea unsampled was a hard longitude cut, and a polygon fix that
   left the cut in place would pass every point test above. */
ok("the mask extends past 52 E", WATER.some(([, , lng]) => lng > 52));

/* ------------------------------------------------------- the honesty rule */
ok("a water point is never moved", (() => {
  for (const [, lat, lng] of WATER) {
    const s = snapToWater(lat, lng);
    if (!s || s.lat !== lat || s.lng !== lng) return false;
  }
  return true;
})());
ok("no water within reach returns null, not an invented coordinate",
   snapToWater(30.0, 30.0) === null);

/* ------------------------------------------------- the two copies agree */
/* `service/env.py` samples the grid against its own copy of this polygon. If
   they drift, the collector fills a basin the map does not draw. */
{
  const py = readFileSync(path.join(repoDir, "service", "env.py"), "utf8");
  const block = py.match(/CASPIAN_HULL[^=]*=\s*\(([\s\S]*?)\n\)/);
  const pts = block
    ? [...block[1].matchAll(/\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/g)].map(
        (m) => [Number(m[1]), Number(m[2])],
      )
    : [];
  ok("the service carries the same outline", pts.length === CASPIAN_HULL.length &&
     pts.every(([x, y], i) => x === CASPIAN_HULL[i][0] && y === CASPIAN_HULL[i][1]),
     `service ${pts.length} vertices, frontend ${CASPIAN_HULL.length}`);
}

console.log(failed
  ? `\n${failed} assertion(s) failed`
  : "\ncaspian.ts: the mask agrees with the coastline, and with the service");
process.exit(failed ? 1 : 0);
