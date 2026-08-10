#!/usr/bin/env node
/**
 * Self-test for lib/analytics/* — no test runner, no deps.
 *
 * Compiles the three modules with tsc into a temp dir and asserts the
 * invariants below on synthetic data whose answers are known by hand. Run
 * from frontend/:
 *
 *   node lib/analytics/analytics.selftest.mjs
 *
 * Exit code 0 = every invariant holds.
 *
 * Invariants:
 *   1) area: 4000x3000 px at 2 cm/px = 4800 m²; no GSD -> null;
 *      totals split known/unknown; 32000 m² formats as 3.2 ha;
 *   2) groups: two clusters 100 m apart -> [3, 2]; one big radius -> [5];
 *      coincident animals are two animals; histogram bins;
 *   3) surveys: 2 near + 1 far sortie -> 2 sites; chaining; series ordered by
 *      date with deltas; band.best wins over detections; zero previous -> pct
 *      null;
 *   4) empty inputs everywhere -> empty, never a fabricated number.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const libDir = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(libDir, "../..");
const outDir = mkdtempSync(path.join(tmpdir(), "analytics-selftest-"));

execFileSync(
  "npx",
  [
    "tsc",
    "lib/analytics/area.ts",
    "lib/analytics/groups.ts",
    "lib/analytics/surveys.ts",
    "lib/analytics/tracking.ts",
    "lib/analytics/avoidance.ts",
    "lib/analytics/caspianRegions.ts",
    "lib/analytics/estimate.ts",
    "lib/analytics/checkpoints.ts",
    "--outDir",
    outDir,
    "--rootDir",
    "lib",
    "--module",
    "commonjs",
    "--target",
    "es2020",
    "--moduleResolution",
    "node",
    "--strict",
    "--skipLibCheck",
    "--types",
    "node",
  ],
  { cwd: frontendDir, stdio: "inherit" },
);

// CommonJS output so the cross-module import ("./groups") resolves in Node
// without the extension rewriting an ESM build would need.
const require = createRequire(import.meta.url);
const { footprintM2, sortieAreaM2, isAssumedGsd, totalAreaM2, formatArea, m2ToHa, m2ToKm2 } =
  require(path.join(outDir, "analytics/area.js"));
const { countOf } = require(path.join(outDir, "analytics/count.js"));
const { groupSizes, histogram, clusterIndices } = require(path.join(outDir, "analytics/groups.js"));
const { groupIntoSites, siteSeries, bestCount } = require(
  path.join(outDir, "analytics/surveys.js"),
);
const { groupsForSurvey, trackSealGroups, applyLinkReviews } = require(
  path.join(outDir, "analytics/tracking.js"),
);
const { detectRegionAvoidance } = require(path.join(outDir, "analytics/avoidance.js"));
const { caspianRegionFor, countByCaspianRegion } = require(path.join(outDir, "analytics/caspianRegions.js"));
const { populationSnapshot, buildPopulationCheckpoints, bucketCheckpointSeries } = require(path.join(outDir, "analytics/checkpoints.js"));

/* ---------- helpers ------------------------------------------------------ */

const M = 111320; // meters per degree of latitude

function metersToLL(lat0, lng0, dxM, dyM) {
  const cos = Math.cos((lat0 * Math.PI) / 180);
  return { lat: lat0 + dyM / M, lng: lng0 + dxM / (M * cos) };
}

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`PASS  ${name}${detail ? `  [${detail}]` : ""}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `  [${detail}]` : ""}`);
  }
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- case 1: surveyed area ---------------------------------------- */
{
  // 4000 px * 3000 px, 2 cm/px -> 80 m * 60 m = 4800 m², by hand.
  const a = footprintM2({ widthPx: 4000, heightPx: 3000, gsdCmPx: 2 });
  check("case1: 4000x3000 px @ 2 cm/px = 4800 m²", Math.abs(a - 4800) < 1e-9, `got ${a}`);

  check(
    "case1: no GSD -> null (never a guess)",
    footprintM2({ widthPx: 4000, heightPx: 3000, gsdCmPx: null }) === null &&
      footprintM2({ widthPx: 4000, heightPx: 3000 }) === null &&
      footprintM2({ widthPx: 4000, heightPx: 3000, gsdCmPx: 0 }) === null,
  );
  check(
    "case1: bad pixel dims -> null",
    footprintM2({ widthPx: 0, heightPx: 3000, gsdCmPx: 2 }) === null &&
      footprintM2({ widthPx: NaN, heightPx: 3000, gsdCmPx: 2 }) === null,
  );

  // A video is many frames: one frame's footprint under a "surveyed area"
  // label is the error sortieAreaM2 exists to stop.
  check(
    "case1: 8 frames cover 8 footprints",
    sortieAreaM2({ widthPx: 4000, heightPx: 3000, gsdCmPx: 2, frames: 8 }) === 4800 * 8,
  );
  check(
    "case1: an unknown frame count -> null, never one frame's worth",
    sortieAreaM2({ widthPx: 4000, heightPx: 3000, gsdCmPx: 2, frames: null }) === null &&
      sortieAreaM2({ widthPx: 4000, heightPx: 3000, gsdCmPx: 2 }) === null &&
      sortieAreaM2({ widthPx: 4000, heightPx: 3000, gsdCmPx: 2, frames: 0 }) === null,
  );
  check(
    "case1: no GSD beats any frame count",
    sortieAreaM2({ widthPx: 4000, heightPx: 3000, gsdCmPx: null, frames: 8 }) === null,
  );

  check(
    "case1: only assumed_* scales are guesses",
    isAssumedGsd("assumed_native_width") &&
      isAssumedGsd("assumed_optics") &&
      !isAssumedGsd("optics") &&
      !isAssumedGsd("explicit") &&
      !isAssumedGsd("unknown") &&
      !isAssumedGsd(null),
  );

  const total = totalAreaM2([{ areaM2: 4800 }, { areaM2: 1200 }, { areaM2: null }, {}]);
  check(
    "case1: totalAreaM2 sums the known and counts the unknown",
    eq(total, { m2: 6000, known: 2, unknown: 2, assumed: 0 }),
    JSON.stringify(total),
  );
  check(
    "case1: a negative area counts as unknown, not as a subtraction",
    eq(totalAreaM2([{ areaM2: -5 }, { areaM2: 100 }]), { m2: 100, known: 1, unknown: 1, assumed: 0 }),
  );
  check(
    "case1: an assumed scale is counted apart from a measured one",
    eq(
      totalAreaM2([
        { areaM2: 100, gsdSource: "optics" },
        { areaM2: 200, gsdSource: "assumed_native_width" },
        { areaM2: null, gsdSource: "assumed_optics" },
      ]),
      { m2: 300, known: 2, unknown: 1, assumed: 1 },
    ),
    JSON.stringify(totalAreaM2([
      { areaM2: 100, gsdSource: "optics" },
      { areaM2: 200, gsdSource: "assumed_native_width" },
      { areaM2: null, gsdSource: "assumed_optics" },
    ])),
  );

  check("case1: m2ToHa / m2ToKm2", m2ToHa(32000) === 3.2 && m2ToKm2(2500000) === 2.5);
  check("case1: formatArea(32000, en) = 3.2", formatArea(32000, "en") === "3.2");
  check(
    "case1: formatArea localizes the decimal separator",
    /^3[.,]2$/.test(formatArea(32000, "ru")) && /^3[.,]2$/.test(formatArea(32000, "kk")),
    `ru=${formatArea(32000, "ru")} kk=${formatArea(32000, "kk")}`,
  );
  check(
    "case1: a tiny real area does not render as 0.0",
    formatArea(300, "en") === "0.03",
    `got ${formatArea(300, "en")}`,
  );
  check("case1: NaN area -> em dash, not a number", formatArea(NaN, "en") === "—");
}

/* ---------- case 2: spatial group sizes ---------------------------------- */
{
  const lat0 = 44.6;
  const lng0 = 50.3;
  // Group A: 3 animals within 3 m. Group B: 2 animals within 2 m, 100 m east.
  const pts = [
    metersToLL(lat0, lng0, 0, 0),
    metersToLL(lat0, lng0, 3, 0),
    metersToLL(lat0, lng0, 0, 3),
    metersToLL(lat0, lng0, 100, 0),
    metersToLL(lat0, lng0, 102, 0),
  ];

  check(
    "case2: two clusters 100 m apart at r=5 -> [3, 2]",
    eq(groupSizes(pts, 5), [3, 2]),
    JSON.stringify(groupSizes(pts, 5)),
  );
  check(
    "case2: r=200 merges everything -> [5]",
    eq(groupSizes(pts, 200), [5]),
    JSON.stringify(groupSizes(pts, 200)),
  );
  check(
    "case2: r=1 leaves five singles",
    eq(groupSizes(pts, 1), [1, 1, 1, 1, 1]),
    JSON.stringify(groupSizes(pts, 1)),
  );

  // Single linkage chains: 4 m spacing is one group at r=5, five at r=3.
  const chain = [0, 4, 8, 12, 16].map((dx) => metersToLL(lat0, lng0, dx, 0));
  check("case2: a 4 m-spaced chain is one group at r=5", eq(groupSizes(chain, 5), [5]));
  check("case2: the same chain is five singles at r=3", eq(groupSizes(chain, 3), [1, 1, 1, 1, 1]));

  // Two animals at identical coordinates are two animals, not one.
  const same = [metersToLL(lat0, lng0, 0, 0), metersToLL(lat0, lng0, 0, 0)];
  check("case2: coincident detections are a group of 2", eq(groupSizes(same, 5), [2]));

  // Non-finite points are dropped, not clustered.
  const dirty = [...same, { lat: NaN, lng: 50 }, { lat: 44, lng: undefined }];
  check("case2: non-finite points are dropped", eq(groupSizes(dirty, 5), [2]));

  const idx = clusterIndices(pts, 5);
  check(
    "case2: clusterIndices returns input indices, deterministically ordered",
    eq(idx, [
      [0, 1, 2],
      [3, 4],
    ]),
    JSON.stringify(idx),
  );

  const h = histogram([1, 1, 3, 7, 25]);
  check(
    "case2: histogram bins 1 / 2–5 / 6–20 / 21+",
    eq(
      h.map((b) => [b.label, b.count, b.animals]),
      [
        ["1", 2, 2],
        ["2–5", 1, 3],
        ["6–20", 1, 7],
        ["21+", 1, 25],
      ],
    ),
    JSON.stringify(h),
  );
  check(
    "case2: histogram edges land in the right bins",
    eq(
      histogram([2, 5, 6, 20, 21]).map((b) => b.count),
      [0, 2, 2, 1],
    ),
  );
  check(
    "case2: histogram([]) is four empty bins, not an empty list",
    histogram([]).length === 4 && histogram([]).every((b) => b.count === 0 && b.animals === 0),
  );
}

/* ---------- case 2b: tracked group observations --------------------------- */
{
  const lat0 = 44.6;
  const lng0 = 50.3;
  const det = (id, ll, count = 1, status = "auto") => ({ id, ...ll, count, status });

  const clustered = groupsForSurvey({
    id: "s0",
    uploadedAt: "2026-01-01T00:00:00Z",
    detections: [
      det("a", metersToLL(lat0, lng0, 0, 0)),
      det("b", metersToLL(lat0, lng0, 3, 0)),
      det("single", metersToLL(lat0, lng0, 100, 0)),
      det("rejected", metersToLL(lat0, lng0, 2, 0), 1, "false_positive"),
    ],
  });
  check(
    "case2b: grouping happens inside one survey and excludes a singleton",
    clustered.groups.length === 1 && clustered.groups[0].size === 2 && clustered.untrackedAnimals === 1,
    JSON.stringify(clustered),
  );

  const stableBase = groupsForSurvey({
    id: "stable",
    uploadedAt: "2026-01-01T00:00:00Z",
    detections: [
      det("a", metersToLL(lat0, lng0, 100, 0)),
      det("b", metersToLL(lat0, lng0, 103, 0)),
    ],
  });
  const stableExpanded = groupsForSurvey({
    id: "stable",
    uploadedAt: "2026-01-01T00:00:00Z",
    detections: [
      det("d", metersToLL(lat0, lng0, -97, 0)),
      det("b", metersToLL(lat0, lng0, 103, 0)),
      det("c", metersToLL(lat0, lng0, -100, 0)),
      det("a", metersToLL(lat0, lng0, 100, 0)),
    ],
  });
  check(
    "case2b: observation id survives row reordering and insertion of another group",
    stableBase.groups[0].id === stableExpanded.groups.find((g) => g.memberIds.includes("a"))?.id,
    `${stableBase.groups[0].id} / ${stableExpanded.groups.map((g) => g.id).join(", ")}`,
  );

  const surveys = [
    {
      id: "day1",
      uploadedAt: "2026-01-01T00:00:00Z",
      detections: [
        det("a1", metersToLL(lat0, lng0, 0, 0), 10),
        det("b1", metersToLL(lat0, lng0, 100000, 0), 20),
      ],
    },
    {
      id: "day2",
      uploadedAt: "2026-01-02T00:00:00Z",
      detections: [
        // Listed in reverse geographic order on purpose: matching must use
        // distance and size, never row position.
        det("b2", metersToLL(lat0, lng0, 105000, 0), 18),
        det("a2", metersToLL(lat0, lng0, 10000, 0), 11),
      ],
    },
    {
      id: "day3",
      uploadedAt: "2026-01-03T00:00:00Z",
      // Close to A but much too large: it must start a new track rather than
      // being forced onto the nearest predecessor.
      detections: [det("new", metersToLL(lat0, lng0, 12000, 0), 40)],
    },
  ];
  const tracked = trackSealGroups(surveys, {
    sizeTolerancePct: 40,
    maxSpeedKmPerDay: 50,
    baseDistanceKm: 2,
  });
  const continued = tracked.tracks.filter((t) => t.observations.length === 2);
  check("case2b: nearest similarly sized groups form two one-to-one tracks", continued.length === 2);
  check(
    "case2b: an implausible size jump starts a separate track",
    tracked.tracks.length === 3 && tracked.tracks.some((t) => t.observations[0].memberIds[0] === "new" && t.observations.length === 1),
  );
  check(
    "case2b: movement distance and confidence are recorded",
    continued.every((t) => t.totalDistanceKm > 0 && t.confidence !== null && t.observations[1].match?.distanceKm > 0),
  );

  const stale = trackSealGroups([surveys[0], { ...surveys[1], uploadedAt: "2026-04-02T00:00:00Z" }], {
    maxGapDays: 30,
  });
  check(
    "case2b: a track is not revived after the maximum gap",
    stale.tracks.length === 4 && stale.tracks.every((t) => t.observations.length === 1),
  );

  const split = trackSealGroups([
    {
      id: "split-before",
      uploadedAt: "2026-02-01T00:00:00Z",
      detections: [det("whole", metersToLL(lat0, lng0, 0, 0), 100)],
    },
    {
      id: "split-after",
      uploadedAt: "2026-02-02T00:00:00Z",
      detections: [
        det("left", metersToLL(lat0, lng0, -5000, 0), 45),
        det("right", metersToLL(lat0, lng0, 5000, 0), 55),
      ],
    },
  ]);
  check(
    "case2b: one conserved group becoming two is represented as a split",
    split.events.length === 1 &&
      split.events[0].type === "split" &&
      split.events[0].sourceTrackIds.length === 1 &&
      split.events[0].targetTrackIds.length === 2 &&
      split.events[0].sizeConservationPct === 0,
    JSON.stringify(split.events),
  );

  const merge = trackSealGroups([
    {
      id: "merge-before",
      uploadedAt: "2026-03-01T00:00:00Z",
      detections: [
        det("left", metersToLL(lat0, lng0, -5000, 0), 45),
        det("right", metersToLL(lat0, lng0, 5000, 0), 55),
      ],
    },
    {
      id: "merge-after",
      uploadedAt: "2026-03-02T00:00:00Z",
      detections: [det("whole", metersToLL(lat0, lng0, 0, 0), 100)],
    },
  ]);
  check(
    "case2b: two conserved groups becoming one is represented as a merge",
    merge.events.length === 1 &&
      merge.events[0].type === "merge" &&
      merge.events[0].sourceTrackIds.length === 2 &&
      merge.events[0].targetTrackIds.length === 1 &&
      merge.events[0].sizeConservationPct === 0,
    JSON.stringify(merge.events),
  );

  const straightSurveys = [0, 1, 2, 3].map((day) => ({
    id: `straight-${day}`,
    uploadedAt: `2026-04-0${day + 1}T00:00:00Z`,
    detections: [det(`straight-d${day}`, metersToLL(lat0, lng0, day * 10000, 0), 20)],
  }));
  const straight = trackSealGroups(straightSurveys);
  const predicted = straight.tracks[0].prediction;
  check(
    "case2b: recent straight movement produces a deterministic seven-day eastward prediction",
    straight.tracks.length === 1 &&
      predicted?.horizonDays === 7 &&
      predicted.basisObservations === 4 &&
      Math.abs(predicted.bearingDeg - 90) < 0.2 &&
      Math.abs(predicted.distanceKm - 70) < 0.2,
    JSON.stringify(predicted),
  );

  const fast = trackSealGroups([0, 10, 71, 132].map((xKm, day) => ({
    id: `fast-${day}`,
    uploadedAt: `2026-05-0${day + 1}T00:00:00Z`,
    detections: [det(`fast-d${day}`, metersToLL(lat0, lng0, xKm * 1000, 0), 20)],
  })));
  check(
    "case2b: two consecutive unusually fast moves raise a speed anomaly",
    fast.tracks[0].anomalies?.some((a) => a.kind === "speed" && a.observationId.includes("fast-3:group:")),
    JSON.stringify(fast.tracks[0].anomalies),
  );

  const reversed = trackSealGroups([
    { id: "turn-0", uploadedAt: "2026-06-01T00:00:00Z", detections: [det("t0", metersToLL(lat0, lng0, 0, 0), 20)] },
    { id: "turn-1", uploadedAt: "2026-06-02T00:00:00Z", detections: [det("t1", metersToLL(lat0, lng0, 10000, 0), 20)] },
    { id: "turn-2", uploadedAt: "2026-06-03T00:00:00Z", detections: [det("t2", metersToLL(lat0, lng0, 0, 0), 20)] },
  ]);
  check(
    "case2b: a direction reversal is marked as a sharp turn",
    reversed.tracks[0].anomalies?.some((a) => a.kind === "sharp_turn" && a.value > 179),
    JSON.stringify(reversed.tracks[0].anomalies),
  );

  const curved = trackSealGroups([
    { id: "curve-0", uploadedAt: "2026-06-01T00:00:00Z", detections: [det("c0", metersToLL(lat0, lng0, 0, 0), 20)] },
    { id: "curve-1", uploadedAt: "2026-06-02T00:00:00Z", detections: [det("c1", metersToLL(lat0, lng0, 10000, 0), 20)] },
    { id: "curve-2", uploadedAt: "2026-06-03T00:00:00Z", detections: [det("c2", metersToLL(lat0, lng0, 2340, 6430), 20)] },
  ]);
  check(
    "case2b: a 140-degree curve is not mislabeled as a reversal",
    !curved.tracks[0].anomalies?.some((a) => a.kind === "sharp_turn"),
    JSON.stringify(curved.tracks[0].anomalies),
  );

  const delayed = trackSealGroups([
    { id: "delay-0", uploadedAt: "2026-07-01T00:00:00Z", detections: [det("d0", metersToLL(lat0, lng0, 0, 0), 20)] },
    { id: "delay-1", uploadedAt: "2026-07-02T00:00:00Z", detections: [det("d1", metersToLL(lat0, lng0, 10000, 0), 20)] },
    { id: "delay-2", uploadedAt: "2026-07-14T00:00:00Z", detections: [det("d2", metersToLL(lat0, lng0, 20000, 0), 20)] },
  ]);
  check(
    "case2b: an unusually long but still matchable observation interval is flagged",
    delayed.tracks[0].anomalies?.some((a) => a.kind === "unusual_interval" && a.value === 12),
    JSON.stringify(delayed.tracks[0].anomalies),
  );

  const routeOutlier = trackSealGroups([
    { id: "route-0", uploadedAt: "2026-08-01T00:00:00Z", detections: [det("r0", metersToLL(lat0, lng0, 0, 0), 20)] },
    { id: "route-1", uploadedAt: "2026-08-02T00:00:00Z", detections: [det("r1", metersToLL(lat0, lng0, 10000, 0), 20)] },
    { id: "route-2", uploadedAt: "2026-08-16T00:00:00Z", detections: [det("r2", metersToLL(lat0, lng0, -180000, 0), 20)] },
  ]);
  check(
    "case2b: a hard geolocation/route deviation is flagged immediately",
    routeOutlier.tracks[0].anomalies?.some((a) => a.kind === "route_deviation" && a.value > 300),
    JSON.stringify(routeOutlier.tracks[0].anomalies),
  );

  const observations = straight.tracks[0].observations;
  observations[1].match.confidence = "low";
  observations[1].match.ambiguous = true;
  const confirmed = applyLinkReviews(straight, [{
    from_observation_id: observations[0].id,
    to_observation_id: observations[1].id,
    decision: "confirmed",
  }]);
  check(
    "case2b: a confirmed manual link becomes high-confidence and unambiguous",
    confirmed.tracks[0].observations[1].match?.confidence === "high" &&
      confirmed.tracks[0].observations[1].match?.ambiguous === false,
  );

  const rejectedReview = {
    from_observation_id: observations[1].id,
    to_observation_id: observations[2].id,
    decision: "rejected",
  };
  const rejected = applyLinkReviews(straight, [
    { ...rejectedReview, decision: "confirmed" },
    rejectedReview,
  ]);
  const rejectedReversed = applyLinkReviews(straight, [
    rejectedReview,
    { ...rejectedReview, decision: "confirmed" },
  ]);
  check(
    "case2b: a rejected link deterministically cuts the track before `to`",
    eq(rejected.tracks.map((t) => t.observations.map((o) => o.id)), rejectedReversed.tracks.map((t) => t.observations.map((o) => o.id))) &&
      eq(rejected.tracks.map((t) => t.observations.length), [2, 2]) &&
      rejected.tracks[1].observations[0].match === undefined,
    JSON.stringify(rejected.tracks.map((t) => t.observations.map((o) => o.id))),
  );
}

/* ---------- case 3: repeat surveys --------------------------------------- */
{
  const lat0 = 44.5;
  const lng0 = 50.5;
  const near1 = metersToLL(lat0, lng0, 0, 0);
  const near2 = metersToLL(lat0, lng0, 500, 0); // 500 m -> same site
  const far = metersToLL(lat0, lng0, 50000, 0); // 50 km -> its own site

  const band = (best) => ({ low: best - 5, best, high: best + 5, basis: "union_4_frames" });
  const F = [
    { id: "b", uploadedAt: "2026-03-10T00:00:00Z", center: near2, band: band(150), detections: [] },
    { id: "a", uploadedAt: "2026-02-01T00:00:00Z", center: near1, band: band(100), detections: [] },
    { id: "c", uploadedAt: "2026-02-15T00:00:00Z", center: far, band: band(40), detections: [] },
  ];

  const sites = groupIntoSites(F);
  check("case3: 2 near + 1 far -> 2 sites", sites.length === 2, `got ${sites.length}`);
  const bySize = [...sites].sort((x, y) => y.footages.length - x.footages.length);
  check("case3: the near pair is one site", bySize[0].footages.length === 2);
  check("case3: the far sortie is alone", bySize[1].footages.length === 1);
  check(
    "case3: centroid is the mean of the members' centres",
    Math.abs(bySize[0].centroid.lat - (near1.lat + near2.lat) / 2) < 1e-12 &&
      Math.abs(bySize[0].centroid.lng - (near1.lng + near2.lng) / 2) < 1e-12,
  );
  check("case3: site ids are their index", eq(sites.map((s) => s.id).sort(), [0, 1]));

  // Single linkage: A-B 1500 m, B-C 1500 m, A-C 3000 m -> still one site.
  const chained = [0, 1500, 3000].map((dx, i) => ({
    id: `ch${i}`,
    uploadedAt: `2026-01-0${i + 1}T00:00:00Z`,
    center: metersToLL(lat0, lng0, dx, 0),
    detections: [],
  }));
  check("case3: 2 km chaining keeps one haul-out together", groupIntoSites(chained).length === 1);

  const series = siteSeries(bySize[0]);
  check(
    "case3: series is ordered oldest first",
    eq(
      series.map((e) => e.footage.id),
      ["a", "b"],
    ),
    JSON.stringify(series.map((e) => e.footage.id)),
  );
  check("case3: first entry has no delta", series[0].delta === null);
  check(
    "case3: delta 100 -> 150 is +50 / +50%",
    series[1].delta.abs === 50 && Math.abs(series[1].delta.pct - 50) < 1e-9,
    JSON.stringify(series[1].delta),
  );
  check("case3: the band travels with the entry", series[1].band.basis === "union_4_frames");

  // No band -> the count is the placed, non-false-positive detections.
  const d = (status) => ({ count: 1, status });
  const noBand = {
    id: "n",
    uploadedAt: "2026-04-01T00:00:00Z",
    center: near1,
    detections: [d("auto"), d("validated"), d("false_positive")],
  };
  check("case3: bestCount falls back to real detections, minus false positives", bestCount(noBand) === 2);
  check("case3: band.best wins over the detection sum", bestCount(F[0]) === 150);
  check(
    "case3: no band and no detections -> null, never 0",
    bestCount({ id: "x", uploadedAt: "2026-04-01T00:00:00Z", center: near1 }) === null,
  );
  // An empty list is not an observation of zero animals, and neither is a list
  // of nothing but rejections. Only a band can claim a measured zero.
  check(
    "case3: an empty detection list is unknown, not zero",
    bestCount({ id: "x", uploadedAt: "2026-04-01T00:00:00Z", center: near1, detections: [] }) === null,
  );
  check(
    "case3: nothing but false positives is unknown, not zero",
    bestCount({
      id: "x", uploadedAt: "2026-04-01T00:00:00Z", center: near1,
      detections: [d("false_positive"), d("false_positive")],
    }) === null,
  );
  check(
    "case3: a band of 0 IS a measured zero",
    bestCount({ id: "x", uploadedAt: "2026-04-01T00:00:00Z", center: near1, band: band(0) }) === 0,
  );

  // A zero previous count has no percent change, and a missing count breaks
  // the chain rather than being bridged over. The zero is stated as a band -
  // the only way a sortie can claim it counted and found none.
  const zeroThen = siteSeries({
    id: 0,
    centroid: near1,
    footages: [
      { id: "z0", uploadedAt: "2026-01-01T00:00:00Z", center: near1, band: band(0) },
      { id: "z1", uploadedAt: "2026-01-02T00:00:00Z", center: near1, band: band(10) },
      { id: "z2", uploadedAt: "2026-01-03T00:00:00Z", center: near1 },
      { id: "z3", uploadedAt: "2026-01-04T00:00:00Z", center: near1, band: band(20) },
    ],
  });
  check(
    "case3: previous count 0 -> abs kept, pct null",
    zeroThen[1].delta.abs === 10 && zeroThen[1].delta.pct === null,
    JSON.stringify(zeroThen[1].delta),
  );
  check("case3: a countless sortie has no delta", zeroThen[2].delta === null && zeroThen[2].best === null);
  check("case3: and the next one is not bridged across the gap", zeroThen[3].delta === null);
}

/* ---------- case 3b: one definition of a sortie's count -------------------- */
{
  const d = (status) => ({ count: 1, status });
  check(
    "case3b: the band's best wins over the detections",
    countOf({ band: { best: 562 }, detections: [d("auto"), d("auto")] }) === 562,
  );
  check(
    "case3b: without a band, a rejected detection is not an animal",
    countOf({ detections: [d("auto"), d("validated"), d("false_positive")] }) === 2,
  );
  check(
    "case3b: animals counted but not placed are still animals",
    countOf({ detections: [d("auto")], unplaced: 4 }) === 5,
  );
  check(
    "case3b: a band of null is not a count of null",
    countOf({ band: { best: null }, detections: [d("auto"), d("auto")] }) === 2,
  );
}

/* ---------- case 3c: persistent regional avoidance ----------------------- */
{
  const sample = (id, date, best, region = "KZ-East") => ({
    id,
    uploadedAt: `${date}T09:00:00Z`,
    capturedAt: `${date}T09:00:00Z`,
    siteRegion: region,
    areaM2: 1_000_000,
    band: { best },
  });
  const baseline = [2020, 2021, 2022, 2023, 2024].flatMap((year) => [
    sample(`b${year}a`, `${year}-08-01`, 100),
    sample(`b${year}b`, `${year}-08-08`, 100),
  ]);
  const result = detectRegionAvoidance([
    ...baseline,
    sample("low-a", "2026-08-01", 10),
    sample("low-b", "2026-08-08", 12),
  ]);
  check(
    "case3c: two persistent lows after five baseline years raise one review signal",
    result.alerts.length === 1 && result.alerts[0].region === "KZ-East",
    JSON.stringify(result.assessments),
  );
  check(
    "case3c: missing surveyed area is excluded, never treated as zero seals",
    detectRegionAvoidance([{ ...sample("x", "2026-08-01", 0), areaM2: null }]).excludedWithoutEffort === 1,
  );
  check(
    "case3c: fewer than five historical years cannot claim avoidance",
    detectRegionAvoidance([
      sample("b1", "2025-08-01", 100),
      sample("l1", "2026-08-01", 10),
      sample("l2", "2026-08-08", 10),
    ]).alerts.length === 0,
  );
}

/* ---------- case 4: empty inputs ----------------------------------------- */
{
  check("case4: totalAreaM2([]) -> zero known, zero unknown", eq(totalAreaM2([]), { m2: 0, known: 0, unknown: 0, assumed: 0 }));
  check("case4: countOf({}) -> 0, and it does not throw", countOf({}) === 0);
  check("case4: groupSizes([]) -> []", eq(groupSizes([]), []));
  check("case4: clusterIndices([], 5) -> []", eq(clusterIndices([], 5), []));
  check("case4: groupIntoSites([]) -> []", eq(groupIntoSites([]), []));
  check(
    "case4: siteSeries on an empty site -> []",
    eq(siteSeries({ id: 0, centroid: { lat: 44, lng: 50 }, footages: [] }), []),
  );
  const one = siteSeries({
    id: 0,
    centroid: { lat: 44, lng: 50 },
    footages: [
      {
        id: "only",
        uploadedAt: "2026-05-01T00:00:00Z",
        center: { lat: 44, lng: 50 },
        band: { low: 8, best: 9, high: 11, basis: "single_image" },
      },
    ],
  });
  check("case4: a one-sortie site has a count and no delta", one.length === 1 && one[0].best === 9 && one[0].delta === null);
}

/* ---------- case 5: conventional Caspian sub-basins --------------------- */
{
  check("case5: point above Mangyshlak threshold is North Caspian", caspianRegionFor({lat:45,lng:49})==="north");
  check("case5: point between the two thresholds is Central Caspian", caspianRegionFor({lat:42,lng:50})==="central");
  check("case5: point below Apsheron threshold is South Caspian", caspianRegionFor({lat:39,lng:51})==="south");
  check("case5: an unplaceable point has no invented region", caspianRegionFor({lat:NaN,lng:51})===null);
  check(
    "case5: regional counts plus unlocated equal the global count",
    eq(countByCaspianRegion([
      {lat:45,lng:49,count:100},
      {lat:42,lng:50,count:60},
      {lat:39,lng:51,count:40},
    ],5),{north:100,central:60,south:40,unlocated:5,global:205}),
  );
}

/* ---------- case 6: immutable upload checkpoints ----------------------- */
{
  const footage = (id, ingestedAt, siteId, lat, lng, count) => ({
    id,
    filename: `${id}.MP4`,
    size: 1,
    duration: 1,
    uploadedAt: ingestedAt,
    ingestedAt,
    capturedAt: ingestedAt,
    track: [],
    center: { lat, lng },
    status: "ready",
    source: "test",
    siteId,
    detections: [{ id: `${id}-d`, footageId: id, t: 0, lat, lng, count, confidence: 1, status: "validated" }],
  });
  const north100 = footage("north-old", "2026-01-01T08:00:00Z", "A", 45.1, 49, 100);
  const south80 = footage("south", "2026-01-02T08:00:00Z", "B", 39.2, 51, 80);
  /* Same explicit site, far away: this is a replacement/movement, not a new
     term to add to the standing total. */
  const central90 = footage("central-new", "2026-01-03T08:00:00Z", "A", 42.2, 50, 90);
  const checkpoints = buildPopulationCheckpoints([central90, north100, south80]);
  const latest = checkpoints[checkpoints.length - 1].snapshot;
  check("case6: upload checkpoints are chronological", checkpoints.map((c) => c.footageId).join(",") === "north-old,south,central-new");
  check("case6: a repeated explicit site replaces its old count", latest.global === 170, JSON.stringify(latest));
  check("case6: regional allocation follows group coordinates, not the old site centroid", latest.north === 0 && latest.central === 90 && latest.south === 80, JSON.stringify(latest));
  check("case6: every regional snapshot sums exactly to global", checkpoints.every((c) => c.snapshot.north + c.snapshot.central + c.snapshot.south + c.snapshot.unlocated === c.snapshot.global));
  check("case6: checkpoint prefixes retain the exact knowledge state", checkpoints[1].footageIds.join(",") === "north-old,south");
  check("case6: daily series uses the last snapshot in each bucket", bucketCheckpointSeries(checkpoints, "day").length === 3);

  const unresolved = {
    ...footage("unresolved", "2026-01-04T08:00:00Z", "C", 45.2, 49, 80),
    band: { low: 100, best: 100, high: 100, basis: "engine" },
  };
  const unresolvedSnapshot = populationSnapshot([unresolved]);
  check("case6: a band remainder stays unlocated instead of being assigned to a centroid", unresolvedSnapshot.north === 80 && unresolvedSnapshot.unlocated === 20 && unresolvedSnapshot.global === 100, JSON.stringify(unresolvedSnapshot));
}

/* ---------- summary ------------------------------------------------------- */

if (failures === 0) {
  console.log("\nALL INVARIANTS HOLD");
} else {
  console.error(`\n${failures} FAILURE(S)`);
  process.exitCode = 1;
}
