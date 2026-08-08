/**
 * area.ts — the ground a survey actually looked at.
 *
 * The only defensible area is the imagery footprint: pixel dimensions times
 * the ground sample distance. No GSD — no altitude, no camera metadata —
 * means no area at all, and this module returns null rather than a
 * plausible-looking guess.
 *
 * One media footprint: width_px * height_px * (gsd_cm_px / 100)^2 m².
 * A VIDEO sortie is not one footprint: the engine counts on several sampled
 * frames, and one frame's footprint is the ground under one instant of a
 * three-minute transect. `sortieAreaM2` multiplies by the frames the engine
 * actually used, which is what makes the figure answer the question its label
 * asks. Frames of one video overlap heavily, so that sum is an upper bound
 * rather than a deduplicated corridor; whoever renders a total must label it
 * "frame footprints, overlap not deduplicated" and say how many sorties had
 * no GSD at all — hence the `known`/`unknown` split in AreaTotal.
 *
 * A GSD the service only ASSUMED (sensor width or optics guessed rather than
 * measured) puts a guess under every derived area, so AreaTotal counts those
 * sorties separately too: a total resting on assumed scale must not be
 * presented identically to one measured from optics.
 *
 * Pure, dependency-free, DOM-free.
 */

/** m² in one hectare. */
export const M2_PER_HA = 10000;
/** m² in one km². */
export const M2_PER_KM2 = 1000000;

export type FootprintInput = {
  widthPx: number;
  heightPx: number;
  gsdCmPx?: number | null;
};

export type AreaTotal = {
  /** Sum of the known footprints, m². */
  m2: number;
  /** Sorties whose footprint is measurable. */
  known: number;
  /** Sorties with no usable GSD — their ground area is unknown, not zero. */
  unknown: number;
  /** Of the known ones, how many rest on a GSD the service assumed rather
   *  than measured. Their area is a guess with a decimal point on it. */
  assumed: number;
};

/** Ground area of one image/frame in m²; null when the GSD is unknown. */
export function footprintM2({ widthPx, heightPx, gsdCmPx }: FootprintInput): number | null {
  if (gsdCmPx == null || !Number.isFinite(gsdCmPx) || gsdCmPx <= 0) return null;
  if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx)) return null;
  if (widthPx <= 0 || heightPx <= 0) return null;
  const mPerPx = gsdCmPx / 100;
  return widthPx * heightPx * mPerPx * mPerPx;
}

/**
 * Ground the frames of ONE SORTIE cover: the frame footprint times the number
 * of frames the engine counted on. A still is one frame; a video is as many as
 * the run's ledger lists.
 *
 * An unknown frame count yields null, not a one-frame area: printing a single
 * frame under a "surveyed area" label is the error this function exists to
 * stop, and silently defaulting to 1 would reintroduce it.
 */
export function sortieAreaM2(
  input: FootprintInput & { frames?: number | null },
): number | null {
  const one = footprintM2(input);
  if (one === null) return null;
  const n = input.frames;
  if (n == null || !Number.isFinite(n) || n < 1) return null;
  return one * Math.floor(n);
}

/** True for the service's `gsd_source` tokens that mean "guessed": explicit
 *  and optics are measured, everything prefixed `assumed_` is not. */
export function isAssumedGsd(source?: string | null): boolean {
  return typeof source === "string" && source.startsWith("assumed");
}

/** Total of the areas that exist, plus how many sorties had / lacked one and
 *  how many of the ones that had it were working off an assumed scale. */
export function totalAreaM2(
  footages: { areaM2?: number | null; gsdSource?: string | null }[],
): AreaTotal {
  let m2 = 0;
  let known = 0;
  let unknown = 0;
  let assumed = 0;
  for (const f of footages) {
    const a = f?.areaM2;
    // Negative or non-finite is not a measurement — it counts as unknown.
    if (a == null || !Number.isFinite(a) || a < 0) {
      unknown++;
      continue;
    }
    m2 += a;
    known++;
    if (isAssumedGsd(f?.gsdSource)) assumed++;
  }
  return { m2, known, unknown, assumed };
}

export function m2ToHa(m2: number): number {
  return m2 / M2_PER_HA;
}

export function m2ToKm2(m2: number): number {
  return m2 / M2_PER_KM2;
}

/** BCP-47 tag for number formatting. Kept local so this module stays
 *  dependency-free — lib/i18n.ts pulls in React and zustand. */
function localeTag(lang: string): string {
  return lang === "kk" ? "kk-KZ" : lang === "ru" ? "ru-RU" : "en";
}

/**
 * Hectares with one decimal in the language's own separators — the NUMBER
 * only; the caller appends the localized unit word.
 *
 * A non-finite input renders as an em dash: "we did not measure it" is not
 * the same statement as "0.0".
 */
export function formatArea(m2: number, lang: string): string {
  if (!Number.isFinite(m2)) return "—";
  const ha = m2ToHa(m2);
  // A real but tiny footprint must never collapse to "0.0" — that reads as
  // "nothing was surveyed". Below 0.1 ha keep a second decimal.
  const digits = ha > 0 && ha < 0.1 ? 2 : 1;
  return new Intl.NumberFormat(localeTag(lang), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(ha);
}
