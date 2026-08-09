"use client";
/* The real counting backend. This module is the whole seam that replaced
   lib/mock/detections.ts on the ingest path: upload the footage, queue a
   count, follow it to completion, hand back the run.

   Same-origin by default because the static export of this app is served by
   the same FastAPI container that owns /v1 - one origin, no CORS, and the
   field/offline story stays intact. NEXT_PUBLIC_API_BASE exists for `next
   dev` on :3000 talking to a backend on :8090 (see next.config rewrites). */

import type { Detection, DetectionPixel } from "./types";
import { getOperator } from "./identity";

const API = process.env.NEXT_PUBLIC_API_BASE ?? "";

/* The service's own length caps (service/api.py). Mirrored so a note that
   types fine cannot 400 on save — the textarea stops at the same number the
   backend refuses past. A disagreement here is a lost note. */
export const NOTES_MAX = 4000;
export const OPERATOR_MAX = 120;
export const REASON_MAX = 500;
/* The service caps a ground count's `method` with OPERATOR_MAX, not with a cap
   of its own. Named here so a caller cannot mirror the wrong number: an input
   that let 200 characters through against a 120-character column produced a
   400 behind a generic failure toast, which is the exact failure this block of
   constants exists to prevent. */
export const METHOD_MAX = OPERATOR_MAX;

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
  /* SHA-256 of the bytes the service stored. Null on media ingested before the
     digest was recorded — unknown, NOT "this file is new". */
  content_hash?: string | null;
  /* The newest piece of media already in the archive with these exact bytes,
     or null. Reported, never enforced: uploading the same footage twice is
     usually a mistake that would add a whole colony to a season's total, and
     occasionally a deliberate re-count. The service cannot tell those apart,
     so it says what it holds and the operator decides. */
  duplicate_of?: DuplicateMatch | null;
  /* The survey minted for this upload — what a metadata correction, a note or
     a retirement is addressed to. */
  survey_id?: string | null;
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
  /* The survey this run belongs to, and the site that survey sits at. All
     nullable: an unattached upload has no survey, and a survey at an unnamed
     place has no site. `site_lat`/`site_lng` are the SITE's own marker, which
     is not the sortie's position - `survey_lat`/`survey_lng` are that. */
  survey_id?: string | null;
  site_id?: string | null;
  site_name?: string | null;
  site_lat?: number | null;
  site_lng?: number | null;
  survey_lat?: number | null;
  survey_lng?: number | null;
  /* telemetry | pinned | manual | null. Which of those it is decides how much
     the coordinate is worth, so it travels with it. */
  location_source?: string | null;
  /* Field notes and who filed them. */
  notes?: string | null;
  operator?: string | null;
  /* Set on a sortie withdrawn from the estimate. Rows only carry a non-null
     value when the caller asked for `include_retired`, because the default
     archive does not contain them at all. The reason and the person come with
     it: a banner that can say a sortie was withdrawn and nothing about the
     decision is missing the half that makes the withdrawal defensible a season
     later, and the client's own copy of it does not survive a reload. */
  retired_at?: string | null;
  retired_reason?: string | null;
  retired_by?: string | null;
  /* A quick count: the clip this still was cut out of, and the second it was
     taken at. Null for a real photograph. `basis: single_image` already says
     the count came from one image; only these say that image was one second of
     a video somebody chose not to analyse whole — which is a trade (no
     cross-frame band) the report has to be able to state. */
  from_video?: string | null;
  at_seconds?: number | null;
  /* Flight metadata. `altitude_m` is what GSD - and therefore the surveyed
     area - is derived from when no scale was measured. */
  altitude_m?: number | null;
  tide_state?: string | null;
  /* 'manual' for a ground count, otherwise the detector's name. Read this
     before rendering a band: a human count is one number, not a range. */
  engine?: string | null;
  /* How far this run sat from the conditions where false positives were
     actually measured, and the measurements that produced that label. Show
     them together or not at all - "low risk" on its own is the sort of bare
     reassurance this product exists not to give. Null = never recorded. */
  false_positive_risk?: string | null;
  false_positive_basis?: string[] | null;
  /* Set only when the standing count of this survey is a human's CORRECTION of
     an earlier one. Absent everywhere else, which is almost everywhere — so
     `if (row.correction)` reads the same against a service too old to send it.
     `evidence_run` is the run that still holds the animals: this row's own run
     has none (a person typed a number), and fetching points from it would
     empty a sortie whose detections are all still in the archive. */
  correction?: RunCorrection | null;
};

/* What a manual correction replaced, and who replaced it. The engine's run is
   not touched by a correction — it keeps its count, its animals and its edit
   log — so both numbers stay quotable and this is the half that says how the
   standing one came to differ. */
export type RunCorrection = {
  /* The run this one superseded. For a correction of a correction that is the
     previous correction, not the engine run. */
  corrects_run?: string | null;
  /* The run that carries the points and the media — always the engine run,
     however long the chain of corrections above it. */
  evidence_run?: string | null;
  operator?: string | null;
  reason?: string | null;
  previous?: {
    low?: number | null;
    best?: number | null;
    high?: number | null;
    basis?: string | null;
    engine?: string | null;
    run_id?: string | null;
  } | null;
  /* What produced the ANIMALS, read off `evidence_run` rather than off the run
     this correction replaced. The two differ the moment a correction is itself
     corrected: `previous` is then a manual run, and a reader taking the engine
     from it calls a drone sortie a ground count. Optional — a service too old
     to send it leaves callers on the `previous` fallback, which is right for
     the single-correction case they were built for. */
  evidence?: {
    run_id?: string | null;
    engine?: string | null;
    basis?: string | null;
  } | null;
};

/* The wire types above keep `location_source` as a plain string on purpose: a
   service that grows a fourth value must not make this client crash or, worse,
   silently render it as whichever branch happened to be the `else`. This is the
   one place that narrows it, and anything it does not recognise becomes null -
   "we do not know how this position was arrived at", which is true, rather than
   a guess dressed as a provenance label. */
export type LocationSource = "telemetry" | "pinned" | "manual";
const LOCATION_SOURCES: readonly string[] = ["telemetry", "pinned", "manual"];

export function locationSourceOf(v: string | null | undefined): LocationSource | null {
  return v && LOCATION_SOURCES.includes(v) ? (v as LocationSource) : null;
}

/* Media already in the archive with the same bytes, plus whatever count came
   out of it last. Enough to render "you already counted this: 300 on 6 Aug"
   without a second round trip. */
export type DuplicateMatch = {
  media_id: string;
  survey_id: string | null;
  filename: string | null;
  kind: string | null;
  created_at: string;
  run_id: string | null;
  low: number | null;
  best: number | null;
  high: number | null;
  basis: string | null;
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

export type UploadProgress = { loaded: number; total: number };

export type UploadOptions = {
  sidecar?: File | null;
  meta?: Record<string, string | number | null | undefined>;
  /* Bytes on the wire, not a spinner. A sortie is gigabytes over a boat's
     hotspot, and "uploading…" for four minutes is indistinguishable from
     "hung". `total` is 0 when the browser cannot compute the length. */
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
};

/* XMLHttpRequest, deliberately, in a file where everything else is `fetch`.
   `fetch` has no upload-progress event — the request-stream API that would
   give one is not available for a FormData body in any shipping browser — and
   XHR has had `upload.onprogress` for fifteen years. The choice here is
   between an honest byte counter and a prettier call site.

   Back-compat: the old positional form `uploadMedia(file, sidecarFile, meta)`
   still works, so no existing caller has to change to get the new one. */
export async function uploadMedia(
  file: File,
  opts?: UploadOptions | File | null,
  meta?: Record<string, string | number | null | undefined>,
): Promise<MediaOut> {
  const isFileArg =
    opts instanceof Blob || (typeof File !== "undefined" && opts instanceof File);
  const o: UploadOptions = isFileArg
    ? { sidecar: opts as File, meta }
    : ((opts as UploadOptions | null | undefined) ?? { meta });

  const fd = new FormData();
  fd.append("file", file);
  if (o.sidecar) fd.append("sidecar", o.sidecar);
  for (const [k, v] of Object.entries(o.meta ?? {}))
    if (v !== undefined && v !== null && v !== "") fd.append(k, String(v));

  return new Promise<MediaOut>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();

    /* One teardown for every exit. An upload that is abandoned must not leave
       a listener holding the AbortSignal - and therefore this closure, and
       therefore the file - alive for the life of the tab. */
    const done = (fn: () => void) => {
      o.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    if (o.signal?.aborted) {
      return reject(new DOMException("the upload was cancelled", "AbortError"));
    }
    o.signal?.addEventListener("abort", onAbort);

    if (o.onProgress) {
      xhr.upload.onprogress = (e) =>
        o.onProgress?.({ loaded: e.loaded, total: e.lengthComputable ? e.total : 0 });
    }
    xhr.onload = () => {
      let body: any = {};
      try {
        body = JSON.parse(xhr.responseText || "{}");
      } catch {
        /* a proxy's HTML error page, most likely - fall through to the status */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        /* The bytes are up and the row is written. Reporting progress as
           complete matters when the server took a while to probe the file:
           without it the bar sits at 99% through the whole probe. */
        o.onProgress?.({ loaded: file.size, total: file.size });
        done(() => resolve(body as MediaOut));
      } else {
        done(() =>
          reject(new Error(body.error || body.detail || `${xhr.status} ${xhr.statusText}`)),
        );
      }
    };
    xhr.onerror = () =>
      done(() => reject(new Error("the upload could not reach the counting service")));
    xhr.ontimeout = () => done(() => reject(new Error("the upload timed out")));
    xhr.onabort = () =>
      done(() => reject(new DOMException("the upload was cancelled", "AbortError")));

    xhr.open("POST", `${API}/v1/media`);
    xhr.send(fd);
  });
}

/* The largest file this will read into memory to hash. `crypto.subtle` has no
   streaming digest, so hashing is one `arrayBuffer()` - fine for a still,
   reckless for a 4GB transect on a field laptop. Past this, the pre-check is
   skipped and the caller falls back to `duplicate_of` on the response, which
   the service computed from the bytes it streamed to disk anyway. */
const HASH_MAX_BYTES = 512 * 1024 * 1024;

/** SHA-256 hex, or null where crypto.subtle is unavailable (plain-http LAN).
 *  Null is not a failure — it means the pre-check cannot run and the caller
 *  must fall back to MediaOut.duplicate_of after the upload. */
export async function hashFile(file: File): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || file.size > HASH_MAX_BYTES) return null;
  try {
    const digest = await subtle.digest("SHA-256", await file.arrayBuffer());
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    /* Out of memory on a big file, or a hardened context. Either way the
       answer is the same: this browser cannot pre-check, and saying so beats
       reporting a file as new because the hash threw. */
    return null;
  }
}

/** Everything the archive already holds with these exact bytes, newest first. */
export async function findByHash(sha256: string): Promise<DuplicateMatch[]> {
  const d = await jsonOrThrow(await fetch(`${API}/v1/media/by-hash/${sha256}`));
  return d.matches ?? [];
}

/* The `survey` block travels with the job because gsd_cm_px picks the tile
   size and the tile size decides the count: sending it after the fact would
   be a correction to a number already computed at a different scale. */
export async function createJob(mediaId: string, survey?: SurveyPatch): Promise<string> {
  const body: Record<string, unknown> = { media_id: mediaId, params: {} };
  if (survey && Object.keys(survey).length) body.survey = survey;
  const d = await jsonOrThrow(
    await fetch(`${API}/v1/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return d.job_id;
}

export type JobRow = {
  job_id: string;
  media_id: string | null;
  filename: string | null;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  /* The operator-facing half of a failure. The full traceback stays in the
     service; a field operator cannot act on a stack. */
  error: string | null;
  attempts: number;
  created_at: string;
  finished_at: string | null;
};

export async function fetchJobs(q: { status?: string; limit?: number } = {}): Promise<JobRow[]> {
  const p = new URLSearchParams();
  if (q.status) p.set("status", q.status);
  if (q.limit != null) p.set("limit", String(q.limit));
  const qs = p.toString();
  const d = await jsonOrThrow(await fetch(`${API}/v1/jobs${qs ? `?${qs}` : ""}`));
  return d.jobs ?? [];
}

/** Drop a job that has not started. Throws on a running one (409): it is
 *  inside a worker process the service cannot interrupt, and pretending
 *  otherwise would leave a count running behind a cancelled row. */
export async function cancelJob(jobId: string): Promise<void> {
  await jsonOrThrow(await fetch(`${API}/v1/jobs/${jobId}/cancel`, { method: "POST" }));
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
  /* Include sorties withdrawn from the estimate. The archive listing excludes
     them by default, and hydrating without this made retirement irreversible
     from the UI: after a reload the row was simply absent, so the "show
     retired" toggle never appeared, the Undo button was unreachable, and the
     unretire endpoint could only ever be called in the same tab that had
     retired the sortie. The retire form promises the sortie "stays in the
     archive"; this is what makes that true past an F5. */
  includeRetired?: boolean;
  signal?: AbortSignal;
};

export async function fetchStats(q: StatsQuery = {}): Promise<Stats> {
  const p = new URLSearchParams();
  if (q.latestPerSurvey) p.set("latest_per_survey", "1");
  if (q.limit != null) p.set("runs_limit", String(q.limit));
  if (q.offset != null) p.set("runs_offset", String(q.offset));
  if (q.includeRetired) p.set("include_retired", "1");
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

/* A sampled video frame, by the name the run's quality ledger recorded for it.
   Frames live per job (a re-run must not swap the evidence under a finished
   run); runs from before that layout kept theirs flat, and the service tries
   both — so a missing jobId is a valid address, not a broken one. */
export const mediaFrameUrl = (mediaId: string, name: string, jobId?: string | null) =>
  jobId
    ? `${API}/media/${mediaId}/frames/${jobId}/${name}`
    : `${API}/media/${mediaId}/frames/${name}`;

/* GET /v1/runs/{id}: the job route's `result` block plus media_id/job_id.
   Only the fields the replay actually reads are typed; the quality ledger
   stays a bag because its keys are the service's to define. */
export type RunDetail = {
  run_id: string;
  media_id?: string | null;
  job_id?: string | null;
  count?: CountBand;
  quality?: {
    reference_frame?: number | null;
    width?: number | null;
    height?: number | null;
    frames?: Array<{ index: number; t?: number | null; file?: string | null }>;
  } & Record<string, unknown>;
};

export async function fetchRun(
  runId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<RunDetail> {
  return jsonOrThrow(await fetch(`${API}/v1/runs/${runId}`, { signal: opts.signal }));
}

/* ------------------------------------------------- surveys, sites, counts */

/* One survey row, verbatim. Everything but `id` and `created_at` is nullable,
   and every null is a real state: no site chosen, no date recorded, no scale
   measured, not retired. None of them may be rendered as a zero or a guess. */
export type SurveyOut = {
  id: string;
  site_id: string | null;
  captured_at: string | null;
  altitude_m: number | null;
  gsd_cm_px: number | null;
  gsd_source: string | null;
  tide_state: string | null;
  sea_ice_pct: number | null;
  operator: string | null;
  notes: string | null;
  lat: number | null;
  lng: number | null;
  location_source: string | null;
  retired_at: string | null;
  retired_reason: string | null;
  retired_by: string | null;
  created_at: string;
};

/* What a correction may touch. Retirement is absent on purpose - withdrawing a
   sortie needs a reason and has its own call. Patching `altitude_m` alone
   re-derives the scale server-side, so the surveyed AREA moves and the count
   does not; send `gsd_cm_px` too when the scale was actually measured. */
export type SurveyPatch = {
  site_id?: string | null;
  captured_at?: string | null;
  altitude_m?: number | null;
  gsd_cm_px?: number | null;
  tide_state?: string | null;
  sea_ice_pct?: number | null;
  operator?: string | null;
  notes?: string | null;
  lat?: number | null;
  lng?: number | null;
  location_source?: "telemetry" | "pinned" | "manual" | null;
};

export async function fetchSurvey(id: string): Promise<SurveyOut> {
  return jsonOrThrow(await fetch(`${API}/v1/surveys/${id}`));
}

export async function patchSurvey(id: string, patch: SurveyPatch): Promise<SurveyOut> {
  return jsonOrThrow(
    await fetch(`${API}/v1/surveys/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
}

/** Withdraw a sortie from the estimate. Nothing is deleted - every point and
 *  every edit stays - and the reason is required, because a number that
 *  silently left a season's total is as bad as one that silently joined it. */
export async function retireSurvey(
  id: string,
  reason: string,
  by?: string | null,
): Promise<SurveyOut> {
  /* An explicit null is honoured: the caller is recording that nobody said who
     they were, and substituting the stored name would put a name on an act
     they did not claim. Omitting the argument entirely means "whoever is at the
     keyboard", which is the same rule editPoints follows. */
  const who = by === undefined ? getOperator() : by;
  return jsonOrThrow(
    await fetch(`${API}/v1/surveys/${id}/retire`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason, by: who }),
    }),
  );
}

export async function unretireSurvey(id: string): Promise<SurveyOut> {
  return jsonOrThrow(await fetch(`${API}/v1/surveys/${id}/unretire`, { method: "POST" }));
}

/* ------------------------------------------------- counts of one sortie */

/* One line of a sortie's count history. The engine's run and every human
   correction above it, in one list, newest first — `standing` marks the one
   the whole product is currently reporting. */
export type SurveyCount = {
  run_id: string;
  engine: string | null;
  basis: string | null;
  low: number | null;
  best: number | null;
  high: number | null;
  created_at: string | null;
  media_id: string | null;
  /* The count that currently represents this survey. Derived server-side from
     the ordering, never stored — so this list and the archive listing cannot
     disagree about which number is the one being published. */
  standing: boolean;
  correction: boolean;
  corrects_run: string | null;
  evidence_run: string | null;
  /* Who entered this number and why. Null on an engine run: nobody signed it
     and it needs no reason. */
  operator: string | null;
  reason: string | null;
  /* How a ground count was arrived at (binoculars, boat transect…). */
  method: string | null;
  previous: RunCorrection["previous"];
};

export async function fetchSurveyCounts(id: string): Promise<SurveyCount[]> {
  const d = await jsonOrThrow(await fetch(`${API}/v1/surveys/${id}/counts`));
  return Array.isArray(d.counts) ? d.counts : [];
}

export type CorrectionOut = {
  run: {
    id: string;
    engine: string;
    basis: string;
    count_low: number;
    count_best: number;
    count_high: number;
    media_id: string | null;
    created_at: string;
    quality?: Record<string, unknown> | null;
  };
  supersedes: { id: string; count_best: number | null; basis: string | null } | null;
  counts: SurveyCount[];
};

/** Correct the standing count of a sortie that already exists.
 *
 *  Not an edit of the number: the service records a new run with basis
 *  'manual' against the same survey, latest-per-survey makes it the standing
 *  figure, and the engine's run keeps everything it had. Both numbers stay in
 *  `counts`, which is what lets a corrected figure be defended later.
 *
 *  Validated here against the service's own limits so a value that types fine
 *  cannot come back as a 400 behind a generic toast: whole and non-negative
 *  (`_whole` on the service refuses a fraction rather than rounding it — a
 *  count is the one number that must never be silently adjusted), and the two
 *  free-text fields cut at the columns' caps. */
export async function correctCount(
  surveyId: string,
  count: number,
  reason?: string | null,
  operator?: string | null,
): Promise<CorrectionOut> {
  if (!Number.isFinite(count) || !Number.isInteger(count) || count < 0) {
    throw new Error(`corrected count must be a whole number >= 0, got ${count}`);
  }
  const why = typeof reason === "string" ? reason.trim().slice(0, REASON_MAX) : null;
  /* Same rule as retireSurvey and editPoints: an explicit null records that
     nobody said who they were, and omitting the argument means "whoever is at
     the keyboard". Substituting a stored name over an explicit null would put
     a name on a correction that person did not claim. */
  const who = operator === undefined ? getOperator() : operator;
  return jsonOrThrow(
    await fetch(`${API}/v1/surveys/${surveyId}/counts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        count,
        reason: why || null,
        operator: who ? String(who).slice(0, OPERATOR_MAX) : null,
      }),
    }),
  );
}

/* ------------------------------------------------------------ hard delete */

/* Exactly what a purge destroys — or would destroy, from the preview. The
   counts come from the same function that does the deleting, so a confirmation
   dialog states real numbers rather than the client's guess at them.
   `files` is a COUNT: the service withholds workspace paths. */
export type PurgeReceipt = {
  survey_id: string;
  retired: boolean;
  retired_at: string | null;
  retired_reason: string | null;
  counts: {
    media: number;
    jobs: number;
    runs: number;
    points: number;
    edits: number;
    track_points: number;
  };
  filenames: string[];
  files: number;
  dry_run: boolean;
  /* Preview only: whether the retire step has been taken yet. */
  deletable?: boolean;
  /* Delete only: what actually went from disk, and what would not go. */
  files_removed?: number;
  files_failed?: number;
};

/** What `purgeSurvey` would destroy, without destroying it. Answers on a
 *  sortie that is still in the estimate too, with `deletable: false` — that is
 *  how the UI learns the retire step is still owed while it can still say what
 *  is at stake. */
export async function fetchPurgePreview(id: string): Promise<PurgeReceipt> {
  return jsonOrThrow(await fetch(`${API}/v1/surveys/${id}/purge`));
}

/** Destroy a retired sortie: its survey row, its runs, every animal, the edit
 *  log, the media rows and the footage on disk. There is no undo and no
 *  archive copy — this is the one call in this client that ends evidence.
 *
 *  Refused with 409 on a sortie that has not been retired first. That gate is
 *  the product decision, not a technicality: retirement is reversible and
 *  takes a reason, so a season cannot be destroyed by one click, while test
 *  junk can still be removed completely. */
export async function purgeSurvey(id: string): Promise<PurgeReceipt> {
  return jsonOrThrow(await fetch(`${API}/v1/surveys/${id}`, { method: "DELETE" }));
}

export type SiteOut = {
  id: string;
  name: string;
  region: string | null;
  lat: number | null;
  lng: number | null;
  created_at: string;
};

export async function fetchSites(): Promise<SiteOut[]> {
  const d = await jsonOrThrow(await fetch(`${API}/v1/sites`));
  return d.sites ?? [];
}

export async function createSite(b: {
  name: string;
  lat?: number | null;
  lng?: number | null;
  region?: string | null;
}): Promise<SiteOut> {
  return jsonOrThrow(
    await fetch(`${API}/v1/sites`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(b),
    }),
  );
}

/** Name a colony once; the name follows it into repeat surveys, the dynamics
 *  chart, the PDF and every export. */
export async function renameSite(id: string, name: string): Promise<SiteOut> {
  return jsonOrThrow(
    await fetch(`${API}/v1/sites/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  );
}

/* A ground count. `method` is free text (binoculars, boat transect…) and
   nothing branches on it - it is there so the record says how the number was
   arrived at. */
export type ObservationIn = {
  count: number;
  captured_at: string;
  lat?: number | null;
  lng?: number | null;
  site_id?: string | null;
  operator?: string | null;
  notes?: string | null;
  method?: string | null;
};

/* The run comes back with low = best = high and basis 'manual'. That is not a
   band of width zero: it is a human's count, and every surface that would
   normally draw whiskers has to read `basis` and label it instead. */
export type ObservationOut = {
  survey: SurveyOut;
  run: {
    id: string;
    engine: string;
    basis: string;
    count_low: number;
    count_best: number;
    count_high: number;
    created_at: string;
  };
};

export async function createObservation(b: ObservationIn): Promise<ObservationOut> {
  return jsonOrThrow(
    await fetch(`${API}/v1/observations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      /* Spread first, then the operator: `{operator: X, ...b}` would let an
         explicitly-undefined `b.operator` overwrite the default back out. */
      body: JSON.stringify({ ...b, operator: b.operator ?? getOperator() }),
    }),
  );
}

/* One line of a run's correction log: who ruled on which detection, and when.
   This is the record that lets a published figure be defended a year later. */
export type EditRow = {
  id: number;
  run_id: string;
  op: string;
  point_id: number | null;
  operator: string | null;
  created_at: string;
};

export async function fetchEdits(runId: string, limit?: number): Promise<EditRow[]> {
  const qs = limit != null ? `?limit=${limit}` : "";
  const d = await jsonOrThrow(await fetch(`${API}/v1/runs/${runId}/edits${qs}`));
  return d.edits ?? [];
}

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
/* `operator` defaults to whoever said they were at the keyboard (lib/identity)
   and is NULL when nobody has. The hardcoded "platform" this used to send is
   gone: every verdict in the archive was signed with a word that identifies no
   one while looking exactly like a name, which is worse than an unsigned
   record - "43 detections were rejected by platform" cannot be checked with
   anybody, and it hid the fact that nothing here knows who is reviewing. */
export async function editPoints(
  runId: string,
  op: "remove" | "reinstate",
  pointIds: number[],
  operator?: string | null,
): Promise<number> {
  if (!pointIds.length) return 0;
  const who = operator === undefined ? getOperator() : operator;
  const d = await jsonOrThrow(
    await fetch(`${API}/v1/runs/${runId}/points`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, point_ids: pointIds, operator: who }),
    }),
  );
  return typeof d.updated === "number" ? d.updated : pointIds.length;
}
