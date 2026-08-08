"use client";
/* The real counting backend. This module is the whole seam that replaced
   lib/mock/detections.ts on the ingest path: upload the footage, queue a
   count, follow it to completion, hand back the run.

   Same-origin by default because the static export of this app is served by
   the same FastAPI container that owns /v1 - one origin, no CORS, and the
   field/offline story stays intact. NEXT_PUBLIC_API_BASE exists for `next
   dev` on :3000 talking to a backend on :8090 (see next.config rewrites). */

import type { Detection, DetectionPixel } from "./types";

const API = process.env.NEXT_PUBLIC_API_BASE ?? "";

export type CountBand = {
  low: number | null;
  best: number | null;
  high: number | null;
  basis: string;
};

export type MediaOut = {
  id: string;
  filename: string;
  kind: "image" | "video";
  width: number;
  height: number;
  duration_s?: number | null;
  gsd_cm_px?: number | null;
  gsd_source?: string | null;
  track_points?: number | null;
  url?: string;
};

export type RunResult = {
  run_id: string;
  count: CountBand;
  points: Array<{
    id: number;
    x: number;
    y: number;
    lat: number | null;
    lng: number | null;
    score: number | null;
    status: "auto" | "validated" | "false_positive";
    frame_idx?: number | null;
  }>;
  seconds?: number;
  caveats?: string[];
  quality?: Record<string, unknown>;
};

export type JobProgress = { stage?: string; frames_done?: number; frames_total?: number };

/** How many frames a finished run counted on. A still is one look; a video's
 *  quality ledger lists the frames that survived into the consensus. Null when
 *  the run never said — the same answer /v1/stats gives for an archived run,
 *  so a fresh count and a reloaded one derive the same surveyed area. */
export function framesUsed(
  quality: Record<string, unknown> | null | undefined,
  kind?: string | null,
): number | null {
  if (kind === "image") return 1;
  const used = quality?.["frames_used"];
  if (Array.isArray(used)) return used.length;
  if (typeof used === "number" && Number.isFinite(used) && used >= 1) return Math.floor(used);
  return null;
}

/* One row of /v1/stats.latest_runs - the archive hydrate() rebuilds the map
   from. Everything past the run id is optional: rows written before a column
   existed still come back, and a survey missing its frame size is a survey
   with no area, not a survey to drop. */
export type StatsLatestRun = {
  run_id: string;
  created_at?: string | null;
  media_id?: string | null;
  filename?: string | null;
  kind?: "image" | "video" | null;
  low?: number | null;
  best?: number | null;
  high?: number | null;
  basis?: string | null;
  width?: number | null;
  height?: number | null;
  gsd_cm_px?: number | null;
  gsd_source?: string | null;
  caveats?: string[] | null;
  /* Frames the count was assembled from - 1 for a still, the consensus set for
     a video. The surveyed area is a per-FRAME footprint, so without this a
     transect would be reported as the ground under one instant of it. Null =
     the run never said, which makes the area unknown rather than one frame. */
  frames_used?: number | null;
  /* When the footage was FLOWN, off the survey. `created_at` is when the count
     job ran, which for a re-processed archive can be months later - putting a
     2019 sortie on today's timeline. Null on a survey that never recorded it,
     and then `created_at` is the only date there is. */
  captured_at?: string | null;
};

/* The dashboard reads totals/per_site/over_time off the same payload, so the
   index signature stays: this type sharpens the one branch that is mapped into
   Footage without pretending to describe the whole endpoint. */
export type Stats = {
  latest_runs?: StatsLatestRun[];
  /* How many runs exist behind the window `latest_runs` is. The endpoint caps
     the list; without the total, twenty of three hundred sorties render as the
     whole season. Absent on a service too old to report it - then the caller
     knows only that it does not know. */
  latest_runs_total?: number | null;
  [k: string]: any;
};

async function jsonOrThrow(r: Response): Promise<any> {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.detail || d.error || `${r.status} ${r.statusText}`);
  return d;
}

export async function uploadMedia(
  file: File,
  sidecar?: File | null,
  meta?: Record<string, string | number | null | undefined>,
): Promise<MediaOut> {
  const fd = new FormData();
  fd.append("file", file);
  if (sidecar) fd.append("sidecar", sidecar);
  for (const [k, v] of Object.entries(meta ?? {}))
    if (v !== undefined && v !== null && v !== "") fd.append(k, String(v));
  return jsonOrThrow(await fetch(`${API}/v1/media`, { method: "POST", body: fd }));
}

export async function createJob(mediaId: string): Promise<string> {
  const d = await jsonOrThrow(
    await fetch(`${API}/v1/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ media_id: mediaId, params: {} }),
    }),
  );
  return d.job_id;
}

/* A sortie is minutes, not hours. Past this the job is not slow, it is gone -
   a worker that died mid-run leaves the row 'running' forever and the old
   watcher would have polled it until the tab was closed. */
const WATCH_CEILING_MS = 45 * 60 * 1000;

export type WatchOptions = {
  onProgress?: (p: JobProgress) => void;
  /* Abort the watch. The stream closes, the poll timer clears, and the promise
     rejects with an AbortError - nothing keeps calling back into a component
     that has already unmounted. */
  signal?: AbortSignal;
  /* Wall-clock ceiling in ms. Exposed for tests; the default is the real one. */
  timeoutMs?: number;
};

/* Follow a job to its end. SSE first; if the stream drops, fall back to
   polling every 2s rather than spinning forever - the exact failure ladder
   the operator webapp already field-tested: a dead EventSource with no poll
   fallback once meant a spinner that never admitted anything was wrong.

   Second argument accepts the old `onProgress` callback OR an options object,
   so existing callers are untouched while new ones can pass an AbortSignal. */
export function watchJob(
  jobId: string,
  opts?: ((p: JobProgress) => void) | WatchOptions,
): Promise<RunResult> {
  const o: WatchOptions = typeof opts === "function" ? { onProgress: opts } : (opts ?? {});
  const onProgress = o.onProgress;
  const signal = o.signal;
  const ceiling = o.timeoutMs ?? WATCH_CEILING_MS;

  return new Promise((resolve, reject) => {
    let settled = false;
    let es: EventSource | null = null;
    let iv: ReturnType<typeof setInterval> | null = null;
    let ceilingTimer: ReturnType<typeof setTimeout> | null = null;

    /* One teardown for every exit path. The old version closed the stream on
       some branches and the interval on others, and nothing at all when the
       caller walked away - an unmounted Dropzone left an open EventSource and
       a 2s timer running for the life of the tab. */
    const stop = () => {
      try { es?.close(); } catch { /* already closed */ }
      es = null;
      if (iv !== null) { clearInterval(iv); iv = null; }
      if (ceilingTimer !== null) { clearTimeout(ceilingTimer); ceilingTimer = null; }
      signal?.removeEventListener("abort", onAbort);
    };
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      stop();
      fn();
    };
    function onAbort() {
      done(() => reject(new DOMException("the count watch was cancelled", "AbortError")));
    }
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort);
    ceilingTimer = setTimeout(
      () => done(() => reject(new Error("the count stopped reporting"))),
      ceiling,
    );

    const asResult = (result: any): RunResult | null =>
      result && result.count ? (result as RunResult) : null;

    const finish = async () => {
      try {
        const d = await jsonOrThrow(await fetch(`${API}/v1/jobs/${jobId}`));
        if (d.status !== "done") throw new Error(d.error || d.detail || `job ${d.status}`);
        const result = asResult(d.result);
        if (!result) throw new Error("the count finished but returned no number");
        done(() => resolve(result));
      } catch (e) {
        done(() => reject(e));
      }
    };

    const poll = () => {
      if (settled || iv !== null) return;
      let fails = 0;
      iv = setInterval(async () => {
        try {
          const r = await fetch(`${API}/v1/jobs/${jobId}`);
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || d.detail || `job lookup failed (${r.status})`);
          fails = 0;
          if (d.status === "done") {
            finish();
          } else if (d.status === "failed" || d.status === "cancelled") {
            done(() => reject(new Error(d.error || `job ${d.status}`)));
          } else if (d.progress && onProgress) onProgress(d.progress);
        } catch (e) {
          if (++fails >= 5) done(() => reject(e));
        }
      }, 2000);
    };

    try {
      es = new EventSource(`${API}/v1/jobs/${jobId}/events`);
    } catch {
      poll();
      return;
    }
    es.addEventListener("progress", (e: MessageEvent) => {
      try {
        const p = JSON.parse(e.data) || {};
        onProgress?.(p.progress || p);
      } catch {
        /* a malformed progress frame is not worth failing the job over */
      }
    });
    /* The `done` frame already carries the finished run. Refetching it was one
       more round trip for a payload the browser was holding - and one more
       chance to fail after the count had actually succeeded. The GET stays as
       the fallback for a frame that arrives without one. */
    es.addEventListener("done", (e: MessageEvent) => {
      let result: RunResult | null = null;
      try {
        const d = JSON.parse(e.data) || {};
        result = asResult(d.result ?? d);
      } catch {
        /* unreadable frame - ask the service directly */
      }
      if (result) done(() => resolve(result as RunResult));
      else finish();
    });
    es.addEventListener("failed", (e: MessageEvent) => {
      let m = "the count failed";
      try {
        m = (JSON.parse(e.data) || {}).error || m;
      } catch {}
      done(() => reject(new Error(m)));
    });
    es.onerror = () => {
      try { es?.close(); } catch { /* already closed */ }
      es = null;
      poll();
    };
  });
}

/* One backend point -> one map detection. The mock invented a single blob per
   video with a made-up count; the real engine returns every animal it found,
   georeferenced when the footage carried a track. Points without coordinates
   are the caller's problem to aggregate - it knows the sortie's centre.

   Rejected points are KEPT, in both lists. Dropping them here is what made the
   Workbench's "Rejected" filter structurally empty after a reload and left the
   restore button pointing at rows that no longer existed: a reviewer could
   reject an animal, refresh, and never be able to take it back. A rejection is
   evidence, and undo is not optional.

   Nothing downstream counts them - CaspianMap, Dashboard, countOf, the CSV
   export and the Evidence overlay all filter `status !== "false_positive"` -
   so the map, the totals and the marks are unchanged. What changes is that
   `placed.length` is now ROWS, not animals. `unplaced` deliberately stays
   animals: it is added straight into the count, and a rejected point with no
   coordinates is not an animal anyone counted. */
export function pointsToDetections(
  footageId: string,
  points: RunResult["points"],
): { placed: Detection[]; unplaced: number; pixels: DetectionPixel[] } {
  const placed: Detection[] = [];
  const pixels: DetectionPixel[] = [];
  let unplaced = 0;
  for (const p of points) {
    pixels.push({ px: p.x, py: p.y, status: p.status, score: p.score ?? null, id: p.id });
    if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
      placed.push({
        id: `${footageId}-p${p.id}`,
        footageId,
        t: 0,
        lat: p.lat as number,
        lng: p.lng as number,
        count: 1,
        /* null, not 0. "No score recorded" and "the model scored this 0.00"
           are different claims, and only one of them is true here. */
        confidence: p.score ?? null,
        status: p.status,
      });
    } else if (p.status !== "false_positive") {
      unplaced += 1;
    }
  }
  return { placed, unplaced, pixels };
}

/* ---------------------------------------------------------------- history */
/* The store lives in browser memory, but the counts live in the service.
   These three feed hydrate(): the platform reloads yesterday's surveys the
   same way it shows today's, so an F5 no longer wipes the map. */

export type StatsQuery = {
  /* One run per survey. A re-count of the same footage is a correction, not a
     second sortie; asking for both is how one colony gets counted twice. */
  latestPerSurvey?: boolean;
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
};

export async function fetchStats(q: StatsQuery = {}): Promise<Stats> {
  const p = new URLSearchParams();
  if (q.latestPerSurvey) p.set("latest_per_survey", "1");
  if (q.limit != null) p.set("runs_limit", String(q.limit));
  if (q.offset != null) p.set("runs_offset", String(q.offset));
  const qs = p.toString();
  return jsonOrThrow(await fetch(`${API}/v1/stats${qs ? `?${qs}` : ""}`, { signal: q.signal }));
}

/* The columns the platform actually has fields for. `run_id` is the argument,
   `frame_idx` and `support` have no reader here, and a sortie is ~2000 points -
   naming what is needed keeps three unused numbers per animal off the wire on
   every hydrate. An older service ignores the param and sends the full row,
   which parses identically. */
const POINT_FIELDS = "id,x,y,lat,lng,score,status";

export type RunPoints = {
  points: RunResult["points"];
};

/* The response also carries the service's own per-status tally and export
   figure. They are not mapped: this call fetches EVERY point of the run, so
   the client derives both from `detections` exactly, and a second copy on the
   Footage was a parallel source of truth that nothing read. Should a paged
   points fetch ever land, the tallies come back here — as the figures that
   survive the paging. */
export async function fetchRunPoints(
  runId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<RunPoints> {
  const d = await jsonOrThrow(
    await fetch(`${API}/v1/runs/${runId}/points?fields=${POINT_FIELDS}`, { signal: opts.signal }),
  );
  if (Array.isArray(d)) return { points: d };
  return { points: d.points ?? [] };
}

export async function fetchTrack(
  mediaId: string,
): Promise<Array<{ t: number; lat: number; lng: number; alt?: number | null }>> {
  const d = await jsonOrThrow(await fetch(`${API}/v1/media/${mediaId}/track`));
  return (d.points ?? []).filter(
    (p: any) => Number.isFinite(p.lat) && Number.isFinite(p.lng),
  );
}

export const mediaFileUrl = (mediaId: string) => `${API}/media/${mediaId}/file`;

/* No single-point `editPoint`. The batch call below took over every write
   from this client, and the service's one-point body is kept for the operator
   webapp — leaving an unused second write path here is an invitation to
   reintroduce the 400-round-trip pattern the batch endpoint exists to kill.
   `editPoints` with one id is the same request. */

/* One reviewer gesture over many animals, one request, one transaction. Select
   400 rows and mark them rejected and the old path fired 400 PATCHes: 400
   round trips, 400 grabs at SQLite's single writer lock, and no way to know
   whether the gesture had landed as a whole. `updated` is what the service
   actually wrote. */
export async function editPoints(
  runId: string,
  op: "remove" | "reinstate",
  pointIds: number[],
): Promise<number> {
  if (!pointIds.length) return 0;
  const d = await jsonOrThrow(
    await fetch(`${API}/v1/runs/${runId}/points`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, point_ids: pointIds, operator: "platform" }),
    }),
  );
  return typeof d.updated === "number" ? d.updated : pointIds.length;
}
