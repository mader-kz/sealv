/**
 * area.ts — the ground a survey actually looked at.
 *
 * The only defensible area is the imagery footprint: pixel dimensions times
 * the ground sample distance. No GSD — no altitude, no camera metadata —
 * means no area at all, and this module returns null rather than a
 * plausible-looking guess.
 *
 * One media footprint: width_px * height_px * (gsd_cm_px / 100)^2 m².
 * Frames of one video overlap heavily, so a SUM over frames is an upper
 * bound rather than a surveyed area; whoever renders a total must label it
 * "frame footprints, overlap not deduplicated" and say how many sorties had
 * no GSD at all — hence the `known`/`unknown` split in AreaTotal.
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
};

/** Ground area of one image/frame in m²; null when the GSD is unknown. */
export function footprintM2({ widthPx, heightPx, gsdCmPx }: FootprintInput): number | null {
  if (gsdCmPx == null || !Number.isFinite(gsdCmPx) || gsdCmPx <= 0) return null;
  if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx)) return null;
  if (widthPx <= 0 || heightPx <= 0) return null;
  const mPerPx = gsdCmPx / 100;
  return widthPx * heightPx * mPerPx * mPerPx;
}

/** Total of the areas that exist, plus how many sorties had / lacked one. */
export function totalAreaM2(footages: { areaM2?: number | null }[]): AreaTotal {
  let m2 = 0;
  let known = 0;
  let unknown = 0;
  for (const f of footages) {
    const a = f?.areaM2;
    // Negative or non-finite is not a measurement — it counts as unknown.
    if (a == null || !Number.isFinite(a) || a < 0) {
      unknown++;
      continue;
    }
    m2 += a;
    known++;
  }
  return { m2, known, unknown };
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
