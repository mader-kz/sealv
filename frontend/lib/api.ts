"use client";
/* The real counting backend. This module is the whole seam that replaced
   lib/mock/detections.ts on the ingest path: upload the footage, queue a
   count, follow it to completion, hand back the run.

   Same-origin by default because the static export of this app is served by
   the same FastAPI container that owns /v1 - one origin, no CORS, and the
   field/offline story stays intact. NEXT_PUBLIC_API_BASE exists for `next
   dev` on :3000 talking to a backend on :8090 (see next.config rewrites). */

import type { Detection } from "./types";

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

/* Follow a job to its end. SSE first; if the stream drops, fall back to
   polling every 2s rather than spinning forever - the exact failure ladder
   the operator webapp already field-tested: a dead EventSource with no poll
   fallback once meant a spinner that never admitted anything was wrong. */
export function watchJob(
  jobId: string,
  onProgress?: (p: JobProgress) => void,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const finish = async () => {
      try {
        const d = await jsonOrThrow(await fetch(`${API}/v1/jobs/${jobId}`));
        if (d.status !== "done") throw new Error(d.error || d.detail || `job ${d.status}`);
        if (!d.result?.count) throw new Error("the count finished but returned no number");
        done(() => resolve(d.result as RunResult));
      } catch (e) {
        done(() => reject(e));
      }
    };

    const poll = () => {
      let fails = 0;
      const iv = setInterval(async () => {
        try {
          const r = await fetch(`${API}/v1/jobs/${jobId}`);
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || d.detail || `job lookup failed (${r.status})`);
          fails = 0;
          if (d.status === "done") {
            clearInterval(iv);
            finish();
          } else if (d.status === "failed" || d.status === "cancelled") {
            clearInterval(iv);
            done(() => reject(new Error(d.error || `job ${d.status}`)));
          } else if (d.progress && onProgress) onProgress(d.progress);
        } catch (e) {
          if (++fails >= 5) {
            clearInterval(iv);
            done(() => reject(e));
          }
        }
      }, 2000);
    };

    let es: EventSource | null = null;
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
    es.addEventListener("done", () => {
      es?.close();
      finish();
    });
    es.addEventListener("failed", (e: MessageEvent) => {
      es?.close();
      let m = "the count failed";
      try {
        m = (JSON.parse(e.data) || {}).error || m;
      } catch {}
      done(() => reject(new Error(m)));
    });
    es.onerror = () => {
      es?.close();
      poll();
    };
  });
}

/* One backend point -> one map detection. The mock invented a single blob per
   video with a made-up count; the real engine returns every animal it found,
   georeferenced when the footage carried a track. Points without coordinates
   are the caller's problem to aggregate - it knows the sortie's centre. */
export function pointsToDetections(
  footageId: string,
  points: RunResult["points"],
): { placed: Detection[]; unplaced: number } {
  const placed: Detection[] = [];
  let unplaced = 0;
  for (const p of points) {
    if (p.status === "false_positive") continue;
    if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
      placed.push({
        id: `${footageId}-p${p.id}`,
        footageId,
        t: 0,
        lat: p.lat as number,
        lng: p.lng as number,
        count: 1,
        confidence: p.score ?? 0,
        status: p.status,
      });
    } else {
      unplaced += 1;
    }
  }
  return { placed, unplaced };
}

/* ---------------------------------------------------------------- history */
/* The store lives in browser memory, but the counts live in the service.
   These three feed hydrate(): the platform reloads yesterday's surveys the
   same way it shows today's, so an F5 no longer wipes the map. */

export async function fetchStats(): Promise<any> {
  return jsonOrThrow(await fetch(`${API}/v1/stats`));
}

export async function fetchRunPoints(runId: string): Promise<RunResult["points"]> {
  const d = await jsonOrThrow(await fetch(`${API}/v1/runs/${runId}/points`));
  return Array.isArray(d) ? d : (d.points ?? []);
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
