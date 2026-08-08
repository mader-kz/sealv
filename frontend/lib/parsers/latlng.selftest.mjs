#!/usr/bin/env node
/**
 * Self-test for lib/parsers/latlng.ts — no test runner.
 *
 * The forms below are not invented: they are what the tools the field team
 * already uses actually produce. The canonical `43.65,51.18` — Google Maps,
 * and by a wide margin the most common paste — is here because the previous
 * parser rejected exactly that one while accepting four rarer spellings, and
 * nothing caught it.
 *
 *   node lib/parsers/latlng.selftest.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = mkdtempSync(path.join(tmpdir(), "latlng-selftest-"));

execFileSync(
  "npx",
  /* `--rootDir lib` pins the output layout. Without it tsc infers the root
     from the inputs, and a module with no imports lands at the top of outDir
     while one that imports a sibling lands a directory down — so the import
     below would break the day this file grows a dependency. */
  ["tsc", "lib/parsers/latlng.ts", "--outDir", outDir, "--rootDir", "lib",
   "--module", "es2020", "--target", "es2020", "--moduleResolution", "node",
   "--lib", "es2020", "--skipLibCheck"],
  { cwd: frontendDir, stdio: "inherit" },
);

const { parseLatLng } = await import(
  pathToFileURL(path.join(outDir, "parsers", "latlng.js")).href
);

let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) console.log(`  ok  ${name}`);
  else { failed++; console.error(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`); }
};

const near = (a, b) => typeof a === "number" && Math.abs(a - b) < 1e-9;
const parses = (text, lat, lng) => {
  const p = parseLatLng(text);
  ok(`${JSON.stringify(text)} → ${lat}, ${lng}`, !!p && near(p.lat, lat) && near(p.lng, lng),
    JSON.stringify(p));
};
const refuses = (text) =>
  ok(`${JSON.stringify(text)} is refused`, parseLatLng(text) === null,
    JSON.stringify(parseLatLng(text)));

/* --------------------------------------------------- the forms people paste */
parses("43.65, 51.18", 43.65, 51.18);   // Google Maps
parses("43.65,51.18", 43.65, 51.18);    // the same, space stripped — the regression
parses("43.65 51.18", 43.65, 51.18);    // a GPS readout
parses("43,65 51,18", 43.65, 51.18);    // decimal comma (ru/kk locale device)
parses("43,65, 51,18", 43.65, 51.18);   // decimal comma AND comma separator
parses("43.65; 51.18", 43.65, 51.18);   // semicolon
parses("  43.65 ,  51.18  ", 43.65, 51.18);
parses("43,65,51,18", 43.65, 51.18);    // every separator a comma, still two numbers

/* Whole degrees, negatives, and the edges of the globe. */
parses("43 51", 43, 51);
parses("-43.65, -51.18", -43.65, -51.18);
parses("-90, 180", -90, 180);
parses("90,-180", 90, -180);
parses("0,0", 0, 0);

/* ------------------------------------------------------- what is not a pair */
refuses("");
refuses("   ");
refuses("43.65");                 // one number is not a place
refuses("43.65, 51.18, 12");      // three is not a pair either
refuses("aktau");
refuses("43.65, north");
refuses("43.65N 51.18E");         // hemisphere letters are a different notation
refuses("1e2, 3");                // exponent form is not a coordinate anybody types

/* Out of range is refused here, not clamped later: a latitude of 450 is a typo,
   and clamping it puts a pin somebody has to explain. */
refuses("450, 51.18");
refuses("43.65, 1000");
refuses("-91, 0");
refuses("0, 180.0001");

/* Not a crash on hostile input. */
ok("null input is refused, not thrown", parseLatLng(null) === null);
ok("undefined input is refused, not thrown", parseLatLng(undefined) === null);

/* Precision is preserved exactly — the readout prints what is stored and the
   exports carry it, so a rounded parse would be a silent truncation. */
const precise = parseLatLng("43.6512345, 51.1898765");
ok("a typed coordinate keeps every digit",
  !!precise && precise.lat === 43.6512345 && precise.lng === 51.1898765,
  JSON.stringify(precise));

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log("\nlatlng.ts: every form the field actually types parses");
