"use client";
import { create } from "zustand";
import { toast } from "sonner";
import type { Footage, Detection, TrackPoint, MapLayerState } from "@/lib/types";
import { mockDetections, generateSeedTrack, KZ_SITES } from "@/lib/mock/detections";
import {
  fetchStats, fetchRunPoints, fetchTrack, pointsToDetections, mediaFileUrl, editPoints,
  patchSurvey, retireSurvey, unretireSurvey, createObservation, NOTES_MAX, REASON_MAX,
} from "@/lib/api";
import { locationSourceOf } from "@/lib/api";
import type { ObservationIn, StatsLatestRun, SurveyOut, SurveyPatch } from "@/lib/api";
import { getOperator } from "@/lib/identity";
import { sortieAreaM2 } from "@/lib/analytics/area";
import { translate, useLangStore } from "@/lib/i18n";

/* Re-exported so a form can name the shape it builds without reaching past the
   store into the HTTP client. One definition either way - these are aliases,
   not copies, so a change on the api side is a compile error here. */
export type { SurveyPatch } from "@/lib/api";
export type ObservationInput = ObservationIn;

/** How a note's last write went. "unsaved" is the debounce window — the
 *  reviewer has typed and the request has not gone yet — and it is a distinct
 *  claim from "error", which means the archive refused it. */
export type NotesState = "saved" | "saving" | "unsaved" | "error";

type Store = {
  footages: Footage[];
  detections: Detection[];
  selectedId: string | null;
  layerState: MapLayerState;
  pinMode: boolean;
  pinPoints: TrackPoint[];
  timeRange: [number, number];
  /* Hydration, told honestly. The archive arrives run by run, so the UI has to
     be able to say "still reading", "read N of M", and "this many could not be
     read" - a map that is silently missing a third of the season looks exactly
     like a map of a smaller season. */
  hydrating: boolean;
  hydrateError: string | null;
  hydrateSkipped: number;
  loadedRuns: number;
  totalRuns: number | null;
  /* ---------------------------------------------------------- the record */
  /** Per-footage note save state. Absent = nothing typed this session. */
  notesState: Record<string, NotesState>;
  /** Why a sortie was retired and by whom, keyed by footage id. The Footage
   *  itself carries only `retiredAt`; the annotation lives here so a banner
   *  can say more than "retired" without inventing a field on the type. */
  retirement: Record<string, { reason: string | null; by: string | null }>;
  /** Progress of an in-flight multi-sortie site assignment, or null. */
  siteAssign: { done: number; total: number } | null;
  /** Frame geometry per footage, kept out of Footage because only one caller
   *  needs it: correcting the scale has to RECOMPUTE the area, and width x
   *  height x frames is what the first computation was made of. Without it the
   *  inspector's "the area recomputes" would be the same empty promise the
   *  service's own endpoint was caught making. */
  frameGeom: Record<string, { widthPx: number; heightPx: number; frames: number | null }>;
  /** Verdict batches still on the wire. Package D renders "saving n verdicts";
   *  it is a count of REQUESTS, so a bulk gesture over 400 rows is one. */
  verdictsInFlight: number;
  addFootage: (f: Footage) => void;
  select: (id: string | null) => void;
  setLayer: (k: keyof MapLayerState, v: boolean) => void;
  setPinMode: (v: boolean) => void;
  setPinPoints: (pts: TrackPoint[]) => void;
  setTimeRange: (r: [number, number]) => void;
  completeFootage: (id: string, patch: Partial<Footage>) => void;
  updateDetection: (id: string, patch: Partial<Pick<Detection, "count" | "status">>) => void;
  bulkUpdateDetections: (ids: string[], patch: Partial<Pick<Detection, "count" | "status">>) => void;
  /* Push operator verdicts to the service. Internal - the two update actions
     above call it - but declared here rather than smuggled in behind `as any`,
     which is how the old version ended up with four untyped casts and a
     status->op map that no compiler was checking. */
  _persistStatus: (ids: string[], status: Detection["status"]) => void;
  /* --------------------------------------------------- the record, written */
  /** The reviewer has typed; the component's debounce owes us a saveNotes. */
  markNotesDirty: (footageId: string) => void;
  /** Persist a sortie's field notes. Debounced by the component, not here. */
  saveNotes: (footageId: string, text: string) => Promise<boolean>;
  /** Correct a survey's metadata and merge the service's answer back. */
  patchSurveyFields: (footageId: string, patch: SurveyPatch) => Promise<boolean>;
  /** Attach several sorties to one site, sequentially, with a progress count. */
  assignSite: (
    footageIds: string[],
    siteId: string,
    siteName?: string | null,
  ) => Promise<{ ok: number; failed: number }>;
  /** A site was renamed. Local only — the service already holds the new name,
   *  and re-PATCHing every sortie's site_id to learn it would be N writes to
   *  discover something one write already returned. */
  applySiteName: (siteId: string, name: string) => void;
  /** Take a sortie out of the counting without destroying it. */
  retireFootage: (footageId: string, reason: string) => Promise<boolean>;
  unretireFootage: (footageId: string) => Promise<boolean>;
  /** Record a count a person made on the ground. */
  addObservation: (input: ObservationInput) => Promise<boolean>;
  seedTestData: () => void;
  hydrate: () => Promise<void>;
  clearAll: () => void;
};

/* ------------------------------------------------------------- hydrate plumbing */

/** Runs per /v1/stats page. */
const HYDRATE_PAGE = 40;
/** Concurrent per-run fetches. The old loop did one run at a time - twenty
 *  serial round trips before the map drew anything. Six is enough to saturate
 *  the browser's per-host connection budget without starving the tile loads
 *  the same map is making. */
const HYDRATE_POOL = 6;
/** Hard ceiling on one hydrate. The design target is hundreds of sorties per
 *  season; past this we are reading an archive, not a season, and the map
 *  should be paging it deliberately rather than swallowing it on boot. */
const HYDRATE_MAX_RUNS = 400;

/** Stand-in name for a run whose media row the archive no longer carries. It
 *  identifies NOTHING — every such run shares it — so any panel that groups by
 *  filename has to exclude it rather than treat the match as an identity. It is
 *  exported for exactly that reason: the determinism section once read two
 *  unrelated archived runs as repeat counts of one file. */
export const ARCHIVED_FILENAME = "(archived survey)";

/** Bounded-concurrency map. Dependency-free on purpose: this is ten lines and
 *  the alternative is a package. Never rejects - a failing item is the
 *  caller's to record, and one unreadable run must not sink the rest. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const width = Math.max(1, Math.min(n, items.length));
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i]);
      }
    }),
  );
}

/** A timestamp from the service, as a real instant.
 *
 *  SQLite writes `datetime('now')`: UTC, space-separated, and with no zone on
 *  it. `new Date("2026-08-07 20:51:45")` reads that as LOCAL time, so every
 *  archived sortie was landing on the timeline hours off - a whole day off in
 *  the field, where the clocks are UTC+5. Anything already carrying a zone is
 *  passed through untouched. */
function instantFromService(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  const zoneless = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text);
  const d = new Date(zoneless ? `${text.replace(" ", "T")}Z` : text);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Object URLs are a manual allocation. The browser holds the whole video
 *  alive until this is called, so a session of uploads that were removed one
 *  by one used to keep every one of them in memory until the tab closed. */
function releaseBlob(url: string | null | undefined): void {
  if (url && url.startsWith("blob:")) {
    try { URL.revokeObjectURL(url); } catch { /* already revoked */ }
  }
}

const messageOf = (e: unknown): string => {
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return m.trim() || translate(useLangStore.getState().lang, "store.archiveUnreadable");
};

/** Keep the archive in the order the service listed it (newest first) even
 *  though the pool finishes runs out of order. Footages with no rank - the
 *  ones this session uploaded - keep their place. */
function insertRanked(list: Footage[], f: Footage, rank: Map<string, number>): Footage[] {
  const r = rank.get(f.id);
  if (r === undefined) return [...list, f];
  let i = list.length;
  while (i > 0) {
    const prev = rank.get(list[i - 1].id);
    if (prev === undefined || prev <= r) break;
    i--;
  }
  return [...list.slice(0, i), f, ...list.slice(i)];
}

/* One hydrate at a time, process-wide. The old entry guard read the store
   BEFORE its first await, so React 18's double-invoked effect started the
   whole waterfall twice; both copies then finished and the second threw the
   first's work away. A promise handle cannot be raced that way. */
let inflight: Promise<void> | null = null;

/* --------------------------------------------------------------- verdicts */

type PersistOp = "remove" | "reinstate";

/* Exhaustive by type: a new Detection status will not compile until this map
   says what the service should be told about it. `auto` maps to nothing on
   purpose - the service has no "unreviewed" verdict, and claiming `reinstate`
   for it would mean the store said "auto" while the archive said "validated".
   Restoring a rejected animal is `validated`, which is what it is. */
const OP_FOR_STATUS: Record<Detection["status"], PersistOp | null> = {
  false_positive: "remove",
  validated: "reinstate",
  auto: null,
};

/** Backend point id out of a detection id (`run-<run>-p<point>`). Null for the
 *  aggregate marker and for test data, neither of which the service knows. */
const pointIdOf = (id: string): number | null => {
  const m = /-p(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
};

/** Apply one patch to a set of detections without touching anything else.
 *
 *  The old version rebuilt EVERY footage and EVERY footage's detection array on
 *  every checkbox click, so one verdict changed the identity of `footages` and
 *  re-ran every downstream memo - including the map's colony-hull rebuild over
 *  all ~1500 animals. Untouched footages now come back as the same object, and
 *  a patch that matched nothing returns null so the store is not written at all.
 */
function patchDetections(
  s: Pick<Store, "footages" | "detections">,
  ids: Set<string>,
  patch: Partial<Detection>,
): Pick<Store, "footages" | "detections"> | null {
  const touched = new Set<string>();
  const detections = s.detections.map((d) => {
    if (!ids.has(d.id)) return d;
    touched.add(d.footageId);
    return { ...d, ...patch };
  });
  if (!touched.size) return null;
  const footages = s.footages.map((f) =>
    touched.has(f.id)
      ? { ...f, detections: f.detections.map((d) => (ids.has(d.id) ? { ...d, ...patch } : d)) }
      : f,
  );
  return { footages, detections };
}

/* ------------------------------------------------------------ the record */

const finiteOrNull = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The photographed ground, recomputed after a scale correction.
 *
 *  Preferably from the pixel geometry the first computation used. When that is
 *  not on hand (a sortie this session uploaded, whose geometry the ingest path
 *  did not record here), the area scales exactly with the square of the GSD,
 *  so an old area and an old scale are enough. With neither, the area is
 *  UNKNOWN — null, not the stale figure, which would then sit under a scale it
 *  was never computed from. */
function areaAfterScale(
  f: Footage,
  geom: { widthPx: number; heightPx: number; frames: number | null } | undefined,
  gsdCmPx: number | null,
): number | null {
  if (geom) {
    return sortieAreaM2({
      widthPx: geom.widthPx, heightPx: geom.heightPx, gsdCmPx, frames: geom.frames,
    });
  }
  const old = f.areaM2;
  const oldGsd = f.gsdCmPx;
  if (
    gsdCmPx != null && gsdCmPx > 0 &&
    typeof old === "number" && Number.isFinite(old) &&
    typeof oldGsd === "number" && oldGsd > 0
  ) {
    const ratio = gsdCmPx / oldGsd;
    return old * ratio * ratio;
  }
  return null;
}

/** Merge a survey row the service just answered with onto its Footage.
 *
 *  The sortie's POSITION is deliberately not touched. A survey's lat/lng is
 *  only the sortie's centre when there was no track and no georeferenced
 *  animal to derive one from (that is the order hydrate resolves in), and a
 *  correction to some other field must not silently move a colony that was
 *  measured from telemetry. */
function applySurvey(
  f: Footage,
  survey: SurveyOut,
  geom: { widthPx: number; heightPx: number; frames: number | null } | undefined,
): Footage {
  const gsd = finiteOrNull(survey.gsd_cm_px);
  return {
    ...f,
    siteId: survey.site_id ?? null,
    notes: survey.notes ?? null,
    operator: survey.operator ?? null,
    capturedAt: instantFromService(survey.captured_at),
    altitudeM: finiteOrNull(survey.altitude_m),
    tideState: survey.tide_state ?? null,
    locationSource: locationSourceOf(survey.location_source),
    gsdCmPx: gsd,
    gsdSource: survey.gsd_source ?? null,
    retiredAt: survey.retired_at ?? null,
    /* The one thing the endpoint audit caught the service NOT doing. A new
       scale with the old hectares under it is worse than no hectares. */
    areaM2: areaAfterScale(f, geom, gsd),
  };
}

export const useFootageStore = create<Store>((set, get) => ({
  footages: [],
  detections: [],
  selectedId: null,
  layerState: { footprints: true, detections: true },
  pinMode: false,
  pinPoints: [],
  timeRange: [0, 100],
  hydrating: false,
  hydrateError: null,
  hydrateSkipped: 0,
  loadedRuns: 0,
  totalRuns: null,
  notesState: {},
  retirement: {},
  siteAssign: null,
  frameGeom: {},
  verdictsInFlight: 0,
  addFootage: (f) => set(s => ({ footages: [...s.footages, f], detections: [...s.detections, ...f.detections] })),
  /* No `removeFootage`. It filtered the sortie out of two arrays and called
     that done, under a confirmation that said "Remove this sortie?" — a
     durable-sounding promise over an act that survived exactly until the next
     hydrate, when the survey came back out of the archive along with its
     contribution to the estimate. Retirement is the real operation and the
     only one offered; see `retireFootage`. */
  select: (id) => set({ selectedId: id }),
  setLayer: (k,v) => set(s=>({ layerState: {...s.layerState, [k]: v }})),
  setPinMode: (v) => set({ pinMode: v }),
  setPinPoints: (pts) => set({ pinPoints: pts }),
  setTimeRange: (r) => set({ timeRange: r }),
  /* The real pipeline lands here: a footage that went up as "processing"
     gets its engine result - detections, band, status - swapped in atomically
     across both lists, so the map never shows a half-updated sortie. */
  completeFootage: (id, patch) => {
    const prev = get().footages.find(f => f.id === id);
    /* The sortie was removed while its count was still running. The footages
       `.map` below is a no-op for a missing id, but the detections branch was
       not: it appended the finished animals anyway, leaving rows in the
       Workbench belonging to a sortie no other view could see. */
    if (!prev) return;
    if (patch.videoUrl !== undefined && patch.videoUrl !== prev.videoUrl) releaseBlob(prev.videoUrl);
    set(s => {
      const dets = patch.detections;
      return {
        footages: s.footages.map(f => f.id === id ? { ...f, ...patch } : f),
        detections: dets
          ? [...s.detections.filter(d => d.footageId !== id), ...dets]
          : s.detections,
      };
    });
  },
  /* A verdict that only lives in browser memory is not a verdict. When the
     detection belongs to a real run (footage.runId set, backend point id in
     the detection id), a status change also lands in the service's edit log.

     Grouped by run and sent as ONE request per run: marking 400 selected rows
     rejected used to fire 400 PATCHes at a database with a single writer lock.
     Still not awaited - blocking the reviewer on a round trip per click would
     make verification miserable, and the local state is already what they
     decided - but no longer silent: anything the service refused is flagged
     `unsaved` on the detection and reported once, with a count. A verdict that
     vanished without a word is the failure this product cannot afford. */
  _persistStatus: (ids, status) => {
    const op = OP_FOR_STATUS[status];
    const flag = (targets: string[], unsaved: boolean) => {
      if (!targets.length) return;
      set(s => patchDetections(s, new Set(targets), { unsaved }) ?? s);
    };
    if (!op) return;

    const s = get();
    const detById = new Map(s.detections.map(d => [d.id, d]));
    const footageById = new Map(s.footages.map(f => [f.id, f]));
    const byRun = new Map<string, { points: number[]; dets: string[] }>();
    const unpersistable: string[] = [];
    const unpersistableWhy: string[] = [];

    for (const id of ids) {
      const det = detById.get(id);
      if (!det) { unpersistableWhy.push(`${id}: no longer in the store`); unpersistable.push(id); continue; }
      const f = footageById.get(det.footageId);
      if (!f?.runId) {
        unpersistableWhy.push(`${id}: sortie has no service run (test or local data)`);
        unpersistable.push(id);
        continue;
      }
      const pointId = pointIdOf(id);
      /* The `-agg` marker is one dot standing in for a whole run's band when
         the engine placed no individual animals. There is no point row behind
         it, so there is nothing to edit - said out loud rather than returned
         from silently, which is how this looked like a working save. */
      if (pointId === null) {
        unpersistableWhy.push(`${id}: aggregate marker, no backend point`);
        unpersistable.push(id);
        continue;
      }
      let e = byRun.get(f.runId);
      if (!e) { e = { points: [], dets: [] }; byRun.set(f.runId, e); }
      e.points.push(pointId);
      e.dets.push(id);
    }

    /* A verdict with nowhere to go is a verdict that did not save, and it is
       reported exactly like one the service refused. The old code hit the
       `!byRun.size` return BEFORE flagging or toasting anything, so ruling on
       the 562-animal aggregate marker flipped the pill green, wrote nothing,
       and said nothing louder than a console warning. The pill now carries
       `unsaved` and the reviewer is told, in their own language. */
    if (unpersistable.length) {
      console.warn(`${unpersistable.length} verdict(s) have nowhere to persist:`, unpersistableWhy.slice(0, 10));
      flag(unpersistable, true);
      toast.error(
        translate(useLangStore.getState().lang, "store.editsNotSaved", {
          n: unpersistable.length,
          total: ids.length,
        }),
      );
    }
    if (!byRun.size) return;

    /* Clear a previous failure flag on these rows - this is a fresh attempt,
       and a stale "unsaved" would outlive the problem. Only the rows that
       actually carry one, so the ordinary path writes to the store exactly
       once per gesture rather than twice. */
    flag(
      [...byRun.values()].flatMap(e => e.dets).filter(id => detById.get(id)?.unsaved),
      false,
    );

    /* Attribution travels with the edit. The client used to hardcode
       operator:"platform" on every write, so an append-only log built to
       answer "who corrected this count" answered "the software did" for every
       row a human ruled on. An operator who has not given a name sends null -
       an anonymous edit, visibly anonymous, which is a true record.

       Read ONCE, here, rather than left to editPoints' own default: one
       gesture over several runs is several requests, and a name typed into
       the top bar while they are in flight must not split one decision
       between two authors. */
    const operator = getOperator();
    set(s => ({ verdictsInFlight: s.verdictsInFlight + byRun.size }));

    void Promise.all(
      [...byRun.entries()].map(async ([runId, e]) => {
        try {
          await editPoints(runId, op, e.points, operator);
          return [] as string[];
        } catch (err) {
          console.warn(`edits did not persist for run ${runId}:`, err);
          return e.dets;
        } finally {
          set(s => ({ verdictsInFlight: Math.max(0, s.verdictsInFlight - 1) }));
        }
      }),
    ).then((results) => {
      const failed = results.flat();
      if (!failed.length) return;
      flag(failed, true);
      toast.error(
        translate(useLangStore.getState().lang, "store.editsNotSaved", {
          n: failed.length,
          total: ids.length,
        }),
      );
    });
  },
  updateDetection: (id, patch) => {
    set(s => patchDetections(s, new Set([id]), patch) ?? s);
    if (patch.status) get()._persistStatus([id], patch.status);
  },
  bulkUpdateDetections: (ids, patch) => {
    set(s => patchDetections(s, new Set(ids), patch) ?? s);
    if (patch.status) get()._persistStatus(ids, patch.status);
  },

  /* ------------------------------------------------------------ the record
     Everything below writes to the SURVEY behind a sortie rather than to the
     count. A note, a place name, a corrected altitude and a retirement are all
     things a person knows and the engine cannot derive; they are stored where
     the count is stored, attributed, and reloaded by hydrate() like any other
     measured field. None of them touch a number the engine produced. */

  markNotesDirty: (footageId) =>
    set(s => (s.notesState[footageId] === "unsaved"
      ? s
      : { notesState: { ...s.notesState, [footageId]: "unsaved" } })),

  saveNotes: async (footageId, text) => {
    const setState = (v: NotesState) =>
      set(s => ({ notesState: { ...s.notesState, [footageId]: v } }));
    const lang = () => useLangStore.getState().lang;
    const f = get().footages.find(x => x.id === footageId);
    if (!f) return false;

    const body = String(text ?? "");
    /* Refused here, before the request. The cap is the column's, and a note
       that the service would truncate is a note the reviewer would believe
       they had written in full. */
    if (body.length > NOTES_MAX) {
      setState("error");
      toast.error(translate(lang(), "rec.notes.tooLong", { max: NOTES_MAX }));
      return false;
    }
    if (!f.surveyId) {
      setState("error");
      toast.error(translate(lang(), "rec.notes.noSurvey"));
      return false;
    }
    setState("saving");
    try {
      /* The survey table has ONE operator column, and it belongs to whoever
         flew the sortie. A note is not a reason to overwrite that, so the
         current operator is filled in only where the field is still empty -
         and the inspector labels the line "attributed to", which is the claim
         a single shared column can actually support. */
      const who = getOperator();
      const patch: SurveyPatch = { notes: body };
      if (who && !f.operator) patch.operator = who;
      const survey = await patchSurvey(f.surveyId, patch);
      set(s => ({
        footages: s.footages.map(x =>
          x.id === footageId ? applySurvey(x, survey, s.frameGeom[footageId]) : x),
        notesState: { ...s.notesState, [footageId]: "saved" },
      }));
      return true;
    } catch (e) {
      setState("error");
      toast.error(`${translate(lang(), "rec.notes.error")}: ${messageOf(e)}`);
      return false;
    }
  },

  patchSurveyFields: async (footageId, patch) => {
    const lang = () => useLangStore.getState().lang;
    const f = get().footages.find(x => x.id === footageId);
    if (!f) return false;
    if (!f.surveyId) {
      toast.error(translate(lang(), "rec.meta.noSurvey"));
      return false;
    }
    try {
      const survey = await patchSurvey(f.surveyId, patch);
      set(s => ({
        footages: s.footages.map(x =>
          x.id === footageId ? applySurvey(x, survey, s.frameGeom[footageId]) : x),
      }));
      return true;
    } catch (e) {
      toast.error(`${translate(lang(), "rec.meta.failed")}: ${messageOf(e)}`);
      return false;
    }
  },

  /* Sequential on purpose. Naming a haul-out rewrites every sortie flown over
     it, which on this fixture is three rows and could be thirty; SQLite has
     one writer, and thirty parallel PATCHes at it is the pattern the batch
     verdict endpoint exists to stop. The progress count is why the panel can
     say "8 of 30 written" instead of freezing. */
  assignSite: async (footageIds, siteId, siteName) => {
    const ids = footageIds.filter(Boolean);
    let ok = 0;
    let failed = 0;
    set({ siteAssign: { done: 0, total: ids.length } });
    try {
      for (const id of ids) {
        const f = get().footages.find(x => x.id === id);
        if (!f?.surveyId) { failed++; continue; }
        try {
          const survey = await patchSurvey(f.surveyId, { site_id: siteId });
          set(s => ({
            footages: s.footages.map(x =>
              x.id === id
                ? { ...applySurvey(x, survey, s.frameGeom[id]), siteName: siteName ?? x.siteName ?? null }
                : x),
          }));
          ok++;
        } catch (e) {
          console.warn(`site assignment did not persist for ${id}:`, e);
          failed++;
        } finally {
          set(s => ({ siteAssign: { done: (s.siteAssign?.done ?? 0) + 1, total: ids.length } }));
        }
      }
    } finally {
      set({ siteAssign: null });
    }
    return { ok, failed };
  },

  applySiteName: (siteId, name) =>
    set(s => ({
      footages: s.footages.map(f => (f.siteId === siteId ? { ...f, siteName: name } : f)),
    })),

  /* Retirement, not deletion. The sortie stays in the archive with its count,
     its animals and its evidence intact - it simply stops being one of the
     surveys the estimate is built from. That is what an ecologist means by
     "this flight should not be in the season", and it is reversible, which
     deletion is not. */
  retireFootage: async (footageId, reason) => {
    const lang = () => useLangStore.getState().lang;
    const f = get().footages.find(x => x.id === footageId);
    if (!f) return false;
    /* REASON_MAX, not NOTES_MAX. The retire endpoint refuses past 500 and
       this sliced at 4000 - masked only by a maxLength on the one input
       that reaches it, which makes the constant wrong rather than the
       behaviour, and the next caller inherits the bug. */
    const why = String(reason ?? "").trim().slice(0, REASON_MAX);
    const who = getOperator();

    /* Test data and a sortie whose upload never reached the service exist only
       in this tab. There is no archive row to retire, so forgetting it here IS
       the durable outcome - and the caller says so before asking. */
    if (!f.surveyId) {
      releaseBlob(f.videoUrl);
      set(s => ({
        footages: s.footages.filter(x => x.id !== footageId),
        detections: s.detections.filter(d => d.footageId !== footageId),
        selectedId: s.selectedId === footageId ? null : s.selectedId,
      }));
      return true;
    }
    try {
      const survey = await retireSurvey(f.surveyId, why, who);
      const at = survey.retired_at ?? new Date().toISOString();
      set(s => ({
        footages: s.footages.map(x =>
          x.id === footageId
            ? { ...applySurvey(x, survey, s.frameGeom[footageId]), retiredAt: at }
            : x),
        retirement: {
          ...s.retirement,
          [footageId]: {
            /* What the ARCHIVE recorded, not what this form typed. If the two
               ever differ, the stored one is the record. */
            reason: survey.retired_reason ?? (why || null),
            by: survey.retired_by ?? who,
          },
        },
      }));
      return true;
    } catch (e) {
      toast.error(`${translate(lang(), "rec.retire.failed")}: ${messageOf(e)}`);
      return false;
    }
  },

  unretireFootage: async (footageId) => {
    const lang = () => useLangStore.getState().lang;
    const f = get().footages.find(x => x.id === footageId);
    if (!f?.surveyId) return false;
    try {
      const survey = await unretireSurvey(f.surveyId);
      set(s => {
        const retirement = { ...s.retirement };
        delete retirement[footageId];
        return {
          footages: s.footages.map(x =>
            x.id === footageId
              ? { ...applySurvey(x, survey, s.frameGeom[footageId]), retiredAt: survey.retired_at ?? null }
              : x),
          retirement,
        };
      });
      return true;
    } catch (e) {
      toast.error(`${translate(lang(), "rec.retire.undoFailed")}: ${messageOf(e)}`);
      return false;
    }
  },

  /* A count a person made, standing on the shore. It becomes a sortie because
     that is what it is - one visit to one place on one date - and the site
     estimate treats it as such. What it is NOT is an engine result: the band
     is the single number the observer reported (low = best = high, so nothing
     downstream draws a range strip over it), the basis says "manual", and the
     engine says "manual" so every surface can label it without guessing.
     Synthesised locally rather than re-hydrating the whole archive, but with
     the id hydrate WOULD give it, so the next reload does not double it. */
  addObservation: async (input) => {
    const lang = () => useLangStore.getState().lang;
    try {
      const { survey, run } = await createObservation(input);
      /* The id hydrate would give this row, so an F5 does not mint a second
         sortie over the same observation. */
      const id = `run-${run.id}`;
      if (get().footages.some(x => x.id === id)) return true;

      /* The SERVICE's numbers, not the form's. What was stored is what the
         panel must show, or a rejected field would render as if it had been
         accepted. `count_best` is the observer's single number, and low/high
         equal it - hasRange is false, so no strip is drawn. */
      const count = finiteOrNull(run.count_best) ?? 0;
      const lat = finiteOrNull(survey.lat);
      const lng = finiteOrNull(survey.lng);
      const when = instantFromService(survey.captured_at);
      const placed = lat != null && lng != null;

      get().addFootage({
        id,
        filename: "",
        size: 0,
        duration: 0,
        uploadedAt: when ?? new Date().toISOString(),
        capturedAt: when,
        track: [],
        detections: [],
        center: placed ? { lat, lng } : { lat: NaN, lng: NaN },
        placed,
        status: "ready",
        source: "manual",
        engine: run.engine || "manual",
        band: {
          low: finiteOrNull(run.count_low) ?? count,
          best: count,
          high: finiteOrNull(run.count_high) ?? count,
          basis: run.basis || "manual",
        },
        surveyId: survey.id,
        runId: run.id,
        siteId: survey.site_id ?? null,
        /* The site's NAME is not on a survey row. Left null rather than
           guessed at; the next hydrate joins it, and until then the panel
           prints the coordinate, which is a true statement about the place. */
        siteName: null,
        notes: survey.notes ?? null,
        operator: survey.operator ?? null,
        /* A person's coordinate, and the row says so wherever it is printed. */
        locationSource: locationSourceOf(survey.location_source) ?? "manual",
        /* No footprint: nobody photographed any ground. Unknown area and zero
           area are different claims, and this is neither - it is "not
           applicable", which null is the closest honest rendering of. */
        areaM2: null,
        gsdCmPx: null,
        gsdSource: null,
        retiredAt: survey.retired_at ?? null,
      });
      toast.success(translate(lang(), "rec.manual.saved"));
      return true;
    } catch (e) {
      toast.error(`${translate(lang(), "rec.manual.failed")}: ${messageOf(e)}`);
      return false;
    }
  },

  clearAll: () => {
    for (const f of get().footages) releaseBlob(f.videoUrl);
    set({
      footages: [], detections: [], selectedId: null, pinPoints: [],
      loadedRuns: 0, totalRuns: null, hydrateSkipped: 0, hydrateError: null,
      notesState: {}, retirement: {}, siteAssign: null, frameGeom: {},
    });
  },
  /* Reload the season's counts from the service. The store is browser memory;
     the surveys are not - they live in the backend, and losing the map to an
     F5 made the platform look like it forgot the season's work.

     Three things this deliberately does NOT do any more:

     - It does not wait for the whole archive before showing any of it. Runs are
       fetched six at a time and each one is merged into the store the moment it
       lands, so the map paints progressively instead of sitting on the empty
       state (with a "load test data" button on it) for twenty serial round
       trips.
     - It does not commit by replacing the store. It upserts by footage id, and
       skips ids already present. The old final write was gated on the store
       still being empty, so anything that arrived while it ran - an upload, a
       second hydrate - threw the entire fetched archive away without a word.
     - It does not drop a run for having no map position. `best` is a real
       measured count, and a sortie the map cannot place is still a sortie that
       counted animals; it is carried with `placed:false` and stays in the
       totals.

     Failures stay quiet in the UI - a fresh empty map must not toast at someone
     opening the app offline - but they are recorded: `hydrateError` for the
     listing itself, `hydrateSkipped` for the individual runs that would not
     read. Something has to render those; nothing may pretend they did not
     happen. */
  hydrate: () => {
    if (inflight) return inflight;
    set({ hydrating: true, hydrateError: null });

    const rank = new Map<string, number>();

    const merge = (
      f: Footage,
      geom: { widthPx: number; heightPx: number; frames: number | null },
      retired: { reason: string | null; by: string | null } | null,
    ) => set(s => {
      if (s.footages.some(x => x.id === f.id)) return s;
      return {
        footages: insertRanked(s.footages, f, rank),
        detections: [...s.detections, ...f.detections],
        loadedRuns: s.loadedRuns + 1,
        frameGeom: { ...s.frameGeom, [f.id]: geom },
        retirement: retired ? { ...s.retirement, [f.id]: retired } : s.retirement,
      };
    });
    const skip = (n = 1) => set(s => ({ hydrateSkipped: s.hydrateSkipped + n }));

    const loadRun = async (r: StatsLatestRun): Promise<void> => {
      const id = `run-${r.run_id}`;
      if (get().footages.some(f => f.id === id)) return;
      const [pts, track] = await Promise.all([
        fetchRunPoints(r.run_id),
        r.media_id ? fetchTrack(r.media_id).catch(() => []) : Promise.resolve([]),
      ]);
      const { placed, unplaced, pixels } = pointsToDetections(id, pts.points);
      const trk: TrackPoint[] = track.map((p) => ({
        t: p.t ?? 0, lat: p.lat, lng: p.lng, alt: p.alt ?? undefined,
      }));
      const best = r.best ?? null;

      /* Both halves or neither: a clip name with no timestamp cannot say WHICH
         frame, and a timestamp with no clip cannot say which video. Either on
         its own is not a provenance, so it is not rendered as one. */
      const quick =
        typeof r.from_video === "string" && r.from_video.trim() !== "" &&
        typeof r.at_seconds === "number" && Number.isFinite(r.at_seconds)
          ? { fromVideo: r.from_video.trim(), atSeconds: r.at_seconds }
          : null;

      /* Where the sortie sits. The track's midpoint if it flew one, else the
         mean of the animals it actually placed - rejected ones excluded, since
         a false positive should not tug the colony's centre. */
      let center: { lat: number; lng: number } | null = null;
      if (trk.length) {
        const mid = trk[Math.floor(trk.length / 2)];
        center = { lat: mid.lat, lng: mid.lng };
      } else {
        const real = placed.filter(d => d.status !== "false_positive");
        if (real.length) {
          center = {
            lat: real.reduce((a, d) => a + d.lat, 0) / real.length,
            lng: real.reduce((a, d) => a + d.lng, 0) / real.length,
          };
        }
      }
      /* Last resort, and a real measurement rather than a fallback: the survey
         row's own coordinate. A ground count has no track and no engine point,
         and a photo whose position was pinned by hand carries the pin here -
         both used to reload as {NaN, NaN}, drop out of the site grouping
         entirely, and take their animals out of the estimate with them. */
      if (!center) {
        const slat = Number(r.survey_lat);
        const slng = Number(r.survey_lng);
        if (Number.isFinite(slat) && Number.isFinite(slng)) center = { lat: slat, lng: slng };
      }
      const positioned = center !== null;
      /* NaN, not (0,0). There is no honest coordinate for this sortie, and an
         invented one would put it in the Gulf of Guinea. Every map consumer
         already gates on Number.isFinite; `placed:false` is the flag to read. */
      const anchor = center ?? { lat: NaN, lng: NaN };

      let detections = placed;
      if (!placed.length && positioned && best != null && best > 0) {
        detections = [{
          id: `${id}-agg`, footageId: id, t: 0,
          lat: anchor.lat, lng: anchor.lng,
          count: best, confidence: null, status: "auto" as const,
        }];
      }

      merge({
        id,
        /* A ground count has no file. "(archived survey)" over a number a
           person reported would read as footage nobody ever shot, so the row
           is left nameless and the panels label it by what it is. */
        filename: r.filename ?? (r.engine === "manual" ? "" : ARCHIVED_FILENAME),
        size: 0,
        duration: 0,
        /* When the footage was FLOWN, not when the count job ran. `created_at`
           is the job's clock, and a re-processed 2019 sortie carrying today's
           date lands on the wrong end of the timeline. The fallback stays:
           surveys without a capture date are the common case today. */
        uploadedAt: instantFromService(r.captured_at)
          ?? instantFromService(r.created_at)
          ?? new Date().toISOString(),
        /* Carried SEPARATELY from uploadedAt and null when unrecorded. The
           timeline needs a date for every sortie and falls back to the job
           clock to get one; the inspector must be able to tell the two apart,
           because printing "counted on" as "flown on" turns a processing
           timestamp into a field observation. */
        capturedAt: instantFromService(r.captured_at),
        surveyId: r.survey_id ?? undefined,
        siteId: r.site_id ?? null,
        siteName: r.site_name ?? null,
        notes: r.notes ?? null,
        operator: r.operator ?? null,
        /* Narrowed, not cast: a provenance token this build does not know
           becomes null — "we do not know how this position was arrived at" —
           rather than falling into whichever branch happens to be the else. */
        locationSource: locationSourceOf(r.location_source),
        retiredAt: r.retired_at ?? null,
        altitudeM: r.altitude_m ?? null,
        tideState: r.tide_state ?? null,
        engine: r.engine ?? null,
        falsePositiveRisk: r.false_positive_risk ?? null,
        falsePositiveBasis: Array.isArray(r.false_positive_basis) ? r.false_positive_basis : null,
        track: trk,
        detections,
        center: anchor,
        placed: positioned,
        status: "ready",
        /* A quick count stays a quick count across a reload. The archive now
           records the clip and the second the frame was taken at, so the row
           can be rebuilt as what it is — one frame of a video, deliberately
           counted without a cross-frame band — instead of degrading into a
           plain archived still whose only trace of the trade was a free-text
           note the operator can edit away. */
        source: quick ? "frame" : "archive",
        quickCount: quick,
        runId: r.run_id,
        mediaId: r.media_id ?? undefined,
        videoUrl: r.kind === "video" && r.media_id ? mediaFileUrl(r.media_id) : undefined,
        band: { low: r.low ?? null, best, high: r.high ?? null, basis: r.basis ?? "" },
        unplaced,
        pixels,
        /* Only a list the service actually sent becomes caveats. A service
           too old to report them leaves this undefined, so the inspector
           stays silent instead of certifying the run as clean. */
        caveats: Array.isArray(r.caveats) ? r.caveats : undefined,
        gsdCmPx: r.gsd_cm_px ?? null,
        gsdSource: r.gsd_source ?? null,
        /* Frame footprint TIMES the frames the engine counted on. One frame
           of a three-minute transect is not the ground that transect
           surveyed. `frames_used` is null when the run's ledger never said
           how many frames it used - then the area is unknown, not one
           frame's worth. */
        areaM2: sortieAreaM2({
          widthPx: r.width ?? 0, heightPx: r.height ?? 0, gsdCmPx: r.gsd_cm_px,
          frames: r.frames_used ?? null,
        }),
      },
      /* Kept so a later scale correction can recompute that area from the same
         terms rather than scaling the old number and hoping. */
      { widthPx: r.width ?? 0, heightPx: r.height ?? 0, frames: r.frames_used ?? null },
      /* The withdrawal, as the archive recorded it. This used to be `null` on
         the grounds that the listing never returned a retired row — it does
         now, and with it the two fields that make a withdrawal defensible a
         season later. Still `null` where nothing was withdrawn, so an
         un-retired sortie never grows an empty banner; and either field may be
         null on its own, because a reason the archive does not hold is left
         unsaid rather than filled in. */
      r.retired_at
        ? { reason: r.retired_reason ?? null, by: r.retired_by ?? null }
        : null,
      );
    };

    inflight = (async () => {
      try {
        let offset = 0;
        let ranked = 0;
        for (;;) {
          /* One run per survey: a re-count of the same footage is a correction,
             not a second sortie, and hydrating both minted two Footages over
             one colony. A service too old for the parameter ignores it and
             reports no total - then this window is all there is, and totalRuns
             stays null so nothing prints a truncated archive as a whole one. */
          /* Retired sorties come back too. They are excluded from the estimate
             by `retiredAt`, not by being absent — left out of the fetch, a
             withdrawal became irreversible the moment the tab reloaded: the row
             was gone, so the archive's "show retired" toggle never appeared and
             the Undo the banner offers had nothing to act on. The retire form
             promises the sortie "stays in the archive"; this is what keeps that
             promise past an F5. */
          const stats = await fetchStats({
            latestPerSurvey: true, limit: HYDRATE_PAGE, offset, includeRetired: true,
          });
          const rows = (stats.latest_runs ?? []) as StatsLatestRun[];
          const usable = rows.filter((r) => r && r.run_id);
          const total = typeof stats.latest_runs_total === "number" ? stats.latest_runs_total : null;
          if (offset === 0) set({ totalRuns: total });
          if (rows.length > usable.length) skip(rows.length - usable.length);

          /* Remember the listing order BEFORE fetching: the pool finishes runs
             in whatever order the network hands them back, and the sortie list
             must still read newest-first rather than fastest-first. */
          for (const r of usable) rank.set(`run-${r.run_id}`, ranked++);

          await pool(usable, HYDRATE_POOL, async (r) => {
            try {
              await loadRun(r);
            } catch (e) {
              /* one unreadable run must not sink the rest of the season */
              console.warn(`sortie ${r.run_id} could not be read:`, e);
              skip();
            }
          });

          offset += rows.length;
          if (!rows.length || total === null || offset >= total || offset >= HYDRATE_MAX_RUNS) break;
        }
      } catch (e) {
        set({ hydrateError: messageOf(e) });
      } finally {
        set({ hydrating: false });
        inflight = null;
      }
    })();

    return inflight;
  },
  // Synthetic sample flights so the UI can be exercised without real footage.
  // Everything created here is tagged source:"test" and named TEST_* so it is
  // never mistaken for an actual survey.
  seedTestData: () => {
    /* Not over real data, and not INTO a hydrate that is still landing runs:
       the archive arrives run by run, so an empty store is not proof that the
       store will stay empty. The two "load test data" buttons also disable
       themselves while hydrating, but the invariant belongs here — a UI
       attribute is not where a store's rules should live. */
    if (get().footages.length > 0 || get().hydrating) return;
    const demo: Footage[] = KZ_SITES.slice(0,8).map((site, idx)=> {
      const duration = 90 + Math.random()*80;
      const track = generateSeedTrack({lat: site.lat, lng: site.lng}, duration, 40);
      const id = `test-${site.id.toLowerCase()}-${idx}`;
      const dets = mockDetections(track, id);
      const center = track[Math.floor(track.length/2)];
      return {
        id,
        filename: `TEST_${String(102+idx).padStart(4,"0")}.MP4`,
        size: 180000000 + Math.floor(Math.random()*200000000),
        duration: Math.round(duration),
        uploadedAt: new Date(Date.now() - idx*86400000*3 - Math.random()*86400000).toISOString(),
        track,
        detections: dets,
        center: { lat: center.lat, lng: center.lng },
        status: "ready" as const,
        source: "test" as const,
      };
    });
    const extras = Array.from({length: 8}, (_,i)=>{
      const lat = 42.5 + Math.random()*3;
      const lng = 50.0 + Math.random()*2.5;
      const id = `test-extra-${i}`;
      const track = generateSeedTrack({lat,lng}, 80+Math.random()*60, 35);
      const dets = mockDetections(track, id);
      const center = track[Math.floor(track.length/2)];
      return {
        id,
        filename: `TEST_${String(200+i).padStart(4,"0")}.MP4`,
        size: 150000000 + Math.floor(Math.random()*150000000),
        duration: Math.round(80+Math.random()*60),
        uploadedAt: new Date(Date.now() - (8+i)*86400000).toISOString(),
        track, detections: dets, center, status: "ready" as const, source: "test" as const
      } as Footage;
    });
    const all = [...demo, ...extras];
    set({ footages: all, detections: all.flatMap(f=>f.detections) });
  }
}));
