/**
 * review.ts — how much of a count a human has actually ruled on, and how much
 * of it this build cannot put in front of a human at all.
 *
 * Two different claims that the product kept collapsing into one:
 *
 *   "0% reviewed"        — there are animals to rule on and nobody has.
 *   "nothing to review"  — there is no per-animal row a reviewer could open.
 *
 * A sortie whose animals were never georeferenced has 562 point rows in the
 * archive and not one of them can be opened in this build, because the
 * Evidence view needs a frame and the sortie is a video. Printing that as
 * "0% (0/1)" — which is what dividing by a detection list containing one
 * aggregate marker produced — states that a reviewer has neglected work that
 * the product never offered them. `pct` is null for that case, on purpose, and
 * `unreviewable` reports the animals out loud instead of quietly folding them
 * into a denominator.
 *
 * The wording that goes with `unreviewable` matters as much as the number.
 * These animals DO have per-animal records: ids, pixel coordinates, scores.
 * What they lack is a latitude and longitude, and a frame to show them on.
 * So the honest sentence is "N animals with no map position — not reviewable
 * in this build", never "no per-animal record", which would be false.
 * (Dictionary key: `wb.noMapPosition`, with `wb.noMapPositionWhy` as the
 * long form.)
 *
 * Structural input types rather than lib/types.ts Footage, so the module stays
 * pure and importable from the PDF builder and the selftests; a Footage and a
 * Detection satisfy them.
 */

export type ReviewDetectionLike = {
  id: string;
  status: "auto" | "validated" | "false_positive";
  /** Animals this row stands for. 1 for a real point, the run's whole best
   *  estimate for an aggregate marker. */
  count?: number;
};

export type ReviewFootageLike = {
  detections?: ReviewDetectionLike[] | null;
  /** Animals the engine counted but could not place on the map. */
  unplaced?: number | null;
};

export type ReviewStats = {
  /** Detections a human has confirmed as animals. */
  verified: number;
  /** Detections a human has ruled out. A rejection is a verdict and it is
   *  WORK DONE — it used to sit in neither term, so rejecting a hundred
   *  animals of a three-hundred-animal sortie left the progress figure at 0%
   *  and shrank the denominator instead, and rejecting all of them made the
   *  panels print "nothing to review" over a sortie somebody had just finished
   *  reviewing. The X key is half of triage; it has to move the number. */
  rejected: number;
  /** verified + rejected — every row a human has ruled on either way. The
   *  numerator of `pct`, because the question the progress figure answers is
   *  "how much of this is still waiting for me", not "how much of this turned
   *  out to be a seal". */
  ruled: number;
  /** Detections a human COULD rule on here: the ruled ones plus the untouched
   *  ones that carry a real backend point id. The denominator of `pct`, and
   *  never a number that includes work this build cannot offer. */
  reviewable: number;
  /** Animals with no reviewable row in this build. Reported next to the
   *  percentage, never inside it. */
  unreviewable: number;
  /** reviewable + unreviewable — every animal a complete review would have to
   *  rule on, including the ones only a later build can reach. */
  total: number;
  /** Percent of `reviewable` that has been RULED ON, 0–100. NULL when there is
   *  nothing to review: "no work done" and "no work to do" are different
   *  claims and only one of them accuses the reviewer. */
  pct: number | null;
};

/** The one dot that stands in for a whole run when the engine placed no
 *  individual animals. It has no point row behind it, so no verdict can be
 *  written for it and no reviewer may be credited with having ruled on it. */
export function isAggregateMarker(d: { id?: string | null } | null | undefined): boolean {
  return /-agg$/.test(String(d?.id ?? ""));
}

/** Backend point id out of a detection id (`run-<run>-p<point>`). Null for the
 *  aggregate marker and for test data, neither of which the service knows —
 *  and a row the service does not know is a row no verdict can reach. */
export function pointIdOf(id: string): number | null {
  const m = /-p(\d+)$/.exec(String(id ?? ""));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

const nonNegative = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** One sortie's review state. */
export function reviewStats(f: ReviewFootageLike | null | undefined): ReviewStats {
  let verified = 0;
  let rejected = 0;
  let openReviewable = 0;
  let aggregate = 0;

  for (const d of f?.detections ?? []) {
    if (!d) continue;
    if (isAggregateMarker(d)) {
      // Stands for animals, not for a row. It is never ruled on and never
      // reviewable; its count is the run's whole estimate.
      aggregate += nonNegative(d.count);
      continue;
    }
    if (d.status === "validated") {
      verified += 1;
      continue;
    }
    // A rejection is a verdict a person wrote, so it is ruled-on work — it
    // belongs in the numerator AND the denominator. Dropping it from both (the
    // old rule) made a finished triage pass indistinguishable from an
    // untouched one.
    if (d.status === "false_positive") {
      rejected += 1;
      continue;
    }
    if (d.status === "auto" && pointIdOf(d.id) !== null) openReviewable += 1;
  }

  const ruled = verified + rejected;
  const reviewable = ruled + openReviewable;
  const unplaced = nonNegative(f?.unplaced);
  /* MAX, not sum. The aggregate marker only exists when the run placed nothing
     at all, so its count already covers every unplaced animal of that run —
     adding them would report the fixture's 562 unreachable animals as 1124.
     Without a marker the term is zero and this is exactly `unplaced`. */
  const unreviewable = Math.max(aggregate, unplaced);

  return {
    verified,
    rejected,
    ruled,
    reviewable,
    unreviewable,
    total: reviewable + unreviewable,
    pct: reviewable === 0 ? null : (ruled / reviewable) * 100,
  };
}

/** The same figures over a season. Summed from the per-sortie terms rather
 *  than averaged over sorties: a season's reviewed share is animals over
 *  animals, and averaging percentages would let a three-animal sortie outweigh
 *  a five-hundred-animal one. */
export function seasonReviewStats(fs: ReviewFootageLike[] | null | undefined): ReviewStats {
  let verified = 0;
  let rejected = 0;
  let reviewable = 0;
  let unreviewable = 0;
  for (const f of fs ?? []) {
    const s = reviewStats(f);
    verified += s.verified;
    rejected += s.rejected;
    reviewable += s.reviewable;
    unreviewable += s.unreviewable;
  }
  const ruled = verified + rejected;
  return {
    verified,
    rejected,
    ruled,
    reviewable,
    unreviewable,
    total: reviewable + unreviewable,
    pct: reviewable === 0 ? null : (ruled / reviewable) * 100,
  };
}
