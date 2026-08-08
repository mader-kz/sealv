/**
 * surveys.ts — repeat surveys of the same place, compared.
 *
 * The honest version of "trend": no regression, no forecast, no invented
 * expectation. Sorties that photographed the same haul-out are grouped into a
 * site, ordered in time, and each one is stated next to the one before it —
 * two measured counts and the difference between them. Every number here
 * traces back to a band the engine produced.
 *
 * A site is a single-linkage cluster of sortie centres at 2 km, which chains
 * on purpose: a haul-out surveyed with a drifting take-off point is still one
 * haul-out. Two counts are only comparable if both exist, so a sortie without
 * a count breaks the chain instead of being bridged over — a delta across a
 * gap would not be a delta between neighbours.
 *
 * Structural input types (not lib/types.ts Footage) so this module stays pure
 * and DOM-free; a Footage satisfies them.
 */
import { clusterIndices } from "./groups";

/** Default site radius, meters. */
export const SITE_RADIUS_M = 2000;

export type CountBandLike = {
  low: number | null;
  best: number | null;
  high: number | null;
  basis: string;
};

export type SurveyFootage = {
  id: string;
  uploadedAt: string;
  center: { lat: number; lng: number };
  band?: CountBandLike | null;
  detections?: { count: number; status: "auto" | "validated" | "false_positive" }[];
};

export type Site<T extends SurveyFootage = SurveyFootage> = {
  /** Index in the returned array — sites have no identity of their own yet. */
  id: number;
  centroid: { lat: number; lng: number };
  footages: T[];
};

export type SurveyDelta = {
  /** best - previous best, animals. */
  abs: number;
  /** Percent change; null when the previous count was zero (undefined). */
  pct: number | null;
};

export type SeriesEntry<T extends SurveyFootage = SurveyFootage> = {
  footage: T;
  uploadedAt: string;
  /** band.best, else the sum of non-false-positive detections; null when
   *  neither exists — an unknown count, never a zero. */
  best: number | null;
  band: CountBandLike | null;
  /** Change from the immediately preceding entry; null at the start of the
   *  series or when either side has no count. */
  delta: SurveyDelta | null;
};

/** The count behind a sortie: the engine's band if it produced one, otherwise
 *  the placed animals it actually found. False positives count for neither. */
export function bestCount(f: SurveyFootage): number | null {
  if (f?.band && f.band.best != null && Number.isFinite(f.band.best)) return f.band.best;
  if (!f?.detections) return null;
  let n = 0;
  for (const d of f.detections) {
    if (d.status === "false_positive") continue;
    if (Number.isFinite(d.count)) n += d.count;
  }
  return n;
}

/**
 * Group sorties into sites by proximity of their centres. Sorties with a
 * non-finite centre are dropped — they cannot be placed, so they cannot be
 * compared against a place.
 */
export function groupIntoSites<T extends SurveyFootage>(
  footages: T[],
  radiusM = SITE_RADIUS_M,
): Site<T>[] {
  // Number() turns a missing centre into NaN, which the clusterer drops.
  const centers = footages.map((f) => ({
    lat: Number(f?.center?.lat),
    lng: Number(f?.center?.lng),
  }));
  return clusterIndices(centers, radiusM).map((members, id) => {
    const group = members.map((i) => footages[i]);
    let lat = 0;
    let lng = 0;
    for (const f of group) {
      lat += f.center.lat;
      lng += f.center.lng;
    }
    // Arithmetic mean is exact enough inside a 2 km cluster (and the Caspian
    // is nowhere near the antimeridian, where it would not be).
    return {
      id,
      centroid: { lat: lat / group.length, lng: lng / group.length },
      footages: group,
    };
  });
}

/** A site's sorties oldest first, each with its count and its change from the
 *  previous sortie. Sorties with an unparseable date keep input order at the
 *  end — an invented position on a timeline is still an invention. */
export function siteSeries<T extends SurveyFootage>(site: Site<T>): SeriesEntry<T>[] {
  const ordered = site.footages
    .map((f, i) => ({ f, i, t: Date.parse(f?.uploadedAt ?? "") }))
    .sort((a, b) => {
      const at = Number.isFinite(a.t) ? a.t : Infinity;
      const bt = Number.isFinite(b.t) ? b.t : Infinity;
      return at - bt || a.i - b.i;
    })
    .map((e) => e.f);

  const out: SeriesEntry<T>[] = [];
  for (const f of ordered) {
    const best = bestCount(f);
    const prev = out.length > 0 ? out[out.length - 1].best : null;
    let delta: SurveyDelta | null = null;
    if (best != null && prev != null) {
      const abs = best - prev;
      delta = { abs, pct: prev === 0 ? null : (abs / prev) * 100 };
    }
    out.push({ footage: f, uploadedAt: f.uploadedAt, best, band: f.band ?? null, delta });
  }
  return out;
}
