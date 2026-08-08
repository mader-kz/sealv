/**
 * brush.ts — the timeline brush, and the dates that label it.
 *
 * The date brush was reimplemented in four components, byte for byte: build an
 * array of upload times, `.sort((a,b)=>a-b)` it, then read min/max off a
 * `Math.min(...)` spread that made the sort dead work. Four copies of a filter
 * is four chances for the map, the list and the analytics panel to disagree
 * about which sorties are in the window, which for this product means three
 * different seal totals on one screen.
 *
 * One copy, one pass, no sort. (components/map/CaspianMap.tsx still carries a
 * fifth private copy — it belongs to another change in flight and is meant to
 * come here next; this comment is the note to the reader who finds it.)
 *
 * Date formatting lives here for the same reason: the timeline and the footage
 * list hardcoded `toLocaleDateString("en-CA")` while the analytics panel and
 * the report used the UI language, so one screen printed 2026-08-09 next to
 * 09.08.2026. The locale mapping is duplicated from lib/i18n rather than
 * imported, because this module has to stay free of React and zustand:
 * lib/export/pdf.ts builds the report outside the component tree.
 */

export type TimeExtent = {
  /** Oldest upload, ms. */
  min: number;
  /** Newest upload, ms. */
  max: number;
  /** max - min, floored at 1 so a single-day season is still divisible. */
  span: number;
};

type Dated = { uploadedAt: string };
type Owned = { footageId: string };
type Identified = { id: string };

/** Oldest/newest upload time across the sorties, or null when none parses. */
export function timeExtent(footages: readonly Dated[] | null | undefined): TimeExtent | null {
  let min = Infinity;
  let max = -Infinity;
  for (const f of footages ?? []) {
    const t = Date.parse(f?.uploadedAt ?? "");
    if (!Number.isFinite(t)) continue;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  if (min === Infinity) return null;
  return { min, max, span: max - min || 1 };
}

/**
 * The sorties inside the brush, where `range` is a [start, end] pair in
 * percent of the season's span. A sortie with an unparseable date is kept:
 * hiding a real survey because its timestamp is malformed would quietly drop
 * it out of every total on the screen.
 */
export function footagesInRange<T extends Dated>(
  footages: readonly T[] | null | undefined,
  range: readonly [number, number] | null | undefined,
): T[] {
  const list = (footages ?? []) as readonly T[];
  if (list.length === 0) return [];
  const lo0 = Number(range?.[0] ?? 0);
  const hi0 = Number(range?.[1] ?? 100);
  const from = Number.isFinite(lo0) ? lo0 : 0;
  const to = Number.isFinite(hi0) ? hi0 : 100;
  if (from <= 0 && to >= 100) return list.slice();

  const ext = timeExtent(list);
  if (!ext) return list.slice();
  const lo = ext.min + ext.span * (from / 100);
  const hi = ext.min + ext.span * (to / 100);
  return list.filter((f) => {
    const t = Date.parse(f?.uploadedAt ?? "");
    if (!Number.isFinite(t)) return true;
    return t >= lo && t <= hi;
  });
}

/** The detections belonging to these sorties. */
export function detectionsFor<F extends Identified, D extends Owned>(
  footages: readonly F[] | null | undefined,
  detections: readonly D[] | null | undefined,
): D[] {
  const ids = new Set((footages ?? []).map((f) => f.id));
  return (detections ?? []).filter((d) => ids.has(d.footageId));
}

/** BCP-47 locale for a UI language. Mirrors localeFor() in lib/i18n. */
export function localeForLang(lang: string): string {
  return lang === "kk" ? "kk-KZ" : lang === "ru" ? "ru-RU" : "en";
}

/**
 * A date in the reader's language. An unparseable value comes back verbatim —
 * printing "Invalid Date" over a timestamp the service actually sent tells the
 * reader nothing about what went wrong.
 */
export function formatDate(
  iso: string | number | null | undefined,
  lang: string,
  opts?: Intl.DateTimeFormatOptions,
): string {
  if (iso == null || iso === "") return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString(localeForLang(lang), opts);
}
