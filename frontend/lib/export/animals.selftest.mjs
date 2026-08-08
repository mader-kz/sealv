#!/usr/bin/env node
/**
 * Self-test for lib/export/animals.ts — no test runner.
 *
 * Compiles animals.ts with tsc into a temp dir, imports the compiled module,
 * and asserts the export contract on synthetic footages. Run from frontend/:
 *
 *   node lib/export/animals.selftest.mjs
 *
 * Exit code 0 = the contract holds.
 *
 * Contract:
 *   1) one feature per placed, non-false-positive detection — nothing else;
 *   2) coordinates are [lng, lat] (GIS order), not [lat, lng];
 *   3) properties are exactly {sortie, date, status, score, run_id};
 *   4) the serialized GeoJSON survives a JSON.parse round-trip unchanged;
 *   5) CSV has the header plus one row per feature, same filter, same order;
 *   6) commas and quotes in a filename cannot break a CSV row;
 *   7) empty input yields an empty FeatureCollection and a header-only CSV.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = mkdtempSync(path.join(tmpdir(), "animals-selftest-"));

execFileSync(
  "npx",
  [
    "tsc",
    "lib/export/animals.ts",
    "--outDir",
    outDir,
    "--module",
    "es2020",
    "--target",
    "es2020",
    "--moduleResolution",
    "node",
    "--lib",
    "es2020,dom",
    "--skipLibCheck",
  ],
  { cwd: frontendDir, stdio: "inherit" }
);

const mod = await import(pathToFileURL(path.join(outDir, "export", "animals.js")).href);
const { buildAnimalsGeoJSON, buildAnimalsCSV, csvCell } = mod;

let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) console.log(`  ok  ${name}`);
  else { failed++; console.error(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`); }
};

const det = (id, footageId, lat, lng, status, confidence) => ({
  id, footageId, t: 0, lat, lng, count: 1, confidence, status,
});

const footages = [
  {
    id: "f1",
    filename: 'sortie, "north".mp4', // comma + quotes: the CSV killer
    size: 1, duration: 38, uploadedAt: "2026-04-11T08:20:00.000Z",
    center: { lat: 44.6, lng: 50.2 },
    status: "ready", source: "real", runId: "run-7",
    track: [],
    detections: [
      det("d1", "f1", 44.61, 50.21, "auto", 0.81),
      det("d2", "f1", 44.62, 50.22, "validated", 0.94),
      det("d3", "f1", 44.63, 50.23, "false_positive", 0.4), // excluded: a verdict
      det("d4", "f1", Number.NaN, 50.24, "auto", 0.7), // excluded: unplaced
    ],
  },
  {
    id: "f2",
    filename: "sortie-2.mp4",
    size: 1, duration: 12, uploadedAt: "2026-04-12T09:00:00.000Z",
    center: { lat: 45.1, lng: 51.9 },
    status: "ready", source: "test",
    track: [],
    detections: [det("d5", "f2", 45.11, 51.91, "auto", Number.NaN)], // score unknown
  },
];

const fc = buildAnimalsGeoJSON(footages);

ok("collection is a FeatureCollection", fc.type === "FeatureCollection");
ok("3 of 5 detections exported (false positive + unplaced dropped)", fc.features.length === 3, `got ${fc.features.length}`);
ok("every feature is a Point", fc.features.every((f) => f.type === "Feature" && f.geometry.type === "Point"));

const first = fc.features[0];
ok("coordinates are [lng, lat]", first.geometry.coordinates[0] === 50.21 && first.geometry.coordinates[1] === 44.61,
  JSON.stringify(first.geometry.coordinates));
ok("properties are exactly the agreed five",
  JSON.stringify(Object.keys(first.properties).sort()) === JSON.stringify(["date", "run_id", "score", "sortie", "status"]),
  Object.keys(first.properties).join(","));
ok("sortie/date/status/score/run_id carry through",
  first.properties.sortie === 'sortie, "north".mp4' &&
  first.properties.date === "2026-04-11T08:20:00.000Z" &&
  first.properties.status === "auto" &&
  first.properties.score === 0.81 &&
  first.properties.run_id === "run-7");
ok("a non-finite score becomes null, never 0", fc.features[2].properties.score === null, String(fc.features[2].properties.score));
ok("a sortie with no run_id exports null", fc.features[2].properties.run_id === null);

const text = JSON.stringify(fc, null, 2);
const round = JSON.parse(text);
ok("JSON.parse round-trip is byte-identical", JSON.stringify(round) === JSON.stringify(fc));
ok("round-trip keeps 3 features with numeric coordinates",
  round.features.length === 3 && round.features.every((f) => f.geometry.coordinates.every((n) => typeof n === "number")));

const csv = buildAnimalsCSV(footages);
const lines = csv.split("\n");
ok("CSV header is lat,lng,status,score,sortie,date", lines[0] === "lat,lng,status,score,sortie,date", lines[0]);
ok("CSV has one row per feature", lines.length === fc.features.length + 1, `${lines.length - 1} rows`);
ok("CSV row order matches the collection", lines[1].startsWith("44.61,50.21,auto,0.81,"), lines[1]);
ok("a filename with a comma is quoted and doubled", lines[1].includes('"sortie, ""north"".mp4"'), lines[1]);
ok("splitting the quoted row on commas cannot yield 6 naive fields",
  lines[1].split(",").length > 6); // proves the quoting is load-bearing, not decorative
ok("an unknown score is an empty cell, not 0", lines[3].split(",")[3] === "", lines[3]);
ok("csvCell leaves plain values alone", csvCell("plain") === "plain" && csvCell(null) === "" && csvCell(3) === "3");

const empty = buildAnimalsGeoJSON([]);
ok("empty input is still a valid FeatureCollection",
  empty.type === "FeatureCollection" && empty.features.length === 0 && JSON.parse(JSON.stringify(empty)).features.length === 0);
ok("empty input CSV is the header alone", buildAnimalsCSV([]) === "lat,lng,status,score,sortie,date");

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log("\nanimals.ts: export contract holds");
