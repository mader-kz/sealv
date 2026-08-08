"use client";
import { create } from "zustand";
import { toast } from "sonner";
import type { Footage, Detection, TrackPoint, MapLayerState } from "@/lib/types";
import { mockDetections, generateSeedTrack, KZ_SITES } from "@/lib/mock/detections";
import { fetchStats, fetchRunPoints, fetchTrack, pointsToDetections, mediaFileUrl, editPoints } from "@/lib/api";
import type { StatsLatestRun } from "@/lib/api";
import { sortieAreaM2 } from "@/lib/analytics/area";
import { translate, useLangStore } from "@/lib/i18n";

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
  addFootage: (f: Footage) => void;
  removeFootage: (id: string) => void;
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
  addFootage: (f) => set(s => ({ footages: [...s.footages, f], detections: [...s.detections, ...f.detections] })),
  removeFootage: (id) => {
    releaseBlob(get().footages.find(f => f.id === id)?.videoUrl);
    set(s => ({ footages: s.footages.filter(f=>f.id!==id), detections: s.detections.filter(d=>d.footageId!==id), selectedId: s.selectedId===id?null:s.selectedId }));
  },
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

    for (const id of ids) {
      const det = detById.get(id);
      if (!det) { unpersistable.push(`${id}: no longer in the store`); continue; }
      const f = footageById.get(det.footageId);
      if (!f?.runId) { unpersistable.push(`${id}: sortie has no service run (test or local data)`); continue; }
      const pointId = pointIdOf(id);
      /* The `-agg` marker is one dot standing in for a whole run's band when
         the engine placed no individual animals. There is no point row behind
         it, so there is nothing to edit - said out loud rather than returned
         from silently, which is how this looked like a working save. */
      if (pointId === null) { unpersistable.push(`${id}: aggregate marker, no backend point`); continue; }
      let e = byRun.get(f.runId);
      if (!e) { e = { points: [], dets: [] }; byRun.set(f.runId, e); }
      e.points.push(pointId);
      e.dets.push(id);
    }

    if (unpersistable.length) {
      console.warn(`${unpersistable.length} verdict(s) have nowhere to persist:`, unpersistable.slice(0, 10));
    }
    if (!byRun.size) return;

    const attempted = [...byRun.values()].reduce((n, e) => n + e.dets.length, 0);
    /* Clear a previous failure flag on these rows - this is a fresh attempt,
       and a stale "unsaved" would outlive the problem. Only the rows that
       actually carry one, so the ordinary path writes to the store exactly
       once per gesture rather than twice. */
    flag(
      [...byRun.values()].flatMap(e => e.dets).filter(id => detById.get(id)?.unsaved),
      false,
    );

    void Promise.all(
      [...byRun.entries()].map(async ([runId, e]) => {
        try {
          await editPoints(runId, op, e.points);
          return [] as string[];
        } catch (err) {
          console.warn(`edits did not persist for run ${runId}:`, err);
          return e.dets;
        }
      }),
    ).then((results) => {
      const failed = results.flat();
      if (!failed.length) return;
      flag(failed, true);
      toast.error(
        translate(useLangStore.getState().lang, "store.editsNotSaved", {
          n: failed.length,
          total: attempted,
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
  clearAll: () => {
    for (const f of get().footages) releaseBlob(f.videoUrl);
    set({
      footages: [], detections: [], selectedId: null, pinPoints: [],
      loadedRuns: 0, totalRuns: null, hydrateSkipped: 0, hydrateError: null,
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

    const merge = (f: Footage) => set(s => {
      if (s.footages.some(x => x.id === f.id)) return s;
      return {
        footages: insertRanked(s.footages, f, rank),
        detections: [...s.detections, ...f.detections],
        loadedRuns: s.loadedRuns + 1,
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
        filename: r.filename ?? "(archived survey)",
        size: 0,
        duration: 0,
        /* When the footage was FLOWN, not when the count job ran. `created_at`
           is the job's clock, and a re-processed 2019 sortie carrying today's
           date lands on the wrong end of the timeline. The fallback stays:
           surveys without a capture date are the common case today. */
        uploadedAt: instantFromService(r.captured_at)
          ?? instantFromService(r.created_at)
          ?? new Date().toISOString(),
        track: trk,
        detections,
        center: anchor,
        placed: positioned,
        status: "ready",
        source: "archive",
        runId: r.run_id,
        mediaId: r.media_id ?? undefined,
        videoUrl: r.kind === "video" && r.media_id ? mediaFileUrl(r.media_id) : undefined,
        band: { low: r.low ?? null, best, high: r.high ?? null, basis: r.basis ?? "" },
        unplaced,
        pixels,
        counts: pts.counts ?? undefined,
        verifiedCount: pts.verified_count,
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
      });
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
          const stats = await fetchStats({
            latestPerSurvey: true, limit: HYDRATE_PAGE, offset,
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
    if (get().footages.length > 0) return;
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
