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

const finite = (n: unknown): boolean => Number.isFinite(Number(n));

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
  const placeable: T[] = [];
  let strayCount = 0;
  let strays = 0;
  for (const f of list) {
    if (finite(f?.center?.lat) && finite(f?.center?.lng)) placeable.push(f);
    else {
      strays += 1;
      strayCount += countOf(f);
    }
  }

  const sites = groupIntoSites(placeable, radiusM);
  let current = strayCount;
  for (const site of sites) {
    const series = siteSeries(site);
    /* The latest sortie that actually produced a count. Normally that is the
       last entry outright; when the most recent visit came back without one
       (bestCount → null, an unknown and not a zero), the site's last known
       count is still the honest answer for it — dropping to 0 would report a
       haul-out as emptied by a flight that measured nothing. */
    for (let i = series.length - 1; i >= 0; i--) {
      const best = series[i].best;
      if (best != null && Number.isFinite(best)) {
        current += best;
        break;
      }
    }
  }

  return { current, observed, sorties: list.length, sites: sites.length + strays };
}
