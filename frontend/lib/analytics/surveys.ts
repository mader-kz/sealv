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
 * haul-out. Since a person can now NAME a place, an explicit site assignment
 * joins that relation — as an extra way to be the same site, never as a
 * replacement for the geometry (see groupIntoSites for why the direction
 * matters to the headline number). Two counts are only comparable if both
 * exist, so a sortie without a count breaks the chain instead of being bridged
 * over — a delta across a gap would not be a delta between neighbours.
 *
 * Structural input types (not lib/types.ts Footage) so this module stays pure
 * and DOM-free; a Footage satisfies them.
 */
import { countOf } from "./count";
import { clusterIndices } from "./groups";

/** Default site radius, meters. */
export const SITE_RADIUS_M = 2000;

/**
 * Does this sortie have a position at all?
 *
 * A run that flew no track and georeferenced no animal still counted animals,
 * so it is kept — but its `center` is `{lat: NaN, lng: NaN}` and `placed` is
 * false, because there is no honest coordinate for it and inventing (0,0)
 * would put a Caspian survey in the Gulf of Guinea. Every surface that PRINTS
 * a coordinate has to ask this first: `NaN, NaN` in a report reads as a
 * measurement, and this product's whole claim is that its numbers are
 * measured. One predicate, so the list row, the CSV, the inspector and the
 * PDF cannot disagree about whether a sortie is on the map.
 */
export function isPlaced(
  f: { center?: { lat: number; lng: number } | null; placed?: boolean } | null | undefined,
): boolean {
  if (!f) return false;
  if (f.placed === false) return false;
  return Number.isFinite(Number(f.center?.lat)) && Number.isFinite(Number(f.center?.lng));
}

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
  /** The site a person ASSIGNED this sortie to, when they named the place.
   *  Null/absent is the normal case and means "grouped by geometry alone". */
  siteId?: string | null;
  /** That site's name as the service last reported it. Carried so a group can
   *  print the name without a second lookup; never used to decide membership. */
  siteName?: string | null;
};

export type Site<T extends SurveyFootage = SurveyFootage> = {
  /** Index in the returned array — the key the panels render against. */
  id: number;
  /** The assigned site every member agrees on, when there is one. Null when no
   *  member is assigned, and ALSO null when two differently-named sites have
   *  been merged by proximity: the group then genuinely has no single identity,
   *  and printing one of the two names would be a claim the data cannot make. */
  siteId: string | null;
  /** The name behind `siteId`. Null whenever `siteId` is. */
  name: string | null;
  centroid: { lat: number; lng: number };
  footages: T[];
};

/**
 * Did this sortie produce a count at all?
 *
 * A failed ingest is a Footage: it has an id, a filename, a place in the list
 * and `status: "error"` — and nothing else. Seven of them used to add seven
 * sorties to "N animals observed across M sorties" and seven entries to the
 * "without GSD" tally, so a season of 5 real surveys reported 12 and blamed 7
 * of them for having no scale. Neither statement was about a survey.
 *
 * A count exists when the engine produced a band with a real best, or when at
 * least one animal survived review, or when a person entered the number
 * themselves (engine "manual" — a ground count of ZERO is a real observation
 * and has neither a band's basis nor a detection to point at).
 *
 * The gate for the sortie count, the area tallies, the CSV and the PDF. One
 * predicate, so those four cannot disagree about which rows are surveys.
 */
export type ResultFootage = {
  status?: string;
  band?: CountBandLike | null;
  detections?: { count: number; status: "auto" | "validated" | "false_positive" }[];
  /** "manual" for a count a person entered rather than the engine derived. */
  engine?: string | null;
};

export function hasResult(f: ResultFootage | null | undefined): boolean {
  if (!f) return false;
  if (f.status === "error") return false;
  if (f.engine === "manual") return true;
  const best = f.band?.best;
  if (typeof best === "number" && Number.isFinite(best)) return true;
  return (f.detections ?? []).some((d) => d && d.status !== "false_positive");
}

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

/** The count behind a sortie — countOf(), with one addition this module needs
 *  and the panels do not: a sortie with nothing to count has an UNKNOWN count,
 *  and null keeps it out of a delta. A gap is not a zero, and subtracting from
 *  a zero that was never measured invents a crash or a boom that nobody
 *  observed.
 *
 *  "Nothing to count" is no band AND not one surviving detection — an absent
 *  list and a present-but-empty one make the same claim here, since neither
 *  reports an observation. A sortie that genuinely saw zero animals says so
 *  with a band whose best is 0, which the first branch returns as the real
 *  measurement it is. */
export function bestCount(f: SurveyFootage): number | null {
  if (f?.band && f.band.best != null && Number.isFinite(f.band.best)) return f.band.best;
  const counted = (f?.detections ?? []).some(
    (d) => d.status !== "false_positive" && Number.isFinite(d.count),
  );
  return counted ? countOf(f) : null;
}

/**
 * Group sorties into sites. Sorties with a non-finite centre are dropped —
 * they cannot be placed, so they cannot be compared against a place. Sorties a
 * caller wants excluded (retired ones) are excluded by the CALLER, by passing
 * a filtered list; this function has no policy about them, because a helper
 * that quietly drops rows is how a total loses a colony.
 *
 * Two sorties are the same site when EITHER holds:
 *   (a) they carry the same non-null `siteId` — a person named this place;
 *   (b) their centres are within `radiusM` (2 km single linkage, as before).
 *
 * Single linkage over the UNION of those two relations, which makes naming a
 * place a MERGE and only ever a merge. That direction is the whole safety
 * property, and it is worth stating why the obvious alternative is wrong:
 * "cluster by siteId, and fall back to 2 km only for the unassigned" would
 * SPLIT an assigned sortie away from an unassigned neighbour 500 m off. The
 * two would then be two sites, each contributing its latest count, and the
 * headline estimate would RISE because someone typed a name. Under a
 * merge-only rule the output partition is always a coarsening of the pure-2 km
 * partition, so the current estimate can only ever fall or stay put — never
 * rise — when a site is named.
 *
 * The coarsening is structural, not a convention to be kept: the union-find
 * below is SEEDED with every proximity cluster whole and the siteId pass only
 * calls `union`, which cannot split. Any future edit that wants to separate
 * two sorties has to add a way to un-union them, which does not exist here.
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
  const proximity = clusterIndices(centers, radiusM);

  /* Union-find over the sortie indices the clusterer KEPT. Seeded with every
     proximity cluster whole, so no geometric grouping can be undone here; the
     siteId pass then only ever adds unions on top. */
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    for (;;) {
      const p = parent.get(r);
      if (p === undefined || p === r) break;
      r = p;
    }
    let c = x;
    for (;;) {
      const p = parent.get(c);
      if (p === undefined || p === c) break;
      parent.set(c, r);
      c = p;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  const kept: number[] = [];
  for (const members of proximity) {
    for (const i of members) {
      parent.set(i, i);
      kept.push(i);
    }
    for (let k = 1; k < members.length; k++) union(members[0], members[k]);
  }

  // (a) explicit identity, applied to the same index space.
  const firstWithSite = new Map<string, number>();
  for (const i of kept) {
    const sid = footages[i]?.siteId;
    if (typeof sid !== "string" || !sid) continue;
    const seen = firstWithSite.get(sid);
    if (seen === undefined) firstWithSite.set(sid, i);
    else union(seen, i);
  }

  /* Emit deterministically: groups ordered by their smallest member index and
     members ascending — the order clusterIndices already documents, so on data
     with no assigned sites the output is identical to the previous version's,
     down to the `id` each panel keys on. */
  const byRoot = new Map<number, number[]>();
  for (const i of kept) {
    const root = find(i);
    const bucket = byRoot.get(root);
    if (bucket) bucket.push(i);
    else byRoot.set(root, [i]);
  }
  const groups = [...byRoot.values()].map((m) => m.slice().sort((a, b) => a - b));
  groups.sort((a, b) => a[0] - b[0]);

  return groups.map((members, id) => {
    const group = members.map((i) => footages[i]);
    let lat = 0;
    let lng = 0;
    for (const f of group) {
      lat += f.center.lat;
      lng += f.center.lng;
    }
    /* The assigned identity, only when the group has exactly one. Two named
       sites merged by proximity leave it null rather than picking a winner. */
    let siteId: string | null = null;
    let name: string | null = null;
    let ambiguous = false;
    for (const f of group) {
      const sid = typeof f?.siteId === "string" && f.siteId ? f.siteId : null;
      if (!sid) continue;
      if (siteId === null) {
        siteId = sid;
        name = typeof f?.siteName === "string" && f.siteName ? f.siteName : null;
      } else if (siteId !== sid) {
        ambiguous = true;
      } else if (name === null && typeof f?.siteName === "string" && f.siteName) {
        name = f.siteName;
      }
    }
    if (ambiguous) {
      siteId = null;
      name = null;
    }
    // Arithmetic mean is exact enough inside a 2 km cluster (and the Caspian
    // is nowhere near the antimeridian, where it would not be).
    return {
      id,
      siteId,
      name,
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
