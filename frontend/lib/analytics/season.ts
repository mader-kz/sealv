/**
 * season.ts — the biological season a sortie was flown in, and the pure
 * environment helpers that go with it.
 *
 * The season tag is the reason the two live together: a condition is only
 * readable against the phase of the animal's year it was measured in, so
 * anything that formats a reading and anything that decides which season it
 * belongs to have to agree. Three surfaces render these numbers — the sortie
 * inspector, the season block on the dashboard and the PDF act — and they must
 * print the same value to the same number of digits, or the same measurement
 * appears three ways in one document.
 *
 * Not a calendar quarter. The cofounder's framing, and the one an ecologist
 * reading the акт will expect, is the animal's year:
 *
 *   winter  ice, and pupping ON that ice — the whole reason the north Caspian
 *           is surveyed at all; the count is of pups on a frozen sea
 *   spring  the moult, on the retreating ice edge and then the islands
 *   summer  feeding, open water, haul-outs on sand
 *   autumn  the move north again as the water cools, before the ice forms
 *
 * This matters for one concrete reason, and it is the only claim this module
 * makes: THE SAME WEATHER MEANS DIFFERENT THINGS IN DIFFERENT SEASONS. A
 * −3 °C day in February is the surface the animals are lying on; the same
 * reading in October is a cold snap over open water. So conditions are never
 * pooled across seasons, and every range this product prints says which season
 * it belongs to.
 *
 * The mapping is by MONTH, and that is an approximation of a boundary that is
 * really set by the ice — freeze-up and break-up shift by weeks between years.
 * The UI says so (season.basis) rather than presenting the month cut as if it
 * were the biological event itself. Where the ice was actually measured on the
 * date, that measurement is shown next to the tag and it wins as evidence: the
 * tag is a label, `ice_class` is a fact.
 *
 * Pure: no React, no store, no dictionary. lib/export/pdf.ts builds the report
 * outside the component tree and needs the same answer the panel gives.
 */

export type Season = "winter" | "spring" | "summer" | "autumn";

/** Month → season, 0-based months as JS gives them.
 *
 *  Dec–Feb winter (ice, whelping), Mar–May spring (moult), Jun–Aug summer
 *  (feeding), Sep–Nov autumn (pre-winter). Note this is deliberately OFFSET
 *  from the calendar quarters: December belongs with January, because the ice
 *  does. */
const BY_MONTH: readonly Season[] = [
  "winter", // Jan
  "winter", // Feb
  "spring", // Mar
  "spring", // Apr
  "spring", // May
  "summer", // Jun
  "summer", // Jul
  "summer", // Aug
  "autumn", // Sep
  "autumn", // Oct
  "autumn", // Nov
  "winter", // Dec
];

/** Every season, in the order the year runs for this animal. */
export const SEASONS: readonly Season[] = ["winter", "spring", "summer", "autumn"];

/**
 * The season of an instant, or null when the date does not parse.
 *
 * Null is the honest answer for an unparseable date and callers must render it
 * as "not recorded" — a sortie whose date is unknown has no season, and
 * defaulting it into one would put a flight into a phase of the animal's year
 * nobody observed it in.
 *
 * Read in UTC, deliberately: the stored instants are UTC and the season may
 * not change with the reader's timezone. A 31 May 23:00 UTC sortie is spring
 * for everyone.
 */
export function seasonOf(iso: string | null | undefined): Season | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return BY_MONTH[new Date(ms).getUTCMonth()] ?? null;
}

/**
 * The date a sortie's conditions belong to: when it was FLOWN if that was
 * recorded, otherwise the clock the count ran on.
 *
 * The two are months apart for a re-processed archive, so a caller that shows
 * conditions off the fallback has to say so — `dateIsRecorded` is what it
 * checks. Both halves live here so the inspector, the dashboard and the report
 * cannot each pick a different moment and then print different weather for one
 * sortie.
 */
export function conditionsTime(f: {
  capturedAt?: string | null;
  uploadedAt: string;
}): string {
  const cap = (f.capturedAt ?? "").trim();
  return cap !== "" ? cap : f.uploadedAt;
}

/** Whether `conditionsTime` returned a real flight date rather than the
 *  processing clock. False means every condition shown for this sortie is the
 *  weather of the day it was COUNTED, which is a different claim. */
export function dateIsRecorded(f: { capturedAt?: string | null }): boolean {
  return (f.capturedAt ?? "").trim() !== "";
}

/** Sorties grouped by season, seasons in year order, empty ones dropped.
 *  Sorties with no usable date land under `undated` — carried, never silently
 *  folded into a season. */
export function bySeason<T extends { capturedAt?: string | null; uploadedAt: string }>(
  footages: readonly T[] | null | undefined,
): { groups: Array<{ season: Season; footages: T[] }>; undated: T[] } {
  const buckets = new Map<Season, T[]>();
  const undated: T[] = [];
  for (const f of footages ?? []) {
    const s = seasonOf(conditionsTime(f));
    if (!s) { undated.push(f); continue; }
    const list = buckets.get(s);
    if (list) list.push(f);
    else buckets.set(s, [f]);
  }
  return {
    groups: SEASONS.filter((s) => buckets.has(s)).map((s) => ({ season: s, footages: buckets.get(s) as T[] })),
    undated,
  };
}

/* -------------------------------------------------- reading a measurement

   Everything below is about printing a stored number without adding anything
   to it. No unit conversion that would restate the measurement (an ice
   concentration stays the 0–1 fraction the product publishes), no rounding
   that invents precision, and no default for a value that is absent — an
   absent variable never reaches these functions, because it is rendered as a
   gap by the caller. */

/** The order a set of readings is presented in, wherever it is presented:
 *  what the air was doing, then the sea surface, then the water, then the ice,
 *  then the basin, then the food base. Anything not listed sorts after, in the
 *  order the service sent it, so a variable added to the service appears
 *  rather than disappearing. */
export const ENV_VAR_ORDER: readonly string[] = [
  "wind_ms", "wind_dir", "gust_ms", "air_t", "pressure", "cloud",
  "wave_m", "wave_period_s",
  "sst_c", "sst_anomaly_c",
  "ice_class", "ice_conc", "ice_thickness_m",
  "sea_level_m",
  "chl_a",
];

export function envVarRank(name: string): number {
  const i = ENV_VAR_ORDER.indexOf(name);
  return i === -1 ? ENV_VAR_ORDER.length : i;
}

/** Decimal places per variable — the precision the product actually publishes,
 *  not the float's. Chlorophyll arrives as 11.276397 mg/m³ from a 9 km
 *  reconstruction; printing six decimals of that would be a claim about a
 *  measurement nobody made. */
const DIGITS: Record<string, number> = {
  wind_ms: 1, gust_ms: 1, wind_dir: 0,
  air_t: 1, pressure: 1, cloud: 0,
  wave_m: 2, wave_period_s: 1,
  sst_c: 1, sst_anomaly_c: 1,
  ice_conc: 2, ice_thickness_m: 2,
  sea_level_m: 2, chl_a: 2,
  ice_class: 0,
};

/** The numeric half of a reading, as a string. The unit is a separate token
 *  because it comes out of the dictionary and this module has none. */
export function formatEnvValue(variable: string, value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(DIGITS[variable] ?? 2);
}

/** The dictionary key of a variable's unit, or null where the number carries
 *  no unit at all (an IMS ice class is an enum, not a quantity). */
export function envUnitKey(variable: string): string | null {
  switch (variable) {
    case "wind_ms":
    case "gust_ms": return "env.unit.ms";
    case "wind_dir": return "env.unit.deg";
    case "air_t":
    case "sst_c":
    case "sst_anomaly_c": return "env.unit.celsius";
    case "pressure": return "env.unit.hpa";
    case "cloud": return "env.unit.percent";
    case "wave_m":
    case "ice_thickness_m":
    case "sea_level_m": return "env.unit.m";
    case "wave_period_s": return "env.unit.s";
    case "chl_a": return "env.unit.chl";
    case "ice_conc": return "env.unit.fraction";
    default: return null;
  }
}

/** The IMS ice class of a cell, as a dictionary key. 2 is LAND, and it is in
 *  the data honestly — the 1 km chart covers the whole tile, so a coastal
 *  survey point can legitimately land on it. It is named as land; it is never
 *  hidden and never coloured as ice. */
export function iceClassKey(value: number): string | null {
  const n = Math.round(value);
  return n >= 1 && n <= 4 ? `env.iceClass.${n}` : null;
}

/* ------------------------------------------------------------ the compass

   A wind direction is stored as degrees, meteorological convention: the
   direction the wind comes FROM. 344° is a north-northwesterly, and an
   operator who flew that day will read the word before the number. Both are
   printed — the word alone loses precision the instrument had, the number
   alone makes a reader do trigonometry to picture the flight.

   Eight points, not sixteen: the atmospheric grid over this basin is 6.5 km at
   best, and splitting that into 22.5° names implies a directional precision
   the model does not have. */
export type CompassPoint = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

const POINTS: readonly CompassPoint[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

/** The eight points in compass order, for listing a set of observed bearings:
 *  "N · NE · E" reads as a quadrant, "SW · E · NE" reads as noise. */
export const COMPASS_ORDER: readonly CompassPoint[] = POINTS;

/** The eight-point compass name of a meteorological bearing, or null when the
 *  value is not a usable bearing. Null is rendered as the raw degrees. */
export function compassOf(deg: number | null | undefined): CompassPoint | null {
  if (typeof deg !== "number" || !Number.isFinite(deg)) return null;
  const norm = ((deg % 360) + 360) % 360;
  return POINTS[Math.round(norm / 45) % 8];
}

/* ------------------------------------------------------------ value ranges

   Across a season's sorties, one source's one variable: the lowest and the
   highest actually measured, and how many sorties that rests on. Never a mean
   — averaging a wind speed over a fortnight of sorties produces a number that
   describes no day anybody flew. Never across sources either: MUR at 1 km and
   CoralTemp at 5 km measure the same water and disagree, and a range spanning
   both would be a fabricated spread. */
export type EnvRange = {
  source: string;
  dataset: string;
  variable: string;
  min: number;
  max: number;
  /** Sorties this range was measured over. */
  n: number;
  /** The oldest and newest slice behind it. */
  from: string;
  to: string;
  resolutionM: number | null;
  scope: string;
};

type RangeInput = {
  source: string;
  dataset: string;
  measured_at: string;
  values: Partial<Record<string, number>>;
  resolution_m: number | null;
  scope: string;
};

/**
 * Ranges over a set of per-sortie answers. `answers` is one entry per sortie
 * (the samples that sortie's conditions produced); a sortie that contributed
 * nothing simply does not appear in any range's `n`.
 *
 * Keyed by source AND variable, so nothing is merged that was not measured
 * together.
 */
export function envRanges(answers: readonly (readonly RangeInput[])[]): EnvRange[] {
  const acc = new Map<string, EnvRange>();
  for (const samples of answers) {
    for (const s of samples ?? []) {
      for (const [variable, raw] of Object.entries(s.values ?? {})) {
        if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
        const key = `${s.source} ${variable}`;
        const prev = acc.get(key);
        if (!prev) {
          acc.set(key, {
            source: s.source,
            dataset: s.dataset,
            variable,
            min: raw,
            max: raw,
            n: 1,
            from: s.measured_at,
            to: s.measured_at,
            resolutionM: s.resolution_m,
            scope: s.scope,
          });
          continue;
        }
        prev.min = Math.min(prev.min, raw);
        prev.max = Math.max(prev.max, raw);
        prev.n += 1;
        if (s.measured_at < prev.from) prev.from = s.measured_at;
        if (s.measured_at > prev.to) prev.to = s.measured_at;
      }
    }
  }
  return [...acc.values()];
}
