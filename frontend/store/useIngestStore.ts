"use client";
/**
 * useIngestStore — the write path into the platform, as state rather than as a
 * component's local variables.
 *
 * Everything about a dropped file lives here: the File itself, what phase it is
 * in, how many bytes are on the wire, which duplicate it collided with, which
 * anchor belongs to it. The Ingest panel is a VIEW over this store and nothing
 * more, which is the point — closing the panel mid-count used to throw the log
 * away, and the operator was left with a spinner-less map and no way to find
 * out what had happened to twelve files.
 *
 * Three rules the old ingest broke, written down because each one lost data:
 *
 *  1. ONE upload and ONE job watch in flight. The origin is HTTP/1.1 with a
 *     six-socket cap; six concurrent EventSources starve every other request
 *     in the app for the minutes a photo takes. Everything else waits in
 *     `queued` and says so.
 *  2. EVERY terminal path calls `runNext()`. A failure that forgets to is a
 *     queue that never moves again, which is worse than the failure.
 *  3. An anchor belongs to a NAMED item. A single `pendingVideo` slot meant
 *     three GPS-less photos dropped together produced one row and two silently
 *     discarded files — and the next photo inherited a coordinate from a file
 *     it had no relationship to.
 */

import { create } from "zustand";
import { toast } from "sonner";
import {
  uploadMedia,
  createJob,
  watchJob,
  cancelJob,
  fetchJobs,
  hashFile,
  findByHash,
  pointsToDetections,
  framesUsed,
  NOTES_MAX,
  type DuplicateMatch,
  type JobRow,
  type LocationSource,
  type MediaOut,
  type SurveyPatch,
} from "@/lib/api";
import { parseSRT, validateTrackInCaspian } from "@/lib/parsers/srt";
import { parseJSONSidecar, trackToJSON, capturedAtOf } from "@/lib/parsers/json";
import { parseMP4Metadata } from "@/lib/parsers/mp4";
import { sortieAreaM2 } from "@/lib/analytics/area";
import { isWater } from "@/lib/caspian";
import { useFootageStore } from "@/store/useFootageStore";
import { getOperator } from "@/lib/identity";
import { translate, plural, useLangStore, type I18nKey } from "@/lib/i18n";
import type { Footage, TrackPoint } from "@/lib/types";
import {
  extractFrames,
  exportFrame,
  frameFileName,
  trackAt,
  type ExtractedFrame,
  type FrameErrorCode,
} from "@/lib/media/frames";

/* Serializes client-side frame extraction across the whole queue: every video
   of a drop goes through the picker, and this chain is what keeps a 12-clip
   drop from opening 12 <video> decoders at once. See wantFrames. */
let extractChain: Promise<void> = Promise.resolve();

/* ------------------------------------------------------------------ types */

export type IngestPhase =
  | "queued"
  /** Reading the file's own metadata — telemetry, duration, sidecar. */
  | "reading"
  | "hashing"
  | "duplicate_choice"
  /** The operator is choosing WHICH frame of a clip gets counted. */
  | "frame_choice"
  | "needs_location"
  | "uploading"
  | "enqueued"
  | "counting"
  | "writing"
  | "done"
  | "failed"
  | "cancelled"
  | "skipped";

/** Phases that are waiting on a person, not on a machine. The worker steps
 *  over them; they are not failures and they are not progress. */
const WAITING: IngestPhase[] = ["duplicate_choice", "frame_choice", "needs_location"];
/** Nothing more will happen to these on its own. */
const TERMINAL: IngestPhase[] = ["done", "failed", "cancelled", "skipped"];

export const isWaiting = (p: IngestPhase) => WAITING.includes(p);
export const isTerminal = (p: IngestPhase) => TERMINAL.includes(p);
export const isRunning = (p: IngestPhase) => !isWaiting(p) && !isTerminal(p) && p !== "queued";

export type IngestKind = "video" | "image" | "sidecar" | "other";

/** Why a file was skipped or a count failed — as a dictionary key plus its
 *  variables, never as a finished sentence. A row lives for the length of a
 *  session and the operator may switch language inside one; a reason baked
 *  into English at the moment of failure would still be English an hour later,
 *  in an otherwise Kazakh panel. `detail` is the exception: the service's own
 *  words are not ours to translate. */
export type IngestReason = { key: I18nKey; vars?: Record<string, string | number> };

/** The survey block the operator typed. `SurveyPatch` is the service's own
 *  correction shape and every field in it is a valid /v1/media form field, so
 *  one type covers "typed at ingest" and "corrected afterwards" — the two
 *  cannot drift apart into two ideas of what a survey is. `survey_id` is the
 *  one addition: it is not a correction, it is which existing survey a
 *  re-count belongs to. */
/* `from_video`/`at_seconds` are upload-only: they describe how the media was
   PRODUCED, which a later correction cannot change, so they are not part of
   SurveyPatch. */
export type IngestMeta = SurveyPatch & {
  survey_id?: string;
  from_video?: string;
  at_seconds?: number;
};

export type AnchorSource = "pinned" | "typed" | "telemetry";

export type IngestItem = {
  id: string;
  file: File;
  fileName: string;
  bytes: number;
  lastModified: number;
  kind: IngestKind;
  phase: IngestPhase;
  bytesSent: number;
  bytesTotal: number;
  frameDone: number | null;
  frameTotal: number | null;
  /** Stage word from the engine, so `counting` can say what it is counting. */
  stage?: string | null;
  sidecar: File | null;
  footageId?: string;
  mediaId?: string;
  jobId?: string;
  duplicateOf?: DuplicateMatch | null;
  /** The collision was only visible in the upload RESPONSE — the browser could
   *  not hash the file locally, so nothing was checked before the bytes went
   *  up. The row has to say that rather than imply a pre-flight check ran. */
  duplicateAfterUpload?: boolean;
  /** The operator has answered the duplicate question for this item. */
  duplicateAck?: boolean;
  anchor?: { lat: number; lng: number } | null;
  anchorSource?: AnchorSource;
  /** Map zoom the anchor was clicked at. A pin at basin zoom cannot support
   *  four decimals, and the survey's note says which zoom it was placed at. */
  anchorZoom?: number | null;
  reason?: IngestReason;
  detail?: string;
  meta?: IngestMeta;
  /** What ingest learned about this file's geography, in one line. */
  note?: string;
  frames?: ExtractedFrame[];
  frameError?: FrameErrorCode | null;
  framesBusy?: boolean;
  frameSpread?: { duration: number; evenlySpaced: boolean };
  /** How far the aircraft travelled between the first and last fix of this
   *  clip's own track, in metres. `undefined` = not looked at yet; `null` =
   *  looked, and the clip carries no track. Null stays null: a clip with no
   *  telemetry supports no claim about whether it moved, and the picker says
   *  nothing rather than guessing either way. */
  frameMoveM?: number | null;
  quickCount?: { fromVideo: string; atSeconds: number };
  /** What the service measured about the file once it had it. Held on the row
   *  because the surveyed area is derived from it AFTER the count returns, and
   *  the upload response is the only place it is ever stated. */
  uploadInfo?: {
    width: number;
    height: number;
    gsd: number | null;
    gsdSource: string | null;
    kind: string | null;
  };
  result?: { best: number | null; low: number | null; high: number | null; unplaced: number };
  startedAt: number;
};

/** A failed job as this panel tracks it: the service's own row plus whether a
 *  retry is in flight. These outlive the tab — a job-stage failure writes no
 *  run row, so hydrate() cannot rebuild it, and the failure used to vanish on
 *  F5 with no trace reachable from any screen. */
export type FailedJob = JobRow & { state: "failed" | "retrying"; stage?: string | null };

/** What the Dropzone hands over: one prepared row per file it saw. */
export type NewIngest = {
  file: File;
  sidecar?: File | null;
  kind: IngestKind;
  phase?: IngestPhase;
  reason?: IngestReason;
};

/* ----------------------------------------------------------------- helpers */

const genId = () => Math.random().toString(36).slice(2, 9);
const lang = () => useLangStore.getState().lang;
const T = (key: I18nKey, vars?: Record<string, string | number>) => translate(lang(), key, vars);
const TP = (n: number, key: I18nKey) => plural(lang(), n, key);
const messageOf = (e: unknown) => {
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return m.trim() || T("ingest.unknownError");
};
const isAbort = (e: unknown) =>
  e instanceof DOMException ? e.name === "AbortError" : /abort/i.test(String((e as any)?.name ?? ""));

/** Notes are operator text that ends up in a PDF and a CSV. Cap the length and
 *  strip control characters; nothing renders it as HTML anywhere. */
/** The service's own cap on `survey.notes`, so a note that types fine here
 *  cannot 400 on save. */
export const NOTE_MAX = NOTES_MAX;
export const cleanNote = (s: string): string =>
  s.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, NOTE_MAX);

/** A hand-placed coordinate, at the precision the gesture supports. Three
 *  decimals is ~110 m; four is ~11 m, which one click at basin zoom cannot
 *  claim and which the exports would nonetheless print. */
export const roundPin = (v: number) => Math.round(v * 1000) / 1000;

export const MEDIA_RE = /\.(mp4|mov|avi|mkv|webm|jpe?g|png|tiff?|webp)$/i;
export const VIDEO_RE = /\.(mp4|mov|avi|mkv|webm)$/i;
export const IMAGE_RE = /\.(jpe?g|png|tiff?|webp)$/i;
export const SIDECAR_RE = /\.(srt|json)$/i;

export function kindOf(name: string): IngestKind {
  if (VIDEO_RE.test(name)) return "video";
  if (IMAGE_RE.test(name)) return "image";
  if (SIDECAR_RE.test(name)) return "sidecar";
  return "other";
}

/** Read the real playback duration. Null when the browser cannot decode it. */
function readVideoDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    if (file.size === 0) return resolve(null);
    const url = URL.createObjectURL(file);
    const el = document.createElement("video");
    const done = (v: number | null) => {
      URL.revokeObjectURL(url);
      resolve(v);
    };
    const timer = setTimeout(() => done(null), 5000);
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      clearTimeout(timer);
      done(Number.isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration) : null);
    };
    el.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
    el.src = url;
  });
}

/** The engine's caveats and the ones ingest already recorded are one list.
 *  `undefined` still means "nobody reported anything"; `[]` is the positive
 *  claim "clean run", and only the service is entitled to make it. */
function mergeCaveats(own: string[] | undefined, engine: unknown): string[] | undefined {
  const fromEngine = Array.isArray(engine) ? (engine as string[]) : null;
  if (!own?.length) return fromEngine ?? undefined;
  return fromEngine ? [...own, ...fromEngine] : own;
}

/* ------------------------------------------------------------- geography */

type Geo = {
  track: TrackPoint[];
  source: Footage["source"];
  /* The service's own provenance label. A sidecar track and an embedded
     one are both TELEMETRY — the aircraft recorded them; only a coordinate a
     person put on the map is `pinned`. */
  locationSource: LocationSource;
  note: string;
  caveats: string[];
  capturedAt: string | null;
};
type GeoOutcome = { ok: true; geo: Geo } | { ok: false; reason: IngestReason };

/** The track of a sidecar, if the item has one and it parses. */
async function sidecarTrack(item: IngestItem): Promise<{ track: TrackPoint[]; srt: boolean } | null> {
  if (!item.sidecar) return null;
  const srt = /\.srt$/i.test(item.sidecar.name);
  const text = await item.sidecar.text();
  const track = srt ? parseSRT(text) : parseJSONSidecar(text);
  return track.length ? { track, srt } : null;
}

/** The clip's own track: its dropped sidecar first, then the telemetry inside
 *  the file itself. Null when neither answers — and null is returned as null,
 *  never as an empty track, because "no telemetry" and "it did not move" are
 *  different statements and only one of them is measured. */
async function clipTrack(item: IngestItem): Promise<TrackPoint[] | null> {
  try {
    const side = await sidecarTrack(item);
    if (side?.track.length) return side.track;
  } catch {
    /* An unreadable sidecar is not a track. The upload path reports it as its
       own failure; here it simply means the file itself has to answer. */
  }
  const probe = await parseMP4Metadata(item.file).catch(() => null);
  return probe?.track?.length ? probe.track : null;
}

const EARTH_R_M = 6371000;

/** Great-circle metres between two fixes. */
function metresBetween(a: TrackPoint, b: TrackPoint): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Ground distance between the first and last fix of a track, in metres.
 *  End to end, not path length: the question a frame picker has to answer is
 *  "does one instant stand for this clip", and a transect that flew out and
 *  came back to the same haul-out is one scene however many kilometres of
 *  track it logged. */
function trackSpanM(track: TrackPoint[]): number | null {
  if (track.length < 2) return null;
  const pts = [...track].sort((a, b) => a.t - b.t);
  return metresBetween(pts[0], pts[pts.length - 1]);
}

/** Above this, the clip is a strip rather than a scene and the picker says so.
 *  30 m is roughly two frame-widths at survey altitude — below it the frames
 *  overlap enough that one of them genuinely stands for the clip. */
export const CLIP_MOVED_M = 30;

/** Where this file was taken, and how confident that answer is.
 *
 *  Order is deliberate and unchanged from the ingest it replaces: a dropped
 *  sidecar, then the camera's own telemetry, then a hand-placed anchor. The
 *  camera's record beats a pin, always — the old code chose the branch before
 *  reading the file and let a pin left armed from an earlier drop outrank the
 *  GPS the aircraft actually recorded. */
async function resolveGeography(item: IngestItem): Promise<GeoOutcome> {
  const caveats: string[] = [];

  if (item.sidecar) {
    const srt = /\.srt$/i.test(item.sidecar.name);
    let parsed: { track: TrackPoint[]; srt: boolean } | null = null;
    try {
      parsed = await sidecarTrack(item);
    } catch (e: any) {
      return {
        ok: false,
        reason: {
          key: srt ? "ingest.srtUnreadable" : "ingest.jsonUnreadable",
          vars: { name: item.sidecar.name, msg: messageOf(e) },
        },
      };
    }
    if (parsed) {
      const { track } = parsed;
      let note = `${track.length} ${TP(track.length, "misc.trackPoints")}`;
      const v = validateTrackInCaspian(track);
      if (!v.valid) {
        const said = translate(lang(), v.key, v.vars);
        note += ` · ${said}`;
        caveats.push(said);
      }
      return {
        ok: true,
        geo: {
          track,
          source: parsed.srt ? "srt" : "json",
          locationSource: "telemetry",
          note,
          caveats,
          capturedAt: capturedAtOf(track),
        },
      };
    }
  }

  /* Why the file itself could not answer — remembered so the needs_location
     row can say "this video has GPS, but at 55.2, 37.6" instead of the flat
     falsehood "no GPS". */
  let fallback: IngestReason = { key: "ingest.needLocationImage", vars: { name: item.fileName } };

  if (item.kind === "video") {
    let probeError: string | null = null;
    let probe: Awaited<ReturnType<typeof parseMP4Metadata>> | null = null;
    try {
      probe = await parseMP4Metadata(item.file);
    } catch (e: any) {
      probeError = messageOf(e);
    }
    if (probe?.track && probe.track.length > 0) {
      const at = probe.found ? ` · ${probe.found.lat.toFixed(4)}, ${probe.found.lng.toFixed(4)}` : "";
      let note = `${T("drop.gpsFromVideo")}${at} · ${probe.fixes} ${TP(probe.fixes, "misc.fixes")}`;
      if (probe.timesSynthesized) note += ` · ${T("drop.evenSpacing")}`;
      return {
        ok: true,
        geo: {
          track: probe.track,
          source: "injected",
          locationSource: "telemetry",
          note,
          caveats,
          capturedAt: null,
        },
      };
    }
    if (probeError) fallback = { key: "ingest.needLocationUnreadable", vars: { name: item.fileName, msg: probeError } };
    else if (probe?.outsideSurveyArea && probe.found)
      fallback = {
        key: "ingest.needLocationOutside",
        vars: { name: item.fileName, lat: probe.found.lat.toFixed(4), lng: probe.found.lng.toFixed(4) },
      };
    else fallback = { key: "ingest.needLocationVideo", vars: { name: item.fileName } };
  }

  if (item.anchor) {
    /* One point, not a drawn path: the anchor is the centre of the shot and
       the engine lays the animals out around it by their true pixel offsets.
       No `alt` — a pin says WHERE, never HOW HIGH, and an invented altitude
       becomes an invented ground sample distance under every hectare. */
    const track: TrackPoint[] = [{ t: 0, lat: item.anchor.lat, lng: item.anchor.lng }];
    const telemetry = item.anchorSource === "telemetry";
    return {
      ok: true,
      geo: {
        track,
        source: telemetry ? "injected" : "manual",
        locationSource: telemetry ? "telemetry" : "pinned",
        note: telemetry
          ? T("ingest.fromClipTelemetry")
          : T("ingest.pinnedAt", { lat: item.anchor.lat.toFixed(3), lng: item.anchor.lng.toFixed(3) }),
        caveats,
        capturedAt: null,
      },
    };
  }

  return { ok: false, reason: fallback };
}

/* ------------------------------------------------------------------ store */

type IngestStore = {
  items: IngestItem[];
  activeId: string | null;
  /** The needs_location row that currently owns the map's pin. */
  pinTarget: string | null;
  pinZoom: number | null;
  pinEntry: "click" | "typed" | null;
  /** The survey block the operator filled in; applied to everything it drops
   *  next, and kept when the panel closes. */
  meta: IngestMeta;
  metaOpen: boolean;
  failedJobs: FailedJob[];
  /** Null until asked. False when this client cannot list the service's
   *  failed jobs at all — then the section is not rendered, because an empty
   *  "failed ingests" list is a claim, not an absence. */
  failedJobsSupported: boolean | null;

  enqueue: (entries: NewIngest[]) => string[];
  setPhase: (id: string, phase: IngestPhase, patch?: Partial<IngestItem>) => void;
  setProgress: (id: string, sent: number, total: number) => void;
  setAnchor: (id: string, p: { lat: number; lng: number }, source?: AnchorSource) => void;
  clearAnchor: (id: string) => void;
  claimPin: (id: string | null) => void;
  notePin: (entry: "click" | "typed", zoom: number | null) => void;
  setMeta: (patch: Partial<IngestMeta>) => void;
  setMetaOpen: (v: boolean) => void;
  dismiss: (id: string) => void;
  retry: (id: string) => void;
  cancel: (id: string) => void;
  clearFinished: () => void;
  runNext: () => void;
  resume: (id: string) => void;

  openDuplicate: (id: string) => Promise<void>;
  countAgain: (id: string) => void;

  wantFrames: (id: string) => Promise<void>;
  chooseQuickCount: (id: string, atSeconds: number) => Promise<void>;

  refreshFailed: () => Promise<void>;
  retryJob: (jobId: string) => Promise<void>;
  dismissJob: (jobId: string) => void;
};

/** Abort handles, one per item, off the rendered state. */
const controllers = new Map<string, AbortController>();
/** The single in-flight item. Set synchronously before the first await, so two
 *  `runNext()` calls in the same tick cannot both claim the worker. */
let active: string | null = null;

/* Return types are written out, not inferred. Both of these reach back into
   the store that is defined below them, and an inferred return type makes that
   a circular reference TypeScript resolves to `any` — silently, taking the
   whole store's typing with it. */
const patch = (id: string, p: Partial<IngestItem>): void => {
  useIngestStore.setState((s) => ({
    items: s.items.map((i) => (i.id === id ? { ...i, ...p } : i)),
  }));
};
const itemOf = (id: string): IngestItem | null =>
  useIngestStore.getState().items.find((i) => i.id === id) ?? null;

export const useIngestStore = create<IngestStore>((set, get) => ({
  items: [],
  activeId: null,
  pinTarget: null,
  pinZoom: null,
  pinEntry: null,
  meta: {},
  metaOpen: false,
  failedJobs: [],
  failedJobsSupported: null,

  /* A second drop APPENDS. The old guard rejected the whole drop while one
     file was in flight, so dragging in the rest of a card was a no-op with a
     one-line message that scrolled away. */
  enqueue: (entries) => {
    const now = Date.now();
    const items: IngestItem[] = entries.map((e) => ({
      id: `ing-${genId()}`,
      file: e.file,
      fileName: e.file.name,
      bytes: e.file.size,
      lastModified: e.file.lastModified,
      kind: e.kind,
      phase: e.phase ?? "queued",
      bytesSent: 0,
      bytesTotal: e.file.size,
      frameDone: null,
      frameTotal: null,
      sidecar: e.sidecar ?? null,
      reason: e.reason,
      meta: { ...get().meta },
      startedAt: now,
    }));
    set((s) => ({ items: [...s.items, ...items] }));
    get().runNext();
    return items.map((i) => i.id);
  },

  setPhase: (id, phase, p) => patch(id, { ...p, phase }),
  setProgress: (id, sent, total) => patch(id, { bytesSent: sent, bytesTotal: total || sent }),

  setAnchor: (id, p, source = "pinned") => {
    const it = itemOf(id);
    if (!it) return;
    /* Rounded at the boundary, once. A typed coordinate is as precise as it
       was typed; a clicked one is rounded to what a click can support. */
    const anchor =
      source === "pinned" ? { lat: roundPin(p.lat), lng: roundPin(p.lng) } : { lat: p.lat, lng: p.lng };
    patch(id, { anchor, anchorSource: source, anchorZoom: get().pinZoom });
  },
  clearAnchor: (id) => patch(id, { anchor: null, anchorSource: undefined, anchorZoom: null }),
  claimPin: (id) => set({ pinTarget: id }),
  notePin: (entry, zoom) => set({ pinEntry: entry, pinZoom: zoom }),

  setMeta: (p) => {
    const next: IngestMeta = { ...get().meta, ...p };
    if (typeof next.notes === "string") next.notes = cleanNote(next.notes);
    set({ meta: next });
  },
  setMetaOpen: (v) => set({ metaOpen: v }),

  dismiss: (id) => {
    controllers.get(id)?.abort();
    controllers.delete(id);
    /* An anchor whose file is gone is an anchor with no owner. Released here,
       never carried forward onto the next photo — inheriting a stale pin is
       how a coordinate got published for a file it had no relationship to.
       Only the OWNER clears the map: another row (or a manual ground count)
       may be pinning right now. */
    const owned = get().pinTarget === id;
    set((s) => ({
      items: s.items.filter((i) => i.id !== id),
      pinTarget: owned ? null : s.pinTarget,
    }));
    if (owned) {
      const fs = useFootageStore.getState();
      fs.setPinPoints([]);
      fs.setPinMode(false);
    }
    if (active === id) active = null;
    get().runNext();
  },

  retry: (id) => {
    const it = itemOf(id);
    if (!it) return;
    /* The media row survives a job-stage failure, so a retry that re-uploaded
       the file would mint a second media row (and a second survey) for one
       sortie. `mediaId` is kept on purpose; only the job is created again. */
    patch(id, {
      phase: "queued",
      reason: undefined,
      detail: undefined,
      bytesSent: it.mediaId ? it.bytesTotal : 0,
      frameDone: null,
      frameTotal: null,
      jobId: undefined,
    });
    get().runNext();
  },

  cancel: (id) => {
    const it = itemOf(id);
    if (!it) return;
    controllers.get(id)?.abort();
    if (it.jobId) {
      /* A job the worker has already picked up is inside a process the service
         cannot interrupt; it answers 409 and says so, rather than marking the
         row cancelled while a count carries on behind it. */
      void cancelJob(it.jobId).catch((e) => {
        const msg = messageOf(e);
        patch(id, {
          reason: /409|already running|running/i.test(msg)
            ? { key: "ingest.cancelTooLate" }
            : { key: "ingest.cancelFailed", vars: { msg } },
          detail: msg,
        });
      });
    }
    /* The sortie is NOT removed. `removeFootage` is gone from the archive
       store on purpose — it filtered two arrays and called that deletion, and
       the row came back on the next hydrate. A cancelled ingest may already
       have a media row on the service, so the sortie stays and says what
       happened to it. */
    if (it.footageId)
      useFootageStore.getState().completeFootage(it.footageId, {
        status: "error",
        error: T("ingest.cancelledSortie"),
      });
    patch(id, { phase: "cancelled" });
    if (active === id) active = null;
    get().runNext();
  },

  /* Failures are NOT cleared here. They are the only record of what went
     wrong, and a "clear finished" that swept them away would be the third
     place this app has lost a failure without saying so. */
  clearFinished: () =>
    set((s) => ({ items: s.items.filter((i) => !["done", "skipped", "cancelled"].includes(i.phase)) })),

  runNext: () => {
    if (active) return;
    const next = get().items.find((i) => i.phase === "queued");
    if (!next) {
      set({ activeId: null });
      /* The drop has settled: ask the service what it recorded as failed. */
      void get().refreshFailed();
      return;
    }
    active = next.id;
    set({ activeId: next.id });
    /* The release is UNCONDITIONAL. Whatever runItem did — resolved, threw,
       was aborted, walked into a phase nobody anticipated — the worker is free
       and the next file starts. A queue that stops moving because one item
       found a new way to fail is the failure mode this whole store exists to
       prevent. Ownership is re-checked because `cancel`/`dismiss` can hand the
       worker to a new item while this one is still unwinding. */
    void runItem(next.id).finally(() => {
      if (active === next.id) {
        active = null;
        set({ activeId: null });
      }
      get().runNext();
    });
  },

  resume: (id) => {
    const it = itemOf(id);
    if (!it || isRunning(it.phase)) return;
    patch(id, { phase: "queued", reason: undefined });
    get().runNext();
  },

  openDuplicate: async (id) => {
    const it = itemOf(id);
    const match = it?.duplicateOf ?? null;
    get().dismiss(id);
    if (!match?.run_id) {
      toast.error(T("ingest.dupNotLoaded"));
      return;
    }
    const fid = `run-${match.run_id}`;
    const fs = useFootageStore.getState();
    if (fs.footages.some((f) => f.id === fid)) {
      fs.select(fid);
      return;
    }
    await fs.hydrate();
    const after = useFootageStore.getState();
    if (after.footages.some((f) => f.id === fid)) after.select(fid);
    else toast.error(T("ingest.dupNotLoaded"));
  },

  countAgain: (id) => {
    const it = itemOf(id);
    if (!it) return;
    /* Attach the re-count to the SURVEY it duplicates, so the archive's
       latest-per-survey rule folds it into one sortie instead of minting a
       second colony over the same haul-out. Impossible once the media row
       already exists — then it is honestly a separate sortie, and the row's
       own wording says so. */
    const surveyId = it.duplicateAfterUpload ? undefined : (it.duplicateOf?.survey_id ?? undefined);
    patch(id, {
      duplicateAck: true,
      meta: surveyId ? { ...it.meta, survey_id: surveyId } : it.meta,
    });
    /* A re-counted VIDEO goes back through the picker, not to the engine
       whole: "count again" answers the duplicate question, it must not
       resurrect the removed full-analysis path as a side effect. */
    if (it.kind === "video") {
      void get().wantFrames(id);
    } else {
      patch(id, { phase: "queued" });
      get().runNext();
    }
  },

  wantFrames: async (id) => {
    const it = itemOf(id);
    if (!it || it.kind !== "video") return;
    if (isRunning(it.phase)) return;
    /* Frames already extracted (a duplicate loop, a re-entry): just show the
       picker again — decoding the same clip twice buys nothing. */
    if (it.frames && it.frames.length > 0 && !it.frameError) {
      patch(id, { phase: "frame_choice", framesBusy: false });
      return;
    }
    patch(id, { phase: "frame_choice", framesBusy: true, frameError: null, frameMoveM: undefined });
    /* One clip decodes at a time. A bulk drop now sends EVERY video through
       the picker, and twelve concurrent <video> decoders is the browser
       falling over — so extraction rides a module-scope chain. The card
       already shows "extracting" from the patch above, which stays honest:
       the work is queued, then done. */
    const run = extractChain.then(async () => {
      if (!itemOf(id)) return; // cancelled while waiting its turn
      const ex = await extractFrames(it.file);
      if (!itemOf(id)) return;
      patch(id, {
        frames: ex.frames,
        frameError: ex.error,
        framesBusy: false,
        frameSpread: { duration: ex.duration, evenlySpaced: ex.evenlySpaced },
      });
      /* Did the aircraft stay over one scene, or fly a strip? Measured here,
         once, off the same track the chosen frame will be georeferenced against
         — so the picker's warning and the frame's coordinate cannot disagree.
         Second, after the strip: the frames are what the operator is waiting
         for, and a metadata read must not hold them back. */
      const track = await clipTrack(it);
      if (itemOf(id)?.phase === "frame_choice") patch(id, { frameMoveM: track ? trackSpanM(track) : null });
    });
    extractChain = run.catch(() => {});
    await run;
  },

  /* There is deliberately no `chooseFullAnalysis` next to this. It used to sit
     here, moving a clip from `frame_choice` straight to `queued` so the engine
     counted the whole video — and once the picker's button was removed, no
     caller was left. A kept-but-unreachable action for a path the product no
     longer offers is how a removed feature grows back: the next person wiring
     up a button finds it and assumes it is supported. The service capability
     is untouched and other clients still use it; nothing in THIS app does.
     A clip dropped in bulk still reaches the engine whole, but through
     `enqueue`, which is a different decision in a different file. */
  chooseQuickCount: async (id, atSeconds) => {
    const it = itemOf(id);
    if (!it) return;
    patch(id, { framesBusy: true });
    try {
      const blob = await exportFrame(it.file, atSeconds);
      const name = frameFileName(it.fileName, atSeconds);
      const jpg = new File([blob], name, { type: "image/jpeg" });
      /* Georeference the INSTANT, not the sortie. The clip's own track (or the
         sidecar's) interpolated at that second; when there is none the item
         falls through to the pin flow like any other locationless still. */
      const track = await clipTrack(it);
      const at = track ? trackAt(track, atSeconds) : null;
      patch(id, {
        file: jpg,
        fileName: name,
        bytes: jpg.size,
        bytesTotal: jpg.size,
        bytesSent: 0,
        kind: "image",
        /* The whole-flight sidecar describes the flight, not this frame. */
        sidecar: null,
        anchor: at ? { lat: at.lat, lng: at.lng } : null,
        anchorSource: at ? "telemetry" : undefined,
        quickCount: { fromVideo: it.fileName, atSeconds },
        frames: undefined,
        framesBusy: false,
        frameMoveM: undefined,
        phase: "queued",
      });
      get().runNext();
    } catch (e) {
      patch(id, { framesBusy: false, frameError: "draw_failed", detail: messageOf(e) });
    }
  },

  refreshFailed: async () => {
    try {
      const rows = await fetchJobs({ status: "failed", limit: 50 });
      const known = new Map(get().failedJobs.map((j) => [j.job_id, j]));
      set({
        failedJobsSupported: true,
        /* A retry already in flight keeps its state: this refresh runs every
           time the queue empties, and it must not reset a row the operator is
           watching back to "failed". */
        failedJobs: rows.map((r) => ({ ...r, state: known.get(r.job_id)?.state ?? "failed" })),
      });
    } catch {
      /* The listing itself failed. Say nothing rather than render an empty
         section, which reads as "nothing failed" — a claim, not an absence. */
      set({ failedJobsSupported: false });
    }
  },

  retryJob: async (jobId) => {
    const row = get().failedJobs.find((j) => j.job_id === jobId);
    if (!row?.media_id) return;
    const setRow = (p: Partial<FailedJob>) =>
      set((s) => ({ failedJobs: s.failedJobs.map((j) => (j.job_id === jobId ? { ...j, ...p } : j)) }));
    setRow({ state: "retrying", error: null });
    try {
      const fresh = await createJob(row.media_id);
      await watchJob(fresh, { onProgress: (p) => setRow({ stage: p.stage ?? null }) });
      set((s) => ({ failedJobs: s.failedJobs.filter((j) => j.job_id !== jobId) }));
      /* The count exists in the archive now; the map rebuilds from it. */
      await useFootageStore.getState().hydrate();
      toast.success(T("ingest.retryDone", { name: row.filename ?? row.media_id }));
    } catch (e) {
      setRow({ state: "failed", error: messageOf(e) });
    }
  },

  dismissJob: (jobId) =>
    set((s) => ({ failedJobs: s.failedJobs.filter((j) => j.job_id !== jobId) })),
}));

/* ------------------------------------------------------------ the worker */

/**
 * One item, start to finish. Every exit is a phase the row can render, and the
 * caller's `finally` releases the worker no matter which exit was taken —
 * including a throw, which is why nothing in here re-throws.
 */
async function runItem(id: string): Promise<void> {
  const store = useIngestStore;
  const start = itemOf(id);
  if (!start || start.phase !== "queued") return;

  const ctrl = new AbortController();
  controllers.set(id, ctrl);
  const stopped = () => ctrl.signal.aborted || itemOf(id) === null;

  try {
    /* 1. Have we counted these exact bytes before?
       Before a byte goes on the wire: a duplicate that gets uploaded and
       counted is a second colony over one haul-out, and the season's headline
       goes up by a number nobody flew. */
    let precheckRan = false;
    let current = itemOf(id)!;
    /* Not on a retry. Once `mediaId` exists the bytes ARE in the archive, so a
       hash lookup finds this very upload and the row would offer to open
       itself as its own earlier count. */
    if (!current.duplicateAck && !current.mediaId) {
      patch(id, { phase: "hashing" });
      /* Null is not "new". It means this browser could not hash the file —
         no crypto.subtle on a plain-http LAN, or a transect too large to hold
         in memory — and the duplicate question has to wait for the service's
         own answer on the upload response. */
      const sha = await hashFile(current.file);
      if (stopped()) return;
      if (sha) {
        precheckRan = true;
        const matches = await findByHash(sha).catch(() => [] as DuplicateMatch[]);
        if (stopped()) return;
        if (matches.length) {
          patch(id, { phase: "duplicate_choice", duplicateOf: matches[0], duplicateAfterUpload: false });
          return;
        }
      }
    }

    /* 2. Where was it taken? */
    patch(id, { phase: "reading" });
    current = itemOf(id)!;
    const geoOut = await resolveGeography(current);
    if (stopped()) return;
    if (!geoOut.ok) {
      patch(id, { phase: "needs_location", reason: geoOut.reason });
      return;
    }
    const geo = geoOut.geo;

    /* 3. The sortie appears on the map now, as processing — before the upload,
       because an operator watching a 400 MB video go up deserves to see where
       it will land. */
    current = itemOf(id)!;
    let track = geo.track;
    const isVideo = current.kind === "video";
    const realDuration = isVideo ? await readVideoDuration(current.file) : null;
    if (stopped()) return;
    const duration = isVideo ? (realDuration ?? Math.max(60, Math.ceil(track[track.length - 1].t + 5))) : 0;
    if (realDuration && track.length > 1) {
      const span = track[track.length - 1].t || 1;
      track = track.map((p) => ({ ...p, t: (p.t / span) * realDuration }));
    }

    /* The water mask disagreeing with a measured coordinate is a fact about
       the mask, not a licence to move the coordinate. */
    const caveats = [...geo.caveats];
    const offWater = track.filter((p) => !isWater(p.lat, p.lng)).length;
    if (offWater > 0) caveats.push(T("drop.offWater", { n: offWater, total: track.length }));

    const footageId = current.footageId ?? `up-${genId()}`;
    const centre = track[Math.floor(track.length / 2)];
    if (!current.footageId) {
      const base: Footage = {
        id: footageId,
        filename: current.fileName,
        size: current.bytes,
        duration,
        uploadedAt: geo.capturedAt ?? new Date().toISOString(),
        track,
        detections: [],
        center: { lat: centre.lat, lng: centre.lng },
        status: "processing",
        /* A quick count is not a video and not a plain still: it is one frame
           cut out of a clip, and every screen that renders its band has to be
           able to say so. */
        source: current.quickCount ? "frame" : geo.source,
        videoUrl: isVideo ? URL.createObjectURL(current.file) : undefined,
        caveats: caveats.length ? caveats : undefined,
        capturedAt: geo.capturedAt,
        locationSource: geo.locationSource,
        quickCount: current.quickCount ?? null,
        operator: current.meta?.operator ?? getOperator(),
        notes: current.meta?.notes ?? null,
        altitudeM: current.meta?.altitude_m ?? null,
      };
      useFootageStore.getState().addFootage(base);
      patch(id, { footageId, note: geo.note });
    } else {
      /* A retry. The sortie is already on the map wearing the error from last
         time; put it back to processing rather than leaving a live attempt
         rendered as a dead one. */
      useFootageStore.getState().completeFootage(footageId, { status: "processing", error: undefined });
    }

    /* 4. Upload — the one leg the browser can measure in bytes. */
    current = itemOf(id)!;
    if (!current.mediaId) {
      patch(id, { phase: "uploading", bytesSent: 0, bytesTotal: current.bytes });
      /* The service georeferences against the track IT holds. A parsed MP4
         track or a hand-placed anchor exists only in this browser, so it goes
         up as the JSON sidecar the backend's own parser reads. */
      const sc =
        current.sidecar ??
        (track.length ? new File([trackToJSON(track)], "track.json", { type: "application/json" }) : null);

      const meta: IngestMeta = { ...(current.meta ?? {}) };
      meta.location_source = geo.locationSource;
      /* The coordinate itself, not only the label for it. The service reads a
         sortie's position off the track for georeferencing, but the survey row
         is what every panel reads after a reload — and it was staying NULL, so
         an uploaded sortie came back from the archive reporting that its
         position had never been recorded and the map's fallback centre for an
         unplaced run had nothing to fall back to. */
      meta.lat = centre.lat;
      meta.lng = centre.lng;
      /* A quick count's provenance, stored rather than only written into the
         note. The note is the operator's and they may edit it; "this number
         came from one frame of a clip, so it has no cross-frame band" is a
         fact about the measurement and has to outlive any edit. */
      if (current.quickCount) {
        meta.from_video = current.quickCount.fromVideo;
        meta.at_seconds = current.quickCount.atSeconds;
      }
      /* Who filed it, read at upload time from the one identity the app has.
         Nobody having said who they are is a truthful record and stays null —
         it is not filled with "platform" the way every edit in the archive
         once was. */
      if (!meta.operator) meta.operator = getOperator();
      if (!meta.captured_at && geo.capturedAt) meta.captured_at = geo.capturedAt;
      const extraNotes: string[] = [];
      if (geo.locationSource === "pinned") {
        extraNotes.push(
          current.anchorSource === "typed"
            ? T("ingest.noteTyped", { lat: current.anchor?.lat ?? 0, lng: current.anchor?.lng ?? 0 })
            : T("ingest.notePinned", {
                lat: current.anchor?.lat ?? 0,
                lng: current.anchor?.lng ?? 0,
                z: current.anchorZoom != null ? current.anchorZoom.toFixed(1) : "?",
              }),
        );
      }
      if (current.quickCount)
        extraNotes.push(
          T("ingest.noteQuick", { name: current.quickCount.fromVideo, s: current.quickCount.atSeconds }),
        );
      if (extraNotes.length)
        meta.notes = cleanNote([meta.notes, ...extraNotes].filter(Boolean).join(" · "));

      let up: MediaOut;
      try {
        up = await uploadMedia(current.file, {
          sidecar: sc,
          meta: meta as Record<string, string | number | null | undefined>,
          signal: ctrl.signal,
          /* `total` is 0 when the browser cannot compute the length; the row
             then shows `uploading` with no percentage rather than a bar
             pinned at 0% for four minutes, which reads as a hang. */
          onProgress: (pr) => store.getState().setProgress(id, pr.loaded, pr.total || current.bytes),
        });
      } catch (e) {
        if (isAbort(e) || stopped()) return;
        throw e;
      }
      if (stopped()) return;
      const uploadInfo: IngestItem["uploadInfo"] = {
        width: up.width,
        height: up.height,
        gsd: up.gsd_cm_px ?? null,
        gsdSource: up.gsd_source ?? null,
        kind: up.kind ?? null,
      };
      patch(id, { mediaId: up.id, bytesSent: current.bytes, uploadInfo });
      /* The survey this sortie IS. Without it the inspector cannot correct the
         altitude, file a note or retire the run — every one of those calls is
         addressed to a survey id. */
      if (up.survey_id) useFootageStore.getState().completeFootage(footageId, { surveyId: up.survey_id });
      /* The duplicate question, asked late because it could not be asked
         early: this browser has no local hash, so nothing was compared until
         the service saw the bytes. The row says exactly that. */
      if (up.duplicate_of && !precheckRan && !current.duplicateAck) {
        patch(id, { phase: "duplicate_choice", duplicateOf: up.duplicate_of, duplicateAfterUpload: true });
        return;
      }
    }

    /* 5. Queue the count and follow it. */
    current = itemOf(id)!;
    const mediaId = current.mediaId!;
    patch(id, { phase: "enqueued" });
    const jobId = await createJob(mediaId);
    if (stopped()) return;
    patch(id, { jobId });

    const result = await watchJob(jobId, {
      signal: ctrl.signal,
      onProgress: (p) => {
        const writing = p.stage === "writing";
        patch(id, {
          phase: writing ? "writing" : "counting",
          stage: p.stage ?? null,
          frameDone: p.frames_done ?? null,
          frameTotal: p.frames_total ?? null,
        });
      },
    });
    if (stopped()) return;

    /* 6. The engine's answer, into the map. */
    const { placed, unplaced, pixels } = pointsToDetections(footageId, result.points ?? []);
    const best = result.count?.best ?? null;
    const fs = useFootageStore.getState();
    const footage = fs.footages.find((f) => f.id === footageId);
    let detections = placed;
    if (placed.length === 0 && best != null && best > 0 && footage) {
      detections = [
        {
          id: `${footageId}-agg`,
          footageId,
          t: 0,
          lat: footage.center.lat,
          lng: footage.center.lng,
          count: best,
          confidence: null,
          status: "auto" as const,
        },
      ];
    }
    const info = itemOf(id)?.uploadInfo;
    fs.completeFootage(footageId, {
      status: "ready",
      detections,
      band: result.count,
      unplaced,
      runId: result.run_id,
      mediaId,
      pixels,
      caveats: mergeCaveats(footage?.caveats, result.caveats),
      gsdCmPx: info?.gsd ?? null,
      gsdSource: info?.gsdSource ?? null,
      /* Per-FRAME footprint times the frames counted: a video's surveyed area
         is not the ground under one of its frames. */
      areaM2: sortieAreaM2({
        widthPx: info?.width ?? 0,
        heightPx: info?.height ?? 0,
        gsdCmPx: info?.gsd ?? null,
        frames: framesUsed(result.quality, info?.kind),
      }),
    });
    /* The pixels behind the area, where a later correction can find them.
       Patching an altitude re-derives the scale and the archive store
       recomputes the area from `frameGeom` — which until now only hydrate()
       ever wrote, so a sortie counted in this session lost its hectares the
       moment somebody corrected its altitude. */
    if (info) {
      const geom = {
        widthPx: info.width,
        heightPx: info.height,
        frames: framesUsed(result.quality, info.kind),
      };
      useFootageStore.setState((st) => ({ frameGeom: { ...st.frameGeom, [footageId]: geom } }));
    }
    patch(id, {
      phase: "done",
      result: {
        best,
        low: result.count?.low ?? null,
        high: result.count?.high ?? null,
        unplaced,
      },
    });
    const bandTxt =
      result.count && result.count.low != null && result.count.high != null && result.count.low !== result.count.high
        ? ` (${T("misc.range", { low: result.count.low, high: result.count.high })})`
        : "";
    toast.success(`${itemOf(id)?.fileName ?? ""}: ${best ?? "?"} ${TP(best ?? 0, "unit.seals")}${bandTxt}`);
  } catch (e) {
    if (isAbort(e)) {
      if (itemOf(id)) patch(id, { phase: "cancelled" });
      return;
    }
    const msg = messageOf(e);
    const it = itemOf(id);
    if (!it) return;
    if (it.footageId) useFootageStore.getState().completeFootage(it.footageId, { status: "error", error: msg });
    patch(id, { phase: "failed", reason: { key: "ingest.countFailed" }, detail: msg });
  } finally {
    controllers.delete(id);
  }
}
