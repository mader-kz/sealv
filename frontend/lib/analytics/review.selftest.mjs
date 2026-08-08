#!/usr/bin/env node
/**
 * Self-test for lib/analytics/review.ts — no test runner.
 *
 *   node lib/analytics/review.selftest.mjs
 *
 * This module produces the number the review workflow is judged by, and it is
 * printed in five places (sortie row, inspector, dashboard, trust panel, PDF).
 * Two claims it must never confuse:
 *
 *   "0% reviewed"       — there is work and nobody has done it.
 *   "nothing to review" — there is no row a reviewer could open.
 *
 * And one it got wrong for a whole wave: a REJECTION is work done. Counted in
 * neither term, rejecting every animal of a sortie shrank the denominator to
 * zero and the panels printed "nothing to review" over a pass somebody had
 * just finished — the X key moved no figure in the product.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = mkdtempSync(path.join(tmpdir(), "review-selftest-"));

execFileSync(
  "npx",
  ["tsc", "lib/analytics/review.ts", "--outDir", outDir, "--rootDir", "lib",
   "--module", "es2020", "--target", "es2020", "--moduleResolution", "node",
   "--lib", "es2020", "--skipLibCheck"],
  { cwd: frontendDir, stdio: "inherit" },
);

const { reviewStats, seasonReviewStats, isAggregateMarker, pointIdOf } = await import(
  pathToFileURL(path.join(outDir, "analytics", "review.js")).href
);

let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) console.log(`  ok  ${name}`);
  else { failed++; console.error(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`); }
};

/** N detections of one status, with backend-shaped (reachable) ids. */
const rows = (status, n, from = 1) =>
  Array.from({ length: n }, (_, i) => ({ id: `run-7-p${from + i}`, status }));

/* ------------------------------------------------------- the reachable rows */
{
  const s = reviewStats({ detections: [...rows("auto", 300)] });
  ok("an untouched sortie is 0% of 300", s.pct === 0 && s.reviewable === 300 && s.ruled === 0,
    JSON.stringify(s));
}
{
  // The regression, stated as a test: 100 rejections out of 300.
  const s = reviewStats({ detections: [...rows("false_positive", 100), ...rows("auto", 200, 101)] });
  ok("100 rejections of 300 is a third done, not nothing done",
    s.rejected === 100 && s.ruled === 100 && s.reviewable === 300 && Math.round(s.pct) === 33,
    JSON.stringify(s));
  ok("and the rejections did not shrink the denominator", s.reviewable === 300, String(s.reviewable));
}
{
  const s = reviewStats({ detections: rows("false_positive", 300) });
  ok("rejecting every animal is a FINISHED review, not an empty one",
    s.pct === 100 && s.reviewable === 300 && s.ruled === 300 && s.verified === 0,
    JSON.stringify(s));
  ok("...and it is not 'nothing to review'", s.reviewable !== 0, String(s.reviewable));
}
{
  const s = reviewStats({
    detections: [...rows("validated", 3), ...rows("false_positive", 1, 4), ...rows("auto", 6, 5)],
  });
  ok("confirmed and rejected are reported separately as well as together",
    s.verified === 3 && s.rejected === 1 && s.ruled === 4 && s.reviewable === 10 && s.pct === 40,
    JSON.stringify(s));
}

/* ------------------------------------------------- what no reviewer can open */
{
  const s = reviewStats({ detections: [{ id: "run-11-agg", status: "auto", count: 562 }], unplaced: 562 });
  ok("an aggregate marker is not a reviewable row",
    s.reviewable === 0 && s.pct === null, JSON.stringify(s));
  ok("its animals are reported, not divided by",
    s.unreviewable === 562 && s.total === 562, JSON.stringify(s));
  ok("MAX not sum: 562 unplaced behind one marker is 562, never 1124",
    s.unreviewable === 562, String(s.unreviewable));
}
{
  // Test-shaped ids the service does not know: no verdict can reach them.
  const s = reviewStats({ detections: [{ id: "d1", status: "auto" }] });
  ok("a row the service never issued is not reviewable here",
    s.reviewable === 0 && s.pct === null, JSON.stringify(s));
}
{
  const s = reviewStats({ detections: [] });
  ok("no detections at all is nothing to review, not 0%",
    s.total === 0 && s.reviewable === 0 && s.pct === null, JSON.stringify(s));
}
ok("null and undefined do not throw",
  reviewStats(null).total === 0 && reviewStats(undefined).pct === null);

/* ------------------------------------------------------------- the identity */
ok("isAggregateMarker only matches the -agg suffix",
  isAggregateMarker({ id: "run-3-agg" }) === true &&
  isAggregateMarker({ id: "run-3-p9" }) === false &&
  isAggregateMarker({ id: "aggregate" }) === false &&
  isAggregateMarker(null) === false);
ok("pointIdOf reads the backend point id, or nothing",
  pointIdOf("run-7-p42") === 42 && pointIdOf("run-7-agg") === null &&
  pointIdOf("d1") === null && pointIdOf("") === null);
ok("point 0 is a real point id, not a falsy miss", pointIdOf("run-7-p0") === 0);

/* ------------------------------------------------------------- the season */
{
  const season = seasonReviewStats([
    { detections: [...rows("validated", 5), ...rows("auto", 5, 6)] },
    { detections: rows("false_positive", 10) },
    { detections: [{ id: "run-11-agg", status: "auto", count: 100 }], unplaced: 100 },
  ]);
  ok("a season sums animals, it does not average percentages",
    season.verified === 5 && season.rejected === 10 && season.ruled === 15 &&
    season.reviewable === 20 && season.pct === 75 && season.unreviewable === 100,
    JSON.stringify(season));
  ok("the season's total includes the animals nobody can reach",
    season.total === 120, String(season.total));
}
ok("an empty season is nothing to review, not 0%",
  seasonReviewStats([]).pct === null && seasonReviewStats(null).total === 0);

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log("\nreview.ts: a rejection is a ruling, and an unreachable row is not one");
