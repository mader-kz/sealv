/**
 * tracking.ts — cautious, reproducible matching of observed seal groups.
 *
 * This is an inference over anonymous detections, not animal identification.
 * First, detections are clustered INSIDE each sortie at a contact radius.
 * Then a group can continue an older track only when it is both geographically
 * reachable and similar in size. Matching is one-to-one and deterministic.
 * Anything unmatched starts a new track; nothing is forced across a gap.
 *
 * The output deliberately calls these `tracks`, never populations. A track is
 * a hypothesis that several observations describe the same aggregation. It
 * becomes scientific evidence only after a reviewer or an external tagging
 * method confirms that identity.
 */
import { clusterIndices } from "./groups";

const EARTH_RADIUS_KM = 6371.0088;
const DAY_MS = 86_400_000;

/*
 * Source-informed operating defaults supplied by the project's literature
 * review. They are gates/priors, not claims that every seal population follows
 * one universal norm. Track-specific medians and MAD take precedence once
 * enough local history exists.
 */
const HARD_GEOLOCATION_OUTLIER_KM = 173;
const PREDICTION_HORIZON_DAYS = 7;
const PREDICTION_HISTORY_DAYS = 90;
const MODIFIED_Z_THRESHOLD = 3.5;
const MIN_CONSECUTIVE_ANOMALOUS_SURVEYS = 2;

export type TrackingDetection = {
  id: string;
  lat: number;
  lng: number;
  count: number;
  status: "auto" | "validated" | "false_positive";
};

export type TrackingSurvey = {
  id: string;
  uploadedAt: string;
  capturedAt?: string | null;
  detections?: TrackingDetection[];
  status?: string;
  retiredAt?: string | null;
};

export type TrackingOptions = {
  /** Animals this close are one observed group (single linkage). */
  groupRadiusM: number;
  /** Singles are detections, not a population-level aggregation. */
  minGroupSize: number;
  /** Allowed change relative to the previous observation. */
  sizeTolerancePct: number;
  /** Geographic gate grows with time between observations. */
  maxSpeedKmPerDay: number;
  /** Absorbs coordinate/centroid noise for observations close in time. */
  baseDistanceKm: number;
  /** A track is not silently revived after an arbitrarily long absence. */
  maxGapDays: number;
};

export const DEFAULT_TRACKING_OPTIONS: TrackingOptions = {
  groupRadiusM: 5,
  minGroupSize: 2,
  sizeTolerancePct: 40,
  maxSpeedKmPerDay: 60,
  baseDistanceKm: 2,
  maxGapDays: 14,
};

export type MatchConfidence = "high" | "medium" | "low";

export type GroupObservation = {
  id: string;
  surveyId: string;
  observedAt: string;
  timeMs: number;
  center: { lat: number; lng: number };
  size: number;
  memberIds: string[];
  /** `points` has one coordinate per animal; `aggregate` has only one marker. */
  source: "points" | "aggregate";
  /** Set only when this observation continued an existing track. */
  match?: {
    distanceKm: number;
    gapDays: number;
    speedKmPerDay: number;
    sizeChangePct: number;
    score: number;
    confidence: MatchConfidence;
    /** Another acceptable predecessor/successor was almost as plausible. */
    ambiguous: boolean;
  };
};

export type MovementAnomalyKind =
  | "speed"
  | "sharp_turn"
  | "unusual_interval"
  | "route_deviation";

export type MovementAnomaly = {
  id: string;
  kind: MovementAnomalyKind;
  severity: "warning" | "critical";
  observationId: string;
  surveyId: string;
  observedAt: string;
  /** Measurement in the kind's natural unit: km/day, degrees, days, or km. */
  value: number;
  /** Deterministic historical/option-derived boundary crossed by `value`. */
  threshold: number;
  /** Historical median when enough earlier segments exist. */
  baseline?: number;
};

export type TrackPrediction = {
  center: { lat: number; lng: number };
  predictedAt: string;
  horizonDays: number;
  /** Compass bearing: 0=north, 90=east. */
  bearingDeg: number;
  distanceKm: number;
  speedKmPerDay: number;
  confidence: MatchConfidence;
  basisObservations: number;
};

export type GroupTrack = {
  id: string;
  ordinal: number;
  observations: GroupObservation[];
  totalDistanceKm: number;
  confidence: MatchConfidence | null;
  ambiguous: boolean;
  /** Constant-velocity extrapolation from up to three recent segments. */
  prediction?: TrackPrediction;
  /** Deviations from this track's own recent history and configured gates. */
  anomalies?: MovementAnomaly[];
};

export type GroupTrackEvent = {
  id: string;
  type: "split" | "merge";
  surveyId: string;
  occurredAt: string;
  timeMs: number;
  sourceTrackIds: string[];
  targetTrackIds: string[];
  sourceObservationIds: string[];
  targetObservationIds: string[];
  sizeBefore: number;
  sizeAfter: number;
  sizeConservationPct: number;
  maxDistanceKm: number;
  confidence: MatchConfidence;
};

export type TrackingResult = {
  tracks: GroupTrack[];
  /** Inferred one-to-many / many-to-one transitions; never identity proof. */
  events: GroupTrackEvent[];
  observations: number;
  /** Valid animals omitted because they were singletons or below minGroupSize. */
  untrackedAnimals: number;
  surveysUsed: number;
  surveysSkipped: number;
  options: TrackingOptions;
};

function stableHash(value: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

function finitePositive(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizedOptions(raw: Partial<TrackingOptions> | undefined): TrackingOptions {
  const d = DEFAULT_TRACKING_OPTIONS;
  return {
    groupRadiusM: finitePositive(raw?.groupRadiusM, d.groupRadiusM),
    minGroupSize: Math.max(1, Math.floor(finitePositive(raw?.minGroupSize, d.minGroupSize))),
    sizeTolerancePct: finitePositive(raw?.sizeTolerancePct, d.sizeTolerancePct),
    maxSpeedKmPerDay: finitePositive(raw?.maxSpeedKmPerDay, d.maxSpeedKmPerDay),
    baseDistanceKm: finitePositive(raw?.baseDistanceKm, d.baseDistanceKm),
    maxGapDays: finitePositive(raw?.maxGapDays, d.maxGapDays),
  };
}

/** Great-circle distance. Exported so the UI and tests never reimplement it. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const p1 = a.lat * rad;
  const p2 = b.lat * rad;
  const dp = (b.lat - a.lat) * rad;
  const dl = (b.lng - a.lng) * rad;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function surveyTime(s: TrackingSurvey): { iso: string; ms: number } | null {
  const raw = (s.capturedAt ?? "").trim() || (s.uploadedAt ?? "").trim();
  const ms = Date.parse(raw);
  return raw && Number.isFinite(ms) ? { iso: new Date(ms).toISOString(), ms } : null;
}

/**
 * Produce independent group snapshots for one sortie. Aggregate markers are
 * already a whole-sortie count at one coordinate, so they remain one group and
 * are never mixed into the per-animal spatial clustering.
 */
export function groupsForSurvey(
  survey: TrackingSurvey,
  options?: Partial<TrackingOptions>,
): { groups: GroupObservation[]; untrackedAnimals: number } {
  const o = normalizedOptions(options);
  const when = surveyTime(survey);
  if (!when) return { groups: [], untrackedAnimals: 0 };

  const valid = (survey.detections ?? []).filter(
    (d) =>
      d.status !== "false_positive" &&
      Number.isFinite(d.lat) &&
      Number.isFinite(d.lng) &&
      Number.isFinite(d.count) &&
      d.count > 0,
  );
  const individuals = valid.filter((d) => d.count === 1);
  const aggregate = valid.filter((d) => d.count > 1);
  const raw: Omit<GroupObservation, "id">[] = [];
  let untrackedAnimals = 0;

  for (const members of clusterIndices(individuals, o.groupRadiusM)) {
    if (members.length < o.minGroupSize) {
      untrackedAnimals += members.length;
      continue;
    }
    let lat = 0;
    let lng = 0;
    for (const i of members) {
      lat += individuals[i].lat;
      lng += individuals[i].lng;
    }
    raw.push({
      surveyId: survey.id,
      observedAt: when.iso,
      timeMs: when.ms,
      center: { lat: lat / members.length, lng: lng / members.length },
      size: members.length,
      memberIds: members.map((i) => individuals[i].id).sort((a, b) => a.localeCompare(b)),
      source: "points",
    });
  }

  for (const d of aggregate) {
    if (d.count < o.minGroupSize) {
      untrackedAnimals += d.count;
      continue;
    }
    raw.push({
      surveyId: survey.id,
      observedAt: when.iso,
      timeMs: when.ms,
      center: { lat: d.lat, lng: d.lng },
      size: d.count,
      memberIds: [d.id],
      source: "aggregate",
    });
  }

  /* Stable geographic order makes group ids independent of detector row order. */
  raw.sort((a, b) =>
    a.center.lat - b.center.lat ||
    a.center.lng - b.center.lng ||
    a.size - b.size ||
    a.memberIds.join(",").localeCompare(b.memberIds.join(",")),
  );
  return {
    groups: raw.map((g) => {
      /*
       * Do not use the group's position in the sorted list: inserting an
       * unrelated group would then rename every later observation and break
       * persisted review decisions. Coordinates are rounded only for a stable
       * textual fingerprint; the full-precision centre remains in the output.
       */
      const fingerprint = [
        survey.id,
        g.source,
        g.memberIds.join("\u001f"),
        g.size,
        g.center.lat.toFixed(7),
        g.center.lng.toFixed(7),
      ].join("\u001e");
      return { ...g, id: `${survey.id}:group:${stableHash(fingerprint)}` };
    }),
    untrackedAnimals,
  };
}

type Candidate = {
  trackIndex: number;
  observationIndex: number;
  distanceKm: number;
  gapDays: number;
  sizeChangePct: number;
  score: number;
};

const confidenceRank: Record<MatchConfidence, number> = { high: 0, medium: 1, low: 2 };

function confidenceFor(score: number, ambiguous: boolean): MatchConfidence {
  if (!ambiguous && score <= 0.35) return "high";
  if (!ambiguous && score <= 0.7) return "medium";
  return "low";
}

type MotionSegment = {
  observation: GroupObservation;
  gapDays: number;
  eastKm: number;
  northKm: number;
  distanceKm: number;
  speedKmPerDay: number;
};

function vectorKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const midLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const northKm = (b.lat - a.lat) * (Math.PI / 180) * EARTH_RADIUS_KM;
  const eastKm = (b.lng - a.lng) * (Math.PI / 180) * EARTH_RADIUS_KM * Math.cos(midLat);
  return { eastKm, northKm };
}

function offsetCenter(center: { lat: number; lng: number }, eastKm: number, northKm: number) {
  const lat = center.lat + (northKm / EARTH_RADIUS_KM) * (180 / Math.PI);
  const cos = Math.cos((center.lat * Math.PI) / 180);
  const lng = center.lng + (eastKm / (EARTH_RADIUS_KM * Math.max(1e-9, Math.abs(cos)))) * (180 / Math.PI);
  return { lat, lng };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function segmentsFor(observations: readonly GroupObservation[]): MotionSegment[] {
  const segments: MotionSegment[] = [];
  for (let i = 1; i < observations.length; i++) {
    const previous = observations[i - 1];
    const observation = observations[i];
    const gapDays = (observation.timeMs - previous.timeMs) / DAY_MS;
    if (!(gapDays > 0)) continue;
    const { eastKm, northKm } = vectorKm(previous.center, observation.center);
    const moved = distanceKm(previous.center, observation.center);
    segments.push({
      observation,
      gapDays,
      eastKm,
      northKm,
      distanceKm: moved,
      speedKmPerDay: moved / gapDays,
    });
  }
  return segments;
}

function recentVelocity(
  observations: readonly GroupObservation[],
): { eastKmPerDay: number; northKmPerDay: number; basisObservations: number } | null {
  if (observations.length < 2) return null;
  const lastTime = observations[observations.length - 1].timeMs;
  const recent = observations.filter((o) => lastTime - o.timeMs <= PREDICTION_HISTORY_DAYS * DAY_MS);
  const usable = recent.length >= 2 ? recent : observations.slice(-2);
  const segments = segmentsFor(usable);
  if (segments.length === 0) return null;
  let weightTotal = 0;
  let east = 0;
  let north = 0;
  for (let i = 0; i < segments.length; i++) {
    const weight = i + 1; // newest segment has the strongest influence
    weightTotal += weight;
    east += (segments[i].eastKm / segments[i].gapDays) * weight;
    north += (segments[i].northKm / segments[i].gapDays) * weight;
  }
  return {
    eastKmPerDay: east / weightTotal,
    northKmPerDay: north / weightTotal,
    basisObservations: usable.length,
  };
}

/** Deterministic, inspectable extrapolation; not a behavioural ML forecast. */
export function predictTrack(
  observations: readonly GroupObservation[],
  confidence: MatchConfidence | null = null,
  horizonDays = PREDICTION_HORIZON_DAYS,
): TrackPrediction | undefined {
  const velocity = recentVelocity(observations);
  if (!velocity || !(horizonDays > 0)) return undefined;
  const last = observations[observations.length - 1];
  const east = velocity.eastKmPerDay * horizonDays;
  const north = velocity.northKmPerDay * horizonDays;
  const speedKmPerDay = Math.hypot(velocity.eastKmPerDay, velocity.northKmPerDay);
  const bearingDeg = (Math.atan2(east, north) * (180 / Math.PI) + 360) % 360;
  let predictionConfidence: MatchConfidence = velocity.basisObservations >= 4 ? "high" : velocity.basisObservations >= 3 ? "medium" : "low";
  if (confidence === "low") predictionConfidence = "low";
  if (confidence === "medium" && predictionConfidence === "high") predictionConfidence = "medium";
  return {
    center: offsetCenter(last.center, east, north),
    predictedAt: new Date(last.timeMs + horizonDays * DAY_MS).toISOString(),
    horizonDays,
    bearingDeg,
    distanceKm: Math.hypot(east, north),
    speedKmPerDay,
    confidence: predictionConfidence,
    basisObservations: velocity.basisObservations,
  };
}

function angleDeg(a: MotionSegment, b: MotionSegment): number {
  const denominator = Math.hypot(a.eastKm, a.northKm) * Math.hypot(b.eastKm, b.northKm);
  if (!(denominator > 0)) return 0;
  const cosine = (a.eastKm * b.eastKm + a.northKm * b.northKm) / denominator;
  return Math.acos(Math.max(-1, Math.min(1, cosine))) * (180 / Math.PI);
}

/* A broad bend is movement, not an alarm. Reserve the red sharp-turn state
   for a near-reversal; the previous 120° gate labelled an ordinary curved
   route anomalous even when it never read as turning back on the map. */
const SHARP_TURN_DEG = 150;

function robustUpperThreshold(history: readonly number[], fallback: number): { threshold: number; baseline?: number } {
  if (history.length < 3) return { threshold: fallback };
  const center = median(history);
  const mad = median(history.map((v) => Math.abs(v - center)));
  if (!(mad > 0)) return { threshold: Math.max(fallback, center), baseline: center };
  return {
    threshold: center + (MODIFIED_Z_THRESHOLD * mad) / 0.6745,
    baseline: center,
  };
}

function anomalyFor(
  trackId: string,
  segment: MotionSegment,
  kind: MovementAnomalyKind,
  value: number,
  threshold: number,
  baseline?: number,
): MovementAnomaly {
  return {
    id: `${trackId}:anomaly:${segment.observation.id}:${kind}`,
    kind,
    severity: value >= threshold * 2 ? "critical" : "warning",
    observationId: segment.observation.id,
    surveyId: segment.observation.surveyId,
    observedAt: segment.observation.observedAt,
    value,
    threshold,
    ...(baseline === undefined ? {} : { baseline }),
  };
}

function detectTrackAnomalies(trackId: string, observations: readonly GroupObservation[], options: TrackingOptions): MovementAnomaly[] {
  const segments = segmentsFor(observations);
  const anomalies: MovementAnomaly[] = [];
  let consecutiveFast = 0;
  let consecutiveRouteDeviation = 0;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const earlier = segments.slice(0, i);
    /* 32.6 km/day is the published mean, not an alarm threshold. Until this
       track has its own robust history, use the observed-range gate (60) so a
       perfectly documented 45 km/day transit is not labelled abnormal. */
    const speedBoundary = robustUpperThreshold(earlier.map((s) => s.speedKmPerDay), options.maxSpeedKmPerDay);
    if (segment.speedKmPerDay > speedBoundary.threshold) consecutiveFast++;
    else consecutiveFast = 0;
    if (consecutiveFast >= MIN_CONSECUTIVE_ANOMALOUS_SURVEYS) {
      anomalies.push(anomalyFor(trackId, segment, "speed", segment.speedKmPerDay, speedBoundary.threshold, speedBoundary.baseline));
    }

    const intervalBoundary = robustUpperThreshold(earlier.map((s) => s.gapDays), Math.max(1, options.maxGapDays * 0.75));
    if (segment.gapDays > intervalBoundary.threshold) {
      anomalies.push(anomalyFor(trackId, segment, "unusual_interval", segment.gapDays, intervalBoundary.threshold, intervalBoundary.baseline));
    }

    if (i > 0) {
      const turn = angleDeg(segments[i - 1], segment);
      if (
        turn > SHARP_TURN_DEG &&
        segments[i - 1].distanceKm > options.baseDistanceKm &&
        segment.distanceKm > options.baseDistanceKm
      ) {
        anomalies.push(anomalyFor(trackId, segment, "sharp_turn", turn, SHARP_TURN_DEG));
      }
    }

    if (i >= 1) {
      const priorObservations = observations.slice(0, i + 1);
      const velocity = recentVelocity(priorObservations);
      if (velocity) {
        const previous = observations[i];
        const expected = offsetCenter(
          previous.center,
          velocity.eastKmPerDay * segment.gapDays,
          velocity.northKmPerDay * segment.gapDays,
        );
        const deviation = distanceKm(expected, segment.observation.center);
        const historicalDistance = median(earlier.map((s) => s.distanceKm));
        const deviationThreshold = Math.max(options.baseDistanceKm * 2, historicalDistance * 2, 1);
        if (deviation > deviationThreshold) consecutiveRouteDeviation++;
        else consecutiveRouteDeviation = 0;
        if (
          consecutiveRouteDeviation >= MIN_CONSECUTIVE_ANOMALOUS_SURVEYS ||
          deviation > HARD_GEOLOCATION_OUTLIER_KM
        ) {
          anomalies.push(anomalyFor(trackId, segment, "route_deviation", deviation, deviationThreshold, historicalDistance || undefined));
        }
      }
    }
  }
  return anomalies;
}

function finalizeTrackAnalytics(track: GroupTrack, options: TrackingOptions): void {
  track.prediction = predictTrack(track.observations, track.confidence);
  track.anomalies = detectTrackAnomalies(track.id, track.observations, options);
}

type EventCandidate = {
  type: "split" | "merge";
  previousIndices: number[];
  currentIndices: number[];
  sizeBefore: number;
  sizeAfter: number;
  conservationPct: number;
  maxDistanceKm: number;
  distanceRatio: number;
  score: number;
};

function eventConfidence(candidate: EventCandidate, options: TrackingOptions): MatchConfidence {
  if (candidate.conservationPct <= 15 && candidate.distanceRatio <= 0.35) return "high";
  if (candidate.conservationPct <= options.sizeTolerancePct * 0.75 && candidate.distanceRatio <= 0.7) return "medium";
  return "low";
}

function inferEventsForSurvey(
  surveyId: string,
  occurredAt: string,
  timeMs: number,
  tracks: readonly GroupTrack[],
  previous: readonly GroupObservation[],
  previousTrackCount: number,
  current: readonly GroupObservation[],
  options: TrackingOptions,
): GroupTrackEvent[] {
  if (previousTrackCount === 0 || current.length === 0) return [];
  const currentOwner = current.map((observation) =>
    tracks.findIndex((track) => track.observations.some((o) => o.id === observation.id)),
  );
  const matchedCurrentByPrevious = previous.map((old, index) => {
    const now = tracks[index]?.observations[tracks[index].observations.length - 1];
    return now && now.id !== old.id && now.timeMs === timeMs ? current.findIndex((o) => o.id === now.id) : -1;
  });

  const reachable = (pi: number, ci: number): { distance: number; ratio: number } | null => {
    const gapDays = (timeMs - previous[pi].timeMs) / DAY_MS;
    if (!(gapDays > 0) || gapDays > options.maxGapDays) return null;
    const limit = options.baseDistanceKm + options.maxSpeedKmPerDay * gapDays;
    const distance = distanceKm(previous[pi].center, current[ci].center);
    return distance <= limit ? { distance, ratio: distance / limit } : null;
  };

  const candidates: EventCandidate[] = [];
  for (let pi = 0; pi < previousTrackCount; pi++) {
    for (let a = 0; a < current.length; a++) {
      for (let b = a + 1; b < current.length; b++) {
        const ra = reachable(pi, a);
        const rb = reachable(pi, b);
        if (!ra || !rb) continue;
        /* A regular continuation, if one exists, must be one of the children. */
        if (matchedCurrentByPrevious[pi] >= 0 && matchedCurrentByPrevious[pi] !== a && matchedCurrentByPrevious[pi] !== b) continue;
        /* A child already continued another old track, so it is not available. */
        if (
          (currentOwner[a] < previousTrackCount && currentOwner[a] !== pi) ||
          (currentOwner[b] < previousTrackCount && currentOwner[b] !== pi)
        ) continue;
        const sizeBefore = previous[pi].size;
        const sizeAfter = current[a].size + current[b].size;
        const conservationPct = (Math.abs(sizeAfter - sizeBefore) / sizeBefore) * 100;
        if (conservationPct > options.sizeTolerancePct) continue;
        const distanceRatio = (ra.ratio + rb.ratio) / 2;
        candidates.push({
          type: "split",
          previousIndices: [pi],
          currentIndices: [a, b],
          sizeBefore,
          sizeAfter,
          conservationPct,
          maxDistanceKm: Math.max(ra.distance, rb.distance),
          distanceRatio,
          score: conservationPct / options.sizeTolerancePct + distanceRatio,
        });
      }
    }
  }

  for (let ci = 0; ci < current.length; ci++) {
    for (let a = 0; a < previousTrackCount; a++) {
      for (let b = a + 1; b < previousTrackCount; b++) {
        const ra = reachable(a, ci);
        const rb = reachable(b, ci);
        if (!ra || !rb) continue;
        if (matchedCurrentByPrevious[a] >= 0 && matchedCurrentByPrevious[a] !== ci) continue;
        if (matchedCurrentByPrevious[b] >= 0 && matchedCurrentByPrevious[b] !== ci) continue;
        const owner = currentOwner[ci];
        if (owner < previousTrackCount && owner !== a && owner !== b) continue;
        const sizeBefore = previous[a].size + previous[b].size;
        const sizeAfter = current[ci].size;
        const conservationPct = (Math.abs(sizeAfter - sizeBefore) / sizeBefore) * 100;
        if (conservationPct > options.sizeTolerancePct) continue;
        const distanceRatio = (ra.ratio + rb.ratio) / 2;
        candidates.push({
          type: "merge",
          previousIndices: [a, b],
          currentIndices: [ci],
          sizeBefore,
          sizeAfter,
          conservationPct,
          maxDistanceKm: Math.max(ra.distance, rb.distance),
          distanceRatio,
          score: conservationPct / options.sizeTolerancePct + distanceRatio,
        });
      }
    }
  }

  candidates.sort((a, b) =>
    a.score - b.score ||
    a.type.localeCompare(b.type) ||
    a.previousIndices.join(",").localeCompare(b.previousIndices.join(",")) ||
    a.currentIndices.join(",").localeCompare(b.currentIndices.join(",")),
  );
  const usedPrevious = new Set<number>();
  const usedCurrent = new Set<number>();
  const selected: GroupTrackEvent[] = [];
  for (const candidate of candidates) {
    if (candidate.previousIndices.some((i) => usedPrevious.has(i)) || candidate.currentIndices.some((i) => usedCurrent.has(i))) continue;
    candidate.previousIndices.forEach((i) => usedPrevious.add(i));
    candidate.currentIndices.forEach((i) => usedCurrent.add(i));
    const sourceTrackIds = candidate.previousIndices.map((i) => tracks[i].id);
    const targetTrackIds = [...new Set(candidate.currentIndices.map((i) => tracks[currentOwner[i]].id))];
    const sourceObservationIds = candidate.previousIndices.map((i) => previous[i].id);
    const targetObservationIds = candidate.currentIndices.map((i) => current[i].id);
    selected.push({
      id: `${surveyId}:${candidate.type}:${stableHash([...sourceObservationIds, ...targetObservationIds].join("\u001f"))}`,
      type: candidate.type,
      surveyId,
      occurredAt,
      timeMs,
      sourceTrackIds,
      targetTrackIds,
      sourceObservationIds,
      targetObservationIds,
      sizeBefore: candidate.sizeBefore,
      sizeAfter: candidate.sizeAfter,
      sizeConservationPct: candidate.conservationPct,
      maxDistanceKm: candidate.maxDistanceKm,
      confidence: eventConfidence(candidate, options),
    });
  }
  return selected;
}

/**
 * Track groups through successive surveys. Candidate pairs are globally sorted
 * by their distance/size cost within each survey, then consumed one-to-one.
 * This avoids input-order bias while retaining the user's "nearest similar
 * next group" rule. It is intentionally not a black-box predictive model.
 */
export function trackSealGroups(
  surveys: readonly TrackingSurvey[] | null | undefined,
  options?: Partial<TrackingOptions>,
): TrackingResult {
  const o = normalizedOptions(options);
  const prepared = (surveys ?? [])
    .filter((s) => s && s.status !== "error" && !(s.retiredAt ?? "").trim())
    .map((survey, inputIndex) => ({ survey, inputIndex, when: surveyTime(survey) }))
    .filter((x): x is typeof x & { when: { iso: string; ms: number } } => x.when !== null)
    .sort((a, b) => a.when.ms - b.when.ms || a.inputIndex - b.inputIndex || a.survey.id.localeCompare(b.survey.id));

  const tracks: GroupTrack[] = [];
  const events: GroupTrackEvent[] = [];
  let observations = 0;
  let untrackedAnimals = 0;
  let surveysUsed = 0;

  for (const item of prepared) {
    const snapshot = groupsForSurvey(item.survey, o);
    untrackedAnimals += snapshot.untrackedAnimals;
    const next = snapshot.groups;
    if (next.length === 0) continue;
    surveysUsed++;
    observations += next.length;
    const previousTrackCount = tracks.length;
    const previous = tracks.map((track) => track.observations[track.observations.length - 1]);

    const candidates: Candidate[] = [];
    for (let ti = 0; ti < tracks.length; ti++) {
      const previous = tracks[ti].observations[tracks[ti].observations.length - 1];
      const gapDays = (item.when.ms - previous.timeMs) / DAY_MS;
      if (!(gapDays > 0) || gapDays > o.maxGapDays) continue;
      const maxDistance = o.baseDistanceKm + o.maxSpeedKmPerDay * gapDays;
      for (let oi = 0; oi < next.length; oi++) {
        const current = next[oi];
        const sizeChangePct = (Math.abs(current.size - previous.size) / previous.size) * 100;
        if (sizeChangePct > o.sizeTolerancePct) continue;
        const moved = distanceKm(previous.center, current.center);
        if (moved > maxDistance) continue;
        const distancePart = moved / maxDistance;
        const sizePart = sizeChangePct / o.sizeTolerancePct;
        candidates.push({
          trackIndex: ti,
          observationIndex: oi,
          distanceKm: moved,
          gapDays,
          sizeChangePct,
          score: distancePart * 0.7 + sizePart * 0.3,
        });
      }
    }

    candidates.sort((a, b) =>
      a.score - b.score ||
      a.distanceKm - b.distanceKm ||
      a.sizeChangePct - b.sizeChangePct ||
      tracks[a.trackIndex].id.localeCompare(tracks[b.trackIndex].id) ||
      next[a.observationIndex].id.localeCompare(next[b.observationIndex].id),
    );

    const usedTracks = new Set<number>();
    const usedObservations = new Set<number>();
    for (const chosen of candidates) {
      if (usedTracks.has(chosen.trackIndex) || usedObservations.has(chosen.observationIndex)) continue;
      const alternatives = candidates.some((other) =>
        other !== chosen &&
        other.score <= chosen.score + 0.15 &&
        (other.trackIndex === chosen.trackIndex || other.observationIndex === chosen.observationIndex),
      );
      const confidence = confidenceFor(chosen.score, alternatives);
      const observation = next[chosen.observationIndex];
      observation.match = {
        distanceKm: chosen.distanceKm,
        gapDays: chosen.gapDays,
        speedKmPerDay: chosen.distanceKm / chosen.gapDays,
        sizeChangePct: chosen.sizeChangePct,
        score: chosen.score,
        confidence,
        ambiguous: alternatives,
      };
      const track = tracks[chosen.trackIndex];
      track.observations.push(observation);
      track.totalDistanceKm += chosen.distanceKm;
      track.ambiguous ||= alternatives;
      if (track.confidence === null || confidenceRank[confidence] > confidenceRank[track.confidence]) {
        track.confidence = confidence;
      }
      usedTracks.add(chosen.trackIndex);
      usedObservations.add(chosen.observationIndex);
    }

    for (let oi = 0; oi < next.length; oi++) {
      if (usedObservations.has(oi)) continue;
      const ordinal = tracks.length + 1;
      tracks.push({
        id: `group-track-${ordinal}`,
        ordinal,
        observations: [next[oi]],
        totalDistanceKm: 0,
        confidence: null,
        ambiguous: false,
      });
    }

    events.push(...inferEventsForSurvey(
      item.survey.id,
      item.when.iso,
      item.when.ms,
      tracks,
      previous,
      previousTrackCount,
      next,
      o,
    ));
  }

  tracks.forEach((track) => finalizeTrackAnalytics(track, o));

  return {
    tracks,
    events,
    observations,
    untrackedAnimals,
    surveysUsed,
    surveysSkipped: (surveys ?? []).length - surveysUsed,
    options: o,
  };
}

export type LinkReview = {
  from_observation_id: string;
  to_observation_id: string;
  decision: "confirmed" | "rejected";
};

function recomputeTrackSummary(track: GroupTrack, options: TrackingOptions): void {
  track.totalDistanceKm = 0;
  track.confidence = null;
  track.ambiguous = false;
  for (let i = 1; i < track.observations.length; i++) {
    const observation = track.observations[i];
    track.totalDistanceKm += distanceKm(track.observations[i - 1].center, observation.center);
    if (!observation.match) continue;
    track.ambiguous ||= observation.match.ambiguous;
    if (
      track.confidence === null ||
      confidenceRank[observation.match.confidence] > confidenceRank[track.confidence]
    ) {
      track.confidence = observation.match.confidence;
    }
  }
  finalizeTrackAnalytics(track, options);
}

/**
 * Apply persisted human decisions without mutating the calculated result.
 * A rejected adjacent link cuts a track immediately before `to`; a confirmed
 * link overrides only confidence/ambiguity, never coordinates or counts.
 */
export function applyLinkReviews(
  result: TrackingResult,
  reviews: readonly LinkReview[] | null | undefined,
): TrackingResult {
  const decisionByLink = new Map<string, LinkReview["decision"]>();
  for (const review of reviews ?? []) {
    if (!review?.from_observation_id || !review?.to_observation_id) continue;
    const key = `${review.from_observation_id}\u001f${review.to_observation_id}`;
    const prior = decisionByLink.get(key);
    /* Rejection wins a contradictory duplicate regardless of row order. */
    if (prior !== "rejected") decisionByLink.set(key, review.decision);
  }

  const sourceTracks = result.tracks
    .map((track) => ({
      ...track,
      prediction: track.prediction ? { ...track.prediction, center: { ...track.prediction.center } } : undefined,
      anomalies: track.anomalies?.map((a) => ({ ...a })),
      observations: track.observations.map((observation) => ({
        ...observation,
        center: { ...observation.center },
        memberIds: [...observation.memberIds],
        match: observation.match ? { ...observation.match } : undefined,
      })),
    }))
    .sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id));
  const tracks: GroupTrack[] = [];
  let nextOrdinal = Math.max(0, ...sourceTracks.map((t) => t.ordinal)) + 1;

  for (const source of sourceTracks) {
    let partStart = 0;
    for (let i = 1; i <= source.observations.length; i++) {
      const previous = source.observations[i - 1];
      const current = source.observations[i];
      const key = current ? `${previous.id}\u001f${current.id}` : "";
      const decision = current ? decisionByLink.get(key) : undefined;
      if (decision === "confirmed" && current?.match) {
        current.match.confidence = "high";
        current.match.ambiguous = false;
      }
      if (i < source.observations.length && decision !== "rejected") continue;

      const end = i < source.observations.length ? i : source.observations.length;
      const part = source.observations.slice(partStart, end);
      if (part.length > 0) {
        if (partStart > 0) part[0].match = undefined;
        const splitFrom = source.observations[Math.max(0, partStart - 1)]?.id ?? source.id;
        const splitTo = part[0].id;
        const firstPart = partStart === 0;
        const track: GroupTrack = {
          ...source,
          id: firstPart ? source.id : `${source.id}:review-split:${stableHash(`${splitFrom}\u001f${splitTo}`)}`,
          ordinal: firstPart ? source.ordinal : nextOrdinal++,
          observations: part,
        };
        recomputeTrackSummary(track, result.options);
        tracks.push(track);
      }
      partStart = i;
    }
  }

  const ownerByObservation = new Map<string, string>();
  for (const track of tracks) {
    for (const observation of track.observations) ownerByObservation.set(observation.id, track.id);
  }
  const events = result.events.map((event) => ({
    ...event,
    sourceTrackIds: [...new Set(event.sourceObservationIds.map((id) => ownerByObservation.get(id)).filter((id): id is string => !!id))],
    targetTrackIds: [...new Set(event.targetObservationIds.map((id) => ownerByObservation.get(id)).filter((id): id is string => !!id))],
    sourceObservationIds: [...event.sourceObservationIds],
    targetObservationIds: [...event.targetObservationIds],
  }));

  return {
    ...result,
    tracks,
    events,
    options: { ...result.options },
  };
}
