/**
 * pollution.selftest.mjs — the words the collector sends, and the words a
 * reader sees.
 *
 * This exists because three of them reached a trilingual screen in English and
 * nobody noticed until somebody photographed the tooltip: `exact`, a bare `m`
 * for metres, and a fixed English sentence — "Cause not yet determined." —
 * which the collector writes INSTEAD of leaving the field empty, so every
 * `root_cause || fallback` in the UI sailed straight past it. 37 of the 121
 * incidents on production carry that sentence today.
 *
 * The vocabulary below is therefore asserted against the values production
 * actually holds, counted from the live API rather than imagined:
 *   location_precision  exact 84 · approximate 30 · field 7
 *   kind                slick 42 · flare 40 · discharge 21 · spill 18
 *
 * Run: node lib/pollution.selftest.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "pollution-selftest-"));

execFileSync(
  "npx",
  ["tsc", "lib/pollution.ts", "--outDir", outDir, "--rootDir", "lib",
   "--module", "es2020", "--target", "es2020", "--moduleResolution", "node",
   "--lib", "es2020,dom", "--skipLibCheck", "--resolveJsonModule",
   "--esModuleInterop", "--strict"],
  { cwd: frontendDir, stdio: "inherit" },
);

const { hasRootCause, precisionKey, kindKey } =
  await import(pathToFileURL(path.join(outDir, "pollution.js")).href);

const dict = JSON.parse(readFileSync(path.join(frontendDir, "lib/i18n.dict.json"), "utf8"));

let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}${extra ? " — " + extra : ""}`); failed++; }
};

/* ------------------------------------------------ the placeholder sentence */
ok("the collector's placeholder is not a cause",
   hasRootCause("Cause not yet determined.") === false);
ok("...whatever its case or full stop", ["cause not yet determined",
   "CAUSE NOT YET DETERMINED.", "  Cause Not Yet Determined.  "]
   .every((s) => hasRootCause(s) === false));
ok("an empty field is not a cause",
   [null, undefined, "", "   "].every((s) => hasRootCause(s) === false));
ok("a real cause survives",
   hasRootCause("Ruptured pipeline at the Kalamkas field") === true);
/* The guard must not swallow a sentence that merely mentions the words. */
ok("a cause that discusses determination is still a cause",
   hasRootCause("Operator says the cause is not yet determined by the regulator") === true);

/* ----------------------------------------------------- location precision */
ok("the three values production holds are all mapped",
   ["exact", "approximate", "field"].every((v) => typeof precisionKey(v) === "string"));
ok("case and padding do not matter", precisionKey(" Exact ") === precisionKey("exact"));
ok("absent precision has its own word", precisionKey("") === "pollution.precisionUnknown");
ok("an unmapped value returns null so the caller can show it verbatim",
   precisionKey("satellite-derived") === null);

/* ------------------------------------------------------------------ kinds */
ok("every kind production holds is mapped",
   ["slick", "flare", "discharge", "spill"]
     .map((k) => kindKey(k))
     .every((key) => key !== "pollution.kindOther"));
ok("an unknown kind falls to the catch-all, not to raw text",
   kindKey("tar_ball") === "pollution.kindOther" && kindKey(null) === "pollution.kindOther");

/* --------------------------------------- every key exists in all 3 locales */
{
  const keys = [
    ...["exact", "approximate", "field", ""].map((v) => precisionKey(v)),
    ...["slick", "flare", "discharge", "spill", "unknown"].map((v) => kindKey(v)),
    "pollution.causeUnknown", "unit.m",
  ].filter(Boolean);
  const langs = ["kk", "ru", "en"];
  const missing = [];
  for (const k of keys) for (const l of langs) if (!dict[l]?.[k]) missing.push(`${l}:${k}`);
  ok("every key this module returns is translated in all three languages",
     missing.length === 0, missing.join(", "));
  /* A key that exists but reads as English in Russian is the bug wearing a
     different hat, so the metre is checked for its actual glyph. */
  ok("metres are metres in Russian and Kazakh",
     dict.ru["unit.m"] === "м" && dict.kk["unit.m"] === "м",
     `ru=${dict.ru["unit.m"]} kk=${dict.kk["unit.m"]}`);
  ok("the precision labels are not English in the Cyrillic locales",
     ["pollution.precisionExact", "pollution.precisionApproximate", "pollution.precisionField"]
       .every((k) => /[а-яёәғқңөұүһі]/i.test(dict.ru[k]) && /[а-яёәғқңөұүһі]/i.test(dict.kk[k])));
}

console.log(failed
  ? `\n${failed} assertion(s) failed`
  : "\npollution.ts: the collector's words become the reader's, in the reader's language");
process.exit(failed ? 1 : 0);
