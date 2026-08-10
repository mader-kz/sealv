/**
 * anomaly.ts — "the count at this place dropped. Is that worth driving out to
 * look at, or did the weather simply put the animals in the water?"
 *
 * WHERE THE PROBABILITY COMES FROM, because a percentage with no derivation is
 * the one thing this product must never print.
 *
 * Counting animals is a counting process, and counting processes have a KNOWN
 * spread: count the same unchanged colony twice and the two numbers differ,
 * with a variance that grows with the count itself. So "700 became 300" is not
 * a bare pair of numbers — it is an observation that can be tested against the
 * hypothesis "nothing about this place changed". That test needs no training
 * data and no fitted coefficients: it is arithmetic on the counts themselves.
 *
 *   p = P(observing this few, or fewer, if nothing changed)
 *
 * Read out loud: "a drop this big or bigger would happen by chance in about 1
 * survey out of 300". That sentence is defensible in front of anybody, which
 * a fabricated "87% likely migration" is not.
 *
 * Poisson would be the textbook choice and it is WRONG here — it assumes the
 * only noise is counting noise, and would flag every ordinary re-survey as a
 * five-sigma emergency. Real repeat counts of wildlife are overdispersed: the
 * detector misses animals under glare, some lie under others, the flight line
 * differs. So the model is negative-binomial with an overdispersion factor
 * (variance = phi x mean), phi defaulting to a deliberately conservative 3 —
 * measured overdispersion in aerial wildlife counts is usually 1.5-4. A
 * conservative phi makes the test HARDER to trigger, which is the direction an
 * honest alarm should err in.
 *
 * WHAT IS DIVIDED OUT BEFORE THE TEST, so the alarm is about animals and not
 * about us:
 *
 *   - SURVEYED AREA. Half the ground photographed is half the animals seen and
 *     nothing to do with the colony. The expectation scales by the ratio of
 *     surveyed footprints, when both sorties measured one.
 *   - REVIEW. A pass where a person rejected a third of the detections is not
 *     comparable with an unreviewed one. Rejections are removed from both
 *     sides where the archive knows them.
 *
 * WHAT IS NOT DIVIDED OUT, on purpose:
 *
 *   - WEATHER. Wind and waves genuinely move animals off a beach and into the
 *     water, and with three days of observations there is no basis to fit that
 *     relationship. Inventing a coefficient would be exactly the fabrication
 *     this file exists to avoid. So the conditions of both visits are REPORTED
 *     next to the probability, and the verdict says plainly that a drop under
 *     a rising wind is not yet distinguishable from a departure. When the
 *     season's surveys arrive, `fitAvailability` below is where that gets
 *     learned — and until it has enough visits it returns null rather than a
 *     number nobody measured.
 */

/** A visit, reduced to what the test needs. */
export type VisitLike = {
  /** The standing count for that visit. Null = no count; skipped. */
  count: number | null;
  /** Surveyed footprint in m2, when the sortie carried a scale. */
  areaM2?: number | null;
  /** Detections a person ruled out, if the archive knows. */
  rejected?: number | null;
  when?: string | null;
  /** Conditions at that visit, flattened: wind_ms, wave_m, sst_c, ... */
  env?: Record<string, number | null | undefined> | null;
};

/** Overdispersion: variance = OVERDISPERSION x mean. Conservative on purpose —
 *  see the module docblock. Exported so a future fit can replace it with a
 *  measured value and every caller moves at once. */
export const OVERDISPERSION = 3;

/** Below this the alarm is worth a person's attention. 0.05 is the ordinary
 *  scientific threshold and it is stated on screen, not hidden in code. */
export const ALARM_P = 0.05;

/** Conditions whose change is reported beside a drop. Wind and waves are the
 *  two the literature ties to haul-out behaviour; the rest are context. */
export const WEATHER_KEYS = ["wind_ms", "gust_ms", "wave_m"] as const;

export type Explanation = {
  /** Counts after area and review are divided out — what the test compares. */
  expected: number;
  observed: number;
  /** P(observing this few or fewer | nothing changed). Null when either visit
   *  has no count, or the previous count is 0 (nothing to fall from). */
  p: number | null;
  /** How much of the raw change is explained by surveying less ground. */
  areaFactor: number | null;
  /** Rejections removed from the comparison, when known. */
  reviewAdjusted: boolean;
  /** Weather that moved between the two visits, largest relative change first.
   *  REPORTED, never subtracted — see the docblock. */
  weatherShift: Array<{ key: string; from: number; to: number; ratio: number }>;
  /** True when the drop clears the threshold AND the weather did not obviously
   *  move — i.e. the case a person should actually go and look at. */
  alarm: boolean;
  /** Why the module refused to judge, when it did. */
  skipped?: "no-count" | "no-previous" | "increase";
};

/** log-gamma (Lanczos). Needed for the negative-binomial tail below; there is
 *  no dependency to pull in for this and the approximation is exact to ~1e-10
 *  over the range counts live in. */
function lngamma(z: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lngamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * P(X <= k) for a negative binomial with the given mean and variance = phi*mean.
 *
 * Summed term by term in log space: the counts here reach the low thousands and
 * a naive product of gammas overflows long before that. Monotone and bounded to
 * [0,1] by construction; the loop is capped so a pathological input cannot spin.
 */
export function nbCdf(k: number, mean: number, phi = OVERDISPERSION): number {
  if (!Number.isFinite(k) || !Number.isFinite(mean) || mean <= 0) return NaN;
  if (k < 0) return 0;
  if (phi <= 1) {
    // Degenerate to Poisson: variance = mean.
    let sum = 0;
    let logTerm = -mean;
    for (let i = 0; i <= Math.min(k, 1e6); i++) {
      if (i > 0) logTerm += Math.log(mean) - Math.log(i);
      sum += Math.exp(logTerm);
    }
    return Math.min(1, sum);
  }
  // NB parameterised by mean m and variance phi*m:
  //   p = 1/phi (success prob), r = m/(phi-1) (dispersion "size")
  const p = 1 / phi;
  const r = mean / (phi - 1);
  let sum = 0;
  for (let i = 0; i <= Math.min(Math.floor(k), 1e6); i++) {
    const logPmf =
      lngamma(i + r) - lngamma(r) - lngamma(i + 1) +
      r * Math.log(p) + i * Math.log(1 - p);
    sum += Math.exp(logPmf);
    if (sum >= 1) return 1;
  }
  return Math.max(0, Math.min(1, sum));
}

/** Counts made comparable: rejections removed, area scaled to the previous
 *  visit's footprint. Returns null when the visit carries no count. */
function comparable(v: VisitLike): { count: number; area: number | null } | null {
  if (v.count == null || !Number.isFinite(v.count)) return null;
  const rejected = typeof v.rejected === "number" && Number.isFinite(v.rejected) ? v.rejected : 0;
  const area = typeof v.areaM2 === "number" && Number.isFinite(v.areaM2) && v.areaM2 > 0 ? v.areaM2 : null;
  return { count: Math.max(0, v.count - rejected), area };
}

/**
 * Compare a visit with the one before it and say how surprising the change is.
 *
 * Only DROPS are tested. A rise is not an alarm: more animals than last time is
 * good news and needs no ecologist dispatched, and testing both directions
 * would double the false alarms for nothing.
 */
export function explainChange(prev: VisitLike, curr: VisitLike): Explanation {
  const a = comparable(prev);
  const b = comparable(curr);
  const weatherShift = shiftBetween(prev.env, curr.env);

  const base: Explanation = {
    expected: NaN, observed: NaN, p: null, areaFactor: null,
    reviewAdjusted: (prev.rejected ?? 0) > 0 || (curr.rejected ?? 0) > 0,
    weatherShift, alarm: false,
  };

  if (!a || !b) return { ...base, skipped: "no-count" };
  if (a.count <= 0) return { ...base, expected: 0, observed: b.count, skipped: "no-previous" };

  /* The expectation: last time's count, scaled to how much ground this flight
     actually covered. Only when BOTH visits measured an area — a ratio built
     from one measurement and one guess is a guess. */
  const areaFactor = a.area && b.area ? b.area / a.area : null;
  const expected = areaFactor ? a.count * areaFactor : a.count;
  const observed = b.count;

  if (observed >= expected) {
    return { ...base, expected, observed, areaFactor, skipped: "increase" };
  }

  const p = nbCdf(observed, expected);
  /* An alarm needs two things: a drop this test calls surprising, AND weather
     that did not obviously move. A 2x wind between visits is the honest
     alternative explanation, and with three days of data we cannot yet tell
     the two apart — so we say so instead of alarming. */
  const weatherMoved = weatherShift.some((w) => w.ratio >= 1.5);
  return {
    ...base,
    expected, observed, areaFactor,
    p: Number.isFinite(p) ? p : null,
    alarm: Number.isFinite(p) && p < ALARM_P && !weatherMoved,
  };
}

/** Weather that changed between two visits, biggest relative move first. Only
 *  the keys tied to haul-out behaviour, and only when both sides measured. */
export function shiftBetween(
  from: Record<string, number | null | undefined> | null | undefined,
  to: Record<string, number | null | undefined> | null | undefined,
): Explanation["weatherShift"] {
  const out: Explanation["weatherShift"] = [];
  if (!from || !to) return out;
  for (const key of WEATHER_KEYS) {
    const a = from[key];
    const b = to[key];
    if (typeof a !== "number" || typeof b !== "number") continue;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    /* Ratio against a floor: a wind of 0.2 -> 0.6 m/s is a tripling by
       arithmetic and nothing at all by physics. The floor is 1 m/s for wind,
       0.1 m for wave — below those the animals do not care and neither do we. */
    const floor = key === "wave_m" ? 0.1 : 1;
    const lo = Math.max(a, floor);
    const hi = Math.max(b, floor);
    const ratio = hi / lo;
    if (ratio >= 1.2 || ratio <= 1 / 1.2) out.push({ key, from: a, to: b, ratio });
  }
  return out.sort((x, y) => Math.abs(Math.log(y.ratio)) - Math.abs(Math.log(x.ratio)));
}

/**
 * The odds phrasing: "1 in N surveys". Easier to hold than 0.003, and it is the
 * same number — the UI prints both.
 */
export function oneInN(p: number): number | null {
  if (!Number.isFinite(p) || p <= 0) return null;
  return Math.round(1 / p);
}

/**
 * The season's availability model — DELIBERATELY NOT FITTED YET.
 *
 * This is where "how much does wind suppress a haul-out count" gets learned,
 * once there are enough visits with enough spread of conditions to learn it
 * from. Until then it returns null, and every caller treats null as "no such
 * knowledge exists" rather than substituting a default. A returned coefficient
 * would be indistinguishable on screen from a measured one, which is how a
 * placeholder becomes a published finding.
 *
 * MIN_VISITS is the ordinary rule of thumb of ten observations per predictor,
 * with one predictor (wind) and a margin — not a number anybody measured, and
 * labelled as such wherever it is shown.
 */
export const MIN_VISITS_FOR_FIT = 30;

export function fitAvailability(visits: VisitLike[]): null | { slope: number; n: number } {
  const usable = visits.filter(
    (v) => v.count != null && typeof v.env?.wind_ms === "number",
  );
  if (usable.length < MIN_VISITS_FOR_FIT) return null;
  /* Log-linear least squares of count against wind. Kept this simple on
     purpose: the point of the model is the residual, and a two-parameter fit
     is the most a first season can support without overfitting the weather of
     one particular summer. */
  const xs = usable.map((v) => v.env!.wind_ms as number);
  const ys = usable.map((v) => Math.log(Math.max(1, v.count as number)));
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
  const my = ys.reduce((s, y) => s + y, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den === 0) return null;
  return { slope: num / den, n: usable.length };
}
