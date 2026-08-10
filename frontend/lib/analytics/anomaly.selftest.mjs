/**
 * anomaly.selftest.mjs — the arithmetic behind a number the product says out
 * loud to an ecologist, checked against hand-computed answers.
 *
 * The probability here is the one figure in SEALv that could be wrong without
 * looking wrong, so every case below is one somebody could argue with: a drop
 * that is only the survey covering less ground, a drop under a doubled wind, a
 * drop with nothing to explain it. Run: node lib/analytics/anomaly.selftest.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = mkdtempSync(path.join(tmpdir(), "anomaly-selftest-"));

execFileSync(
  "npx",
  ["tsc", "lib/analytics/anomaly.ts", "--outDir", outDir, "--rootDir", "lib",
   "--module", "es2020", "--target", "es2020", "--moduleResolution", "node",
   "--lib", "es2020", "--skipLibCheck"],
  { cwd: frontendDir, stdio: "inherit" },
);

const { nbCdf, explainChange, shiftBetween, oneInN, fitAvailability, MIN_VISITS_FOR_FIT } =
  await import(pathToFileURL(path.join(outDir, "analytics", "anomaly.js")).href);

let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}${extra ? " — " + extra : ""}`); failed++; }
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

/* ------------------------------------------------------------ the tail */
ok("a count at its own mean is unsurprising", nbCdf(700, 700) > 0.4 && nbCdf(700, 700) < 0.6,
   String(nbCdf(700, 700)));
ok("the tail is monotone in the observation",
   nbCdf(100, 700) < nbCdf(300, 700) && nbCdf(300, 700) < nbCdf(600, 700));
ok("a probability is a probability", (() => {
  for (const [k, m] of [[0, 5], [3, 3], [50, 700], [700, 700], [2000, 700]]) {
    const p = nbCdf(k, m);
    if (!(p >= 0 && p <= 1)) return false;
  }
  return true;
})());
ok("overdispersion makes the alarm HARDER, not easier",
   nbCdf(300, 700, 3) > nbCdf(300, 700, 1),
   `nb=${nbCdf(300, 700, 3)} poisson=${nbCdf(300, 700, 1)}`);
ok("zero observed against a real colony is as surprising as it gets",
   nbCdf(0, 700) < 1e-6, String(nbCdf(0, 700)));

/* ------------------------------------------- what the drop is compared to */
{
  /* Same ground, same review, 700 -> 300. Nothing explains it: this is the
     case the whole feature exists to raise. */
  const e = explainChange(
    { count: 700, areaM2: 100000, env: { wind_ms: 3 } },
    { count: 300, areaM2: 100000, env: { wind_ms: 3.2 } },
  );
  ok("an unexplained halving alarms", e.alarm === true && e.p !== null && e.p < 0.05,
     JSON.stringify({ p: e.p, alarm: e.alarm }));
  ok("the expectation is last time's count when the area matches", near(e.expected, 700));
}
{
  /* Half the ground photographed. Roughly half the animals is EXPECTED and must
     not alarm — this is the confounder that would otherwise cry wolf on every
     short flight. */
  const e = explainChange(
    { count: 700, areaM2: 100000 },
    { count: 340, areaM2: 50000 },
  );
  ok("covering half the ground is not an anomaly", e.alarm === false,
     JSON.stringify({ expected: e.expected, p: e.p }));
  ok("the area factor is reported, not hidden", near(e.areaFactor, 0.5));
}
{
  /* Same drop, but the wind doubled. Honest answer with three days of data:
     not distinguishable from animals going into the water. */
  const e = explainChange(
    { count: 700, areaM2: 100000, env: { wind_ms: 4, wave_m: 0.2 } },
    { count: 300, areaM2: 100000, env: { wind_ms: 11, wave_m: 0.9 } },
  );
  ok("a drop under a doubled wind does not alarm", e.alarm === false);
  ok("but the weather shift is reported", e.weatherShift.length >= 1 &&
     e.weatherShift[0].ratio >= 1.5, JSON.stringify(e.weatherShift));
  ok("and the probability is still computed", e.p !== null && e.p < 0.05);
}
{
  const e = explainChange({ count: 700 }, { count: 900 });
  ok("a rise is not tested at all", e.skipped === "increase" && e.p === null);
}
{
  const e = explainChange({ count: null }, { count: 300 });
  ok("no previous count, no verdict", e.skipped === "no-count" && e.p === null);
}
{
  const e = explainChange({ count: 0 }, { count: 0 });
  ok("nothing to fall from is not a fall", e.skipped === "no-previous" && e.p === null);
}
{
  /* Rejections are review work, not animals leaving. 700 counted with 200
     ruled out is 500 animals, and comparing 500 with 480 is no alarm. */
  const e = explainChange(
    { count: 700, rejected: 200, areaM2: 1000 },
    { count: 480, rejected: 0, areaM2: 1000 },
  );
  ok("rejections are removed before the comparison", near(e.expected, 500) && e.alarm === false,
     JSON.stringify({ expected: e.expected, p: e.p }));
  ok("and the adjustment is flagged", e.reviewAdjusted === true);
}

/* ------------------------------------------------------- the weather floor */
{
  const s = shiftBetween({ wind_ms: 0.2 }, { wind_ms: 0.6 });
  ok("a tripling of a dead calm is not a weather change", s.length === 0, JSON.stringify(s));
}
{
  const s = shiftBetween({ wind_ms: 4 }, { wind_ms: 9 });
  ok("a real doubling of wind is", s.length === 1 && s[0].ratio > 2, JSON.stringify(s));
}

/* ------------------------------------------------------------ the phrasing */
ok("1-in-N is the reciprocal, rounded", oneInN(0.0033) === 303);
ok("an impossible probability has no odds", oneInN(0) === null);

/* --------------------------------------------------- the model NOT fitted */
ok("no fit on a handful of visits", fitAvailability(
  Array.from({ length: 5 }, (_, i) => ({ count: 100 + i, env: { wind_ms: i } })),
) === null);
{
  /* Enough visits with real spread: a fit appears, and its n is reported so the
     screen can say what it rests on. */
  const many = Array.from({ length: MIN_VISITS_FOR_FIT + 5 }, (_, i) => ({
    count: Math.round(800 * Math.exp(-0.1 * (i % 12))),
    env: { wind_ms: i % 12 },
  }));
  const fit = fitAvailability(many);
  ok("a season's worth of visits does fit", fit !== null && fit.n >= MIN_VISITS_FOR_FIT,
     JSON.stringify(fit));
  ok("and it recovers the sign: more wind, fewer animals hauled out",
     fit !== null && fit.slope < 0, JSON.stringify(fit));
}

console.log(failed ? `\n${failed} assertion(s) failed` : "\nanomaly.ts: the probability is arithmetic on the counts, not a guess");
process.exit(failed ? 1 : 0);
