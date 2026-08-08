/**
 * latlng.ts — one coordinate pair, typed by a person, out of whatever they
 * pasted.
 *
 * This is the field team's path into the app: somebody reads a hand-held GPS,
 * or copies a coordinate out of Google Maps, and types it into the pin
 * control. So the forms it has to accept are not a matter of taste — they are
 * whatever the tools those people already use produce:
 *
 *   43.65, 51.18      Google Maps, and the single most common paste
 *   43.65,51.18       the same thing with the space stripped
 *   43.65 51.18       a GPS readout
 *   43,65 51,18       a decimal comma, which is what a Russian or Kazakh
 *                     locale device writes
 *   43,65, 51,18      decimal comma AND a comma separator, together
 *   43.65; 51.18      a semicolon separator
 *
 * The hard case is the fourth and fifth: the comma is doing two different jobs
 * in the same string. The previous implementation normalised decimal commas
 * FIRST (`replace(/,(\d)/g, ".$1")`), which turned the canonical `43.65,51.18`
 * into `43.65.51.18` and then refused it — rejecting exactly the form the
 * users this control was built for produce, while accepting four rarer ones.
 *
 * So: split on the separator first, normalise each half after. The separator
 * is a comma only where it is not already acting as a decimal point, which is
 * decidable because a coordinate pair has exactly two numbers in it.
 *
 * Pure and dependency-free so the selftest can run it under plain node — this
 * used to live inside a MapLibre component, where nothing could reach it.
 */

export type LatLng = { lat: number; lng: number };

/** One number, with either decimal separator. `43`, `43.65`, `-43,65`. */
const NUMBER = String.raw`-?\d+(?:[.,]\d+)?`;

/* Whitespace or a semicolon always separates. A comma separates only when the
   rest of the string still parses as one whole number - which is what the
   lookahead checks - so `43,65 51,18` splits on the space and `43.65,51.18`
   splits on the comma, with no ambiguity to guess about. */
const PAIR = new RegExp(
  String.raw`^\s*(${NUMBER})\s*(?:[;\s]+|,)\s*(${NUMBER})\s*$`,
);

const toNumber = (s: string): number => Number(s.replace(",", "."));

/**
 * Parse a typed coordinate pair. Returns null for anything that is not two
 * numbers in range — a partial entry, a place name, one number, three numbers,
 * a latitude of 450.
 *
 * Range-checked here rather than by the caller: a coordinate outside the
 * globe is not a coordinate, and letting it through to be clamped later is how
 * a typo becomes a pin somebody has to explain.
 */
export function parseLatLng(text: string): LatLng | null {
  const m = PAIR.exec(String(text ?? ""));
  if (!m) return null;
  const lat = toNumber(m[1]);
  const lng = toNumber(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}
