#!/usr/bin/env node
/**
 * Self-test for lib/export/pdf.ts — no test runner.
 *
 * Compiles pdf.ts (CommonJS, so node can take the JSON imports) and builds a
 * report in all three languages. Run from frontend/:
 *
 *   node lib/export/pdf.selftest.mjs
 *
 * Exit code 0 = the report is a real PDF and says what it should.
 *
 * Contract:
 *   1) builds for kk/ru/en and for an empty survey, without throwing;
 *   2) the Unicode font is embedded (FontFile2) — helvetica has no Cyrillic,
 *      and mojibake is the failure this whole font detour exists to prevent;
 *   3) with pdftotext available: the Kazakh/Russian title and glyphs come back
 *      out of the PDF byte-identical, the measured figures are on the page,
 *      the engine's caveat is there verbatim, and none of the deleted
 *      fictions (forecast, anomalies, sector codename, avg group) are.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/* Compiled inside node_modules, not /tmp: the module require()s jspdf at run
   time, and node resolves that from where the file sits. */
const outDir = mkdtempSync(path.join(frontendDir, "node_modules", ".pdf-selftest-"));
process.on("exit", () => rmSync(outDir, { recursive: true, force: true }));

execFileSync(
  "npx",
  [
    "tsc",
    "lib/export/pdf.ts",
    "--outDir",
    outDir,
    "--module",
    "commonjs",
    "--target",
    "es2020",
    "--moduleResolution",
    "node",
    "--resolveJsonModule",
    "--esModuleInterop",
    "--skipLibCheck",
    "--lib",
    "es2020,dom",
  ],
  { cwd: frontendDir, stdio: "inherit" }
);

const require_ = createRequire(path.join(frontendDir, "package.json"));
const { buildReportDoc } = require_(path.join(outDir, "export", "pdf.js"));

let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) console.log(`  ok  ${name}`);
  else { failed++; console.error(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`); }
};

const det = (id, status) => ({ id, footageId: "f1", t: 0, lat: 44.6, lng: 50.2, count: 1, confidence: 0.8, status });

const footages = [
  {
    id: "f1", filename: "sortie-01.mp4", size: 1, duration: 38,
    uploadedAt: "2026-04-11T08:20:00.000Z", center: { lat: 44.61234, lng: 50.21987 },
    status: "ready", source: "real", runId: "run-7",
    track: [], unplaced: 2,
    band: { low: 12, best: 14, high: 17, basis: "union_4_frames" },
    detections: [det("d1", "auto"), det("d2", "validated"), det("d3", "false_positive")],
    areaM2: 33180, gsdSource: "optics",
    caveats: ["GSD estimated from altitude only"],
  },
  {
    id: "f2", filename: "sortie-02.mp4", size: 1, duration: 12,
    uploadedAt: "2026-04-12T09:00:00.000Z", center: { lat: 45.1, lng: 51.9 },
    status: "ready", source: "test",
    track: [], detections: [det("d4", "auto")],
  },
];

const bytes = async (fs, lang) => Buffer.from((await buildReportDoc(fs, lang)).output("arraybuffer"));

const out = {};
for (const lang of ["kk", "ru", "en"]) {
  out[lang] = await bytes(footages, lang);
  ok(`${lang}: builds a PDF`, out[lang].subarray(0, 5).toString() === "%PDF-", out[lang].subarray(0, 8).toString());
  ok(`${lang}: embeds the Unicode font`, out[lang].toString("latin1").includes("FontFile2"));
}
const emptyPdf = await bytes([], "kk");
ok("an empty survey still produces a PDF", emptyPdf.subarray(0, 5).toString() === "%PDF-");

let pdftotext = true;
try { execFileSync("pdftotext", ["-v"], { stdio: "ignore" }); } catch { pdftotext = false; }

if (!pdftotext) {
  console.log("  --  pdftotext not installed: skipping the text-content assertions");
} else {
  const textOf = (buf) => {
    const f = path.join(outDir, `probe-${Math.random().toString(36).slice(2)}.pdf`);
    writeFileSync(f, buf);
    return execFileSync("pdftotext", [f, "-"], { encoding: "utf8" }).replace(/\s+/g, " ");
  };

  const kk = textOf(out.kk);
  const ru = textOf(out.ru);
  const en = textOf(out.en);

  ok("kk: the title survives the round-trip, glyph for glyph", kk.includes("Итбалық есебінің актісі"), kk.slice(0, 80));
  ok("kk: Kazakh-only letters render (ә ғ қ ң ө ұ ү і)", /Ұшулар/.test(kk) && /Күні/.test(kk), kk.slice(0, 200));
  ok("ru: the title survives the round-trip", ru.includes("Акт учёта тюленя"), ru.slice(0, 80));
  ok("en: the title is the English one", en.includes("Seal survey report"));
  ok("no character came back as a replacement glyph", ![kk, ru, en].some((t) => /�/.test(t)));

  ok("the band prints as low–best–high", en.includes("12–14–17"), en.slice(0, 400));
  ok("the basis is stated, not implied", en.includes("combined from 4 frames"));
  ok("a sortie without a band prints its reviewed count", /sortie-02\.mp4 [^ ]+ 1 /.test(en), en.slice(0, 600));
  ok("verified share is validated ÷ (validated + auto)", en.includes("50% (1/2)"), en.slice(0, 600));
  ok("animals without coordinates are declared", en.includes("2 without coordinates"));
  // One hectare formatter product-wide (lib/analytics/area.formatArea), so the
  // report cannot print a survey the panel that produced it renders differently.
  ok("area is reported in hectares", en.includes("3.3 ha"), en.slice(0, 600));
  ok(
    "the sorties missing from the area total are declared",
    en.includes("1 without GSD"),
    en.slice(0, 600),
  );
  ok("the engine's caveat appears verbatim", en.includes("GSD estimated from altitude only"));
  // The seal total is a sum over sorties, not a population estimate.
  ok("the total says a twice-flown colony is counted twice",
    en.includes("an animal seen on two sorties is counted twice"), en.slice(0, 600));
  ok("overlap between frames is declared", en.includes("overlap is not deduplicated"));
  ok("the method is stated", en.includes("CountGD detection"));
  ok("basis-less sorties say so", en.includes("basis not stated"));
  const emptyText = textOf(emptyPdf);
  ok("an empty survey says so rather than showing zeros", emptyText.includes("Есепке кіретін ұшу жоқ"));
  ok("an empty survey qualifies nothing, because it totals nothing", !emptyText.includes("екі рет есептеледі"), emptyText.slice(0, 200));

  const fictions = ["FORECAST", "Forecast", "AKTAU", "ANOMAL", "Avg group", "KPI"];
  for (const word of fictions) {
    ok(`the deleted fiction "${word}" is gone`, ![kk, ru, en].some((t) => t.includes(word)));
  }
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log("\npdf.ts: the report is honest, and it is legible in Kazakh");
