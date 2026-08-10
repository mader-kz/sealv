/**
 * Immutable knowledge checkpoints and the population snapshot they produced.
 *
 * Checkpoint order uses `ingestedAt`: when this system learned about a
 * survey. Biological movement still uses `capturedAt` inside the tracker. A
 * late upload of old footage therefore changes the ledger today without
 * pretending the animals moved today.
 */
import { caspianRegionFor, type CaspianRegionCounts } from "./caspianRegions";
import { standingContributions } from "./estimate";
import { hasResult } from "./surveys";
import type { Footage } from "../types";

export type PopulationSnapshot = {
  global: number;
  north: number;
  central: number;
  south: number;
  unlocated: number;
  /** The exact latest-per-site sorties behind all five figures. */
  standingFootageIds: string[];
};

export type PopulationCheckpoint = {
  id: string;
  footageId: string;
  filename: string;
  ingestedAt: string;
  observedAt: string;
  timestampSource: "ingested" | "legacy";
  index: number;
  total: number;
  snapshot: PopulationSnapshot;
  delta: Pick<PopulationSnapshot, "global" | "north" | "central" | "south" | "unlocated">;
  /** Prefix of the knowledge ledger, used to reconstruct the map exactly. */
  footageIds: string[];
};

export type CheckpointCadence = "day" | "week";

const finiteTime = (value: string | null | undefined): number => {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

export function checkpointTimeOf(footage: Pick<Footage, "ingestedAt" | "uploadedAt">): {
  iso: string;
  source: "ingested" | "legacy";
} {
  const explicit = (footage.ingestedAt ?? "").trim();
  if (explicit && Number.isFinite(Date.parse(explicit))) {
    return { iso: new Date(Date.parse(explicit)).toISOString(), source: "ingested" };
  }
  const legacy = (footage.uploadedAt ?? "").trim();
  if (legacy && Number.isFinite(Date.parse(legacy))) {
    return { iso: new Date(Date.parse(legacy)).toISOString(), source: "legacy" };
  }
  return { iso: legacy || explicit || "", source: "legacy" };
}

const emptyCounts = (): CaspianRegionCounts => ({
  north: 0,
  central: 0,
  south: 0,
  unlocated: 0,
  global: 0,
});

/**
 * Partition exactly the same standing contributions the global estimate uses.
 * Placed detections carry their own region. A count remainder that has no
 * coordinate remains `unlocated`; it is never assigned to a sortie centroid.
 */
export function populationSnapshot(footages: readonly Footage[]): PopulationSnapshot {
  const counted = footages.filter(
    (footage) => (footage.retiredAt ?? "").trim() === "" && hasResult(footage),
  );
  const contributions = standingContributions(counted);
  const counts = emptyCounts();

  for (const contribution of contributions) {
    const footage = contribution.footage;
    const placed = (footage.detections ?? []).filter((detection) =>
      detection.status !== "false_positive"
      && Number.isFinite(detection.count)
      && detection.count > 0
      && Number.isFinite(detection.lat)
      && Number.isFinite(detection.lng),
    );
    const placedTotal = placed.reduce((sum, detection) => sum + detection.count, 0);

    /* When reviewed points exceed the standing band, their regional split is
       not reconcilable with the number the headline uses. Keep the whole term
       unlocated rather than scaling animals into fractional invented counts. */
    if (placedTotal > contribution.count) {
      counts.unlocated += contribution.count;
      continue;
    }

    if (placed.length > 0) {
      for (const detection of placed) {
        const region = caspianRegionFor(detection);
        if (region) counts[region] += detection.count;
        else counts.unlocated += detection.count;
      }
      counts.unlocated += Math.max(0, contribution.count - placedTotal);
      continue;
    }

    if (contribution.center) {
      const region = caspianRegionFor(contribution.center);
      if (region) counts[region] += contribution.count;
      else counts.unlocated += contribution.count;
    } else {
      counts.unlocated += contribution.count;
    }
  }

  counts.global = counts.north + counts.central + counts.south + counts.unlocated;
  return {
    ...counts,
    standingFootageIds: contributions.map((contribution) => contribution.footage.id),
  };
}

export function buildPopulationCheckpoints(footages: readonly Footage[]): PopulationCheckpoint[] {
  const ordered = footages.map((footage, originalIndex) => ({ footage, originalIndex, clock: checkpointTimeOf(footage) }));
  ordered.sort((a, b) =>
    finiteTime(a.clock.iso) - finiteTime(b.clock.iso)
    || a.originalIndex - b.originalIndex
    || a.footage.id.localeCompare(b.footage.id),
  );

  const prefix: Footage[] = [];
  const checkpoints: PopulationCheckpoint[] = [];
  let previous: PopulationSnapshot | null = null;
  for (let index = 0; index < ordered.length; index++) {
    const { footage, clock } = ordered[index];
    prefix.push(footage);
    const snapshot = populationSnapshot(prefix);
    const delta = {
      global: snapshot.global - (previous?.global ?? 0),
      north: snapshot.north - (previous?.north ?? 0),
      central: snapshot.central - (previous?.central ?? 0),
      south: snapshot.south - (previous?.south ?? 0),
      unlocated: snapshot.unlocated - (previous?.unlocated ?? 0),
    };
    checkpoints.push({
      id: `checkpoint:${footage.id}`,
      footageId: footage.id,
      filename: footage.filename,
      ingestedAt: clock.iso,
      observedAt: (footage.capturedAt ?? "").trim() || footage.uploadedAt,
      timestampSource: clock.source,
      index,
      total: snapshot.global,
      snapshot,
      delta,
      footageIds: prefix.map((item) => item.id),
    });
    previous = snapshot;
  }
  return checkpoints;
}

function bucketStart(iso: string, cadence: CheckpointCadence): number {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  const date = new Date(time);
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  if (cadence === "day") return day;
  const weekday = (new Date(day).getUTCDay() + 6) % 7; // Monday = 0
  return day - weekday * 86_400_000;
}

/** End-of-period state. Uploads are never summed inside a day/week. */
export function bucketCheckpointSeries(
  checkpoints: readonly PopulationCheckpoint[],
  cadence: CheckpointCadence,
): PopulationCheckpoint[] {
  const latest = new Map<number, PopulationCheckpoint>();
  for (const checkpoint of checkpoints) latest.set(bucketStart(checkpoint.ingestedAt, cadence), checkpoint);
  return [...latest.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]);
}
