/**
 * estimate.ts — how many seals are out there right now, and how many were seen.
 *
 * Two different questions were being answered with one number. The map chip,
 * the footage panel, the analytics headline and the report each summed
 * countOf() over every sortie in the season and printed the result as "seals".
 * That sum is a count of OBSERVATIONS: fly the same haul-out in April and in
 * May and it contributes twice, re-upload a file and it contributes twice
 * again. On the current fixture it reads 1475 where the honest standing
 * estimate is 1175 — a 25% overstatement of the Caspian seal population,
 * printed as a headline, in a product whose entire claim is that its numbers
 * are measured.
 *
 * So the two questions get two numbers, and the honest one leads:
 *
 *   current  — the standing estimate. Sorties are grouped into sites by
 *              proximity of their centres (groupIntoSites, 2 km single
 *              linkage — the same clustering the repeat-survey panel uses),
 *              and each site contributes the count of its LATEST sortie. One
 *              place, one number, however many times it was flown.
 *   observed — the raw sum over every sortie. Not deleted, demoted: it is a
 *              true statement about the season's effort ("N animals observed
 *              across M sorties") and it is what a repeat-survey delta is
 *              computed from. It is just not a population.
 *
 * current can legitimately exceed observed on no input, and is always ≤ it in
 * practice; nothing here scales, extrapolates or models. Every term is a
 * count some sortie actually produced.
 *
 * Structural input types (not lib/types.ts Footage) so this module stays pure
 * and DOM-free — lib/export/pdf.ts imports it outside React. A Footage
 * satisfies them.
 */
import { countOf } from "./count";
import {
  SITE_RADIUS_M,
  groupIntoSites,
  isPlaced,
  siteSeries,
  type SurveyFootage,
} from "./surveys";

export type EstimateFootage = SurveyFootage & {
  /** Animals counted but not georeferenced — countOf() folds them in. */
  unplaced?: number | null;
};

export type SeasonEstimate = {
  /** Standing estimate: the latest count at each site, summed. */
  current: number;
  /** Every sortie's count, summed — observations, not animals. */
  observed: number;
  /** Sorties behind `observed`. */
  sorties: number;
  /** Distinct sites behind `current`. */
  sites: number;
};

export type StandingContribution<T extends EstimateFootage = EstimateFootage> = {
  footage: T;
  count: number;
  /** Null for a count with no honest coordinate. */
  center: { lat: number; lng: number } | null;
};

/**
 * The exact terms behind the standing estimate. Exposing them lets the map,
 * regional split and checkpoint ledger consume the same chosen sortie per
 * site instead of reverse-engineering the headline from site centroids.
 */
export function standingContributions<T extends EstimateFootage>(
  footages: T[] | null | undefined,
  radiusM = SITE_RADIUS_M,
): StandingContribution<T>[] {
  const list = (Array.isArray(footages) ? footages : []).filter(Boolean);
  const placeable: T[] = [];
  const out: StandingContribution<T>[] = [];

  for (const footage of list) {
    if (isPlaced(footage)) placeable.push(footage);
    else out.push({ footage, count: countOf(footage), center: null });
  }

  for (const site of groupIntoSites(placeable, radiusM)) {
    const series = siteSeries(site);
    for (let index = series.length - 1; index >= 0; index--) {
      const entry = series[index];
      if (entry.best == null || !Number.isFinite(entry.best)) continue;
      out.push({
        footage: entry.footage,
        count: entry.best,
        center: { lat: entry.footage.center.lat, lng: entry.footage.center.lng },
      });
      break;
    }
  }

  return out;
}

/**
 * The season's current estimate and the raw observation total it was demoted
 * from. One helper, so the chip, the panel, the dashboard and the report
 * cannot drift apart again.
 */
export function seasonEstimate<T extends EstimateFootage>(
  footages: T[] | null | undefined,
  radiusM = SITE_RADIUS_M,
): SeasonEstimate {
  const list = (Array.isArray(footages) ? footages : []).filter(Boolean);

  let observed = 0;
  for (const f of list) observed += countOf(f);

  /* groupIntoSites drops a sortie whose centre is not finite — it cannot be
     placed, so it cannot be matched against a place. It still counted animals,
     and a count that cannot be placed is not a count that did not happen: each
     one stands as its own single-sortie site. The alternative is silently
     losing measured animals from the headline, which is the same dishonesty
     in the other direction. */
  const standing = standingContributions(list, radiusM);
  const current = standing.reduce((sum, contribution) => sum + contribution.count, 0);
  return { current, observed, sorties: list.length, sites: standing.length };
}
