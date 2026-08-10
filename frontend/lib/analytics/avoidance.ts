/**
 * Regional avoidance signals from effort-normalised repeat surveys.
 *
 * Absence is never enough: a region is assessed only when surveyed area is
 * known, the same seasonal window exists in at least five earlier years, and
 * two consecutive recent surveys fall below the historical median. The result
 * is a review signal, not a claim about pollution, vessels or any other cause.
 */
import { countOf, type CountableFootage } from "./count";

const DAY_MS = 86_400_000;

export type RegionalSurvey = CountableFootage & {
  id: string;
  uploadedAt: string;
  capturedAt?: string | null;
  siteRegion?: string | null;
  areaM2?: number | null;
  status?: string;
  retiredAt?: string | null;
};

export type AvoidanceOptions = {
  seasonalWindowDays: number;
  minimumBaselineYears: number;
  modifiedZThreshold: number;
  consecutiveSignals: number;
};

export const DEFAULT_AVOIDANCE_OPTIONS: AvoidanceOptions = {
  seasonalWindowDays: 30,
  minimumBaselineYears: 5,
  modifiedZThreshold: -3.5,
  consecutiveSignals: 2,
};

export type RegionalUsage = {
  region: string;
  observedAt: string;
  timeMs: number;
  count: number;
  areaKm2: number;
  densityPerKm2: number;
  surveyIds: string[];
};

export type RegionAssessment = {
  region: string;
  status: "normal" | "alert" | "insufficient_data";
  latest: RegionalUsage | null;
  previous: RegionalUsage | null;
  historicalMedian: number | null;
  modifiedZ: number | null;
  baselineYears: number;
  reason: "persistent_low_use" | "within_seasonal_norm" | "need_five_year_baseline" | "need_two_recent_surveys";
};

export type RegionAvoidanceResult = {
  assessments: RegionAssessment[];
  alerts: RegionAssessment[];
  usage: RegionalUsage[];
  options: AvoidanceOptions;
  excludedWithoutEffort: number;
  excludedWithoutRegion: number;
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function modifiedZ(value: number, baseline: number[]): { score: number; center: number } {
  const center = median(baseline);
  const mad = median(baseline.map((item) => Math.abs(item - center)));
  if (mad === 0) {
    return { score: value < center ? Number.NEGATIVE_INFINITY : value > center ? Number.POSITIVE_INFINITY : 0, center };
  }
  return { score: (0.6745 * (value - center)) / mad, center };
}

function circularDayDistance(a: Date, b: Date): number {
  const anchor = Date.UTC(2000, a.getUTCMonth(), a.getUTCDate());
  const other = Date.UTC(2000, b.getUTCMonth(), b.getUTCDate());
  const direct = Math.abs(anchor - other) / DAY_MS;
  return Math.min(direct, 366 - direct);
}

export function regionalUsage(surveys: readonly RegionalSurvey[]): {
  usage: RegionalUsage[];
  excludedWithoutEffort: number;
  excludedWithoutRegion: number;
} {
  const buckets = new Map<string, RegionalUsage>();
  let excludedWithoutEffort = 0;
  let excludedWithoutRegion = 0;

  for (const survey of surveys) {
    if (survey.status === "error" || (survey.retiredAt ?? "").trim()) continue;
    const region = (survey.siteRegion ?? "").trim();
    if (!region) {
      excludedWithoutRegion++;
      continue;
    }
    const areaM2 = Number(survey.areaM2);
    if (!Number.isFinite(areaM2) || areaM2 <= 0) {
      excludedWithoutEffort++;
      continue;
    }
    const rawTime = (survey.capturedAt ?? "").trim() || (survey.uploadedAt ?? "").trim();
    const timeMs = Date.parse(rawTime);
    if (!Number.isFinite(timeMs)) continue;
    const date = new Date(timeMs);
    const day = date.toISOString().slice(0, 10);
    const key = `${region}\u0000${day}`;
    const count = countOf(survey);
    const areaKm2 = areaM2 / 1_000_000;
    const bucket = buckets.get(key) ?? {
      region,
      observedAt: `${day}T00:00:00.000Z`,
      timeMs: Date.parse(`${day}T00:00:00.000Z`),
      count: 0,
      areaKm2: 0,
      densityPerKm2: 0,
      surveyIds: [],
    };
    bucket.count += count;
    bucket.areaKm2 += areaKm2;
    bucket.densityPerKm2 = bucket.count / bucket.areaKm2;
    bucket.surveyIds.push(survey.id);
    buckets.set(key, bucket);
  }

  return {
    usage: [...buckets.values()].sort((a, b) => a.timeMs - b.timeMs || a.region.localeCompare(b.region)),
    excludedWithoutEffort,
    excludedWithoutRegion,
  };
}

export function detectRegionAvoidance(
  surveys: readonly RegionalSurvey[] | null | undefined,
  options?: Partial<AvoidanceOptions>,
): RegionAvoidanceResult {
  const defaults = DEFAULT_AVOIDANCE_OPTIONS;
  const o: AvoidanceOptions = {
    seasonalWindowDays: Number(options?.seasonalWindowDays) > 0 ? Number(options?.seasonalWindowDays) : defaults.seasonalWindowDays,
    minimumBaselineYears: Number(options?.minimumBaselineYears) > 0 ? Math.floor(Number(options?.minimumBaselineYears)) : defaults.minimumBaselineYears,
    modifiedZThreshold: Number.isFinite(options?.modifiedZThreshold) ? Number(options?.modifiedZThreshold) : defaults.modifiedZThreshold,
    consecutiveSignals: Number(options?.consecutiveSignals) > 0 ? Math.floor(Number(options?.consecutiveSignals)) : defaults.consecutiveSignals,
  };
  const built = regionalUsage(surveys ?? []);
  const regions = [...new Set(built.usage.map((item) => item.region))].sort();
  const assessments: RegionAssessment[] = [];

  for (const region of regions) {
    const series = built.usage.filter((item) => item.region === region);
    const recent = series.slice(-o.consecutiveSignals);
    const latest = recent.length ? recent[recent.length - 1] : null;
    const previous = recent.length > 1 ? recent[recent.length - 2] : null;
    if (recent.length < o.consecutiveSignals || !latest) {
      assessments.push({
        region, status: "insufficient_data", latest, previous,
        historicalMedian: null, modifiedZ: null, baselineYears: 0,
        reason: "need_two_recent_surveys",
      });
      continue;
    }

    const scores = recent.map((point) => {
      const pointDate = new Date(point.timeMs);
      const pointYear = pointDate.getUTCFullYear();
      const baseline = series.filter((candidate) => {
        const date = new Date(candidate.timeMs);
        return date.getUTCFullYear() < pointYear
          && circularDayDistance(pointDate, date) <= o.seasonalWindowDays;
      });
      const years = new Set(baseline.map((candidate) => new Date(candidate.timeMs).getUTCFullYear()));
      if (years.size < o.minimumBaselineYears) return { point, years: years.size, score: null as number | null, center: null as number | null };
      const z = modifiedZ(point.densityPerKm2, baseline.map((candidate) => candidate.densityPerKm2));
      return { point, years: years.size, score: z.score, center: z.center };
    });
    const last = scores[scores.length - 1];
    const baselineYears = Math.min(...scores.map((score) => score.years));
    if (scores.some((score) => score.score === null)) {
      assessments.push({
        region, status: "insufficient_data", latest, previous,
        historicalMedian: last.center, modifiedZ: last.score, baselineYears,
        reason: "need_five_year_baseline",
      });
      continue;
    }
    const alert = scores.every((score) => (score.score as number) <= o.modifiedZThreshold);
    assessments.push({
      region,
      status: alert ? "alert" : "normal",
      latest,
      previous,
      historicalMedian: last.center,
      modifiedZ: last.score,
      baselineYears,
      reason: alert ? "persistent_low_use" : "within_seasonal_norm",
    });
  }

  return {
    assessments,
    alerts: assessments.filter((assessment) => assessment.status === "alert"),
    usage: built.usage,
    options: o,
    excludedWithoutEffort: built.excludedWithoutEffort,
    excludedWithoutRegion: built.excludedWithoutRegion,
  };
}
