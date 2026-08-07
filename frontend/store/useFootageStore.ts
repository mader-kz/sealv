"use client";
import { create } from "zustand";
import type { Footage, Detection, TrackPoint, MapLayerState } from "@/lib/types";
import { mockDetections, generateSeedTrack, KZ_SITES } from "@/lib/mock/detections";
import { fetchStats, fetchRunPoints, fetchTrack, pointsToDetections, mediaFileUrl } from "@/lib/api";

type Store = {
  footages: Footage[];
  detections: Detection[];
  selectedId: string | null;
  layerState: MapLayerState;
  pinMode: boolean;
  pinPoints: TrackPoint[];
  timeRange: [number, number];
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
  seedTestData: () => void;
  hydrate: () => Promise<void>;
  clearAll: () => void;
};

export const useFootageStore = create<Store>((set, get) => ({
  footages: [],
  detections: [],
  selectedId: null,
  layerState: { footprints: true, detections: true, clusters: true, heatmap: false },
  pinMode: false,
  pinPoints: [],
  timeRange: [0, 100],
  addFootage: (f) => set(s => ({ footages: [...s.footages, f], detections: [...s.detections, ...f.detections] })),
  removeFootage: (id) => set(s => ({ footages: s.footages.filter(f=>f.id!==id), detections: s.detections.filter(d=>d.footageId!==id), selectedId: s.selectedId===id?null:s.selectedId })),
  select: (id) => set({ selectedId: id }),
  setLayer: (k,v) => set(s=>({ layerState: {...s.layerState, [k]: v }})),
  setPinMode: (v) => set({ pinMode: v }),
  setPinPoints: (pts) => set({ pinPoints: pts }),
  setTimeRange: (r) => set({ timeRange: r }),
  /* The real pipeline lands here: a footage that went up as "processing"
     gets its engine result - detections, band, status - swapped in atomically
     across both lists, so the map never shows a half-updated sortie. */
  completeFootage: (id, patch) => set(s => {
    const dets = patch.detections;
    return {
      footages: s.footages.map(f => f.id === id ? { ...f, ...patch } : f),
      detections: dets
        ? [...s.detections.filter(d => d.footageId !== id), ...dets]
        : s.detections,
    };
  }),
  updateDetection: (id, patch) => set(s=> ({
    detections: s.detections.map(d=> d.id===id ? { ...d, ...patch } : d),
    footages: s.footages.map(f=> ({ ...f, detections: f.detections.map(d=> d.id===id ? { ...d, ...patch } : d) })),
  })),
  bulkUpdateDetections: (ids, patch) => {
    const setIds = new Set(ids);
    set(s=> ({
      detections: s.detections.map(d=> setIds.has(d.id) ? { ...d, ...patch } : d),
      footages: s.footages.map(f=> ({ ...f, detections: f.detections.map(d=> setIds.has(d.id) ? { ...d, ...patch } : d) })),
    }));
  },
  clearAll: () => set({ footages: [], detections: [], selectedId: null, pinPoints: [] }),
  /* Reload yesterday's counts from the service. The store is browser memory;
     the surveys are not - they live in the backend, and losing the map to an
     F5 made the platform look like it forgot the season's work. Only the
     latest run per survey comes back (that is what /v1/stats exposes), only
     into an empty store, and a run with no usable geo at all is skipped: the
     map cannot place it, and flying the camera to (0,0) would be worse than
     leaving it to the analytics view.
     Failures are silent by design - hydration is a convenience, and a fresh
     empty map must not toast errors at someone opening the app offline. */
  hydrate: async () => {
    if (get().footages.length > 0) return;
    let stats: any;
    try { stats = await fetchStats(); } catch { return; }
    const runs: any[] = (stats?.latest_runs ?? []).filter((r: any) => r.run_id);
    const out: Footage[] = [];
    for (const r of runs.slice(0, 20)) {
      try {
        const [points, track] = await Promise.all([
          fetchRunPoints(r.run_id),
          r.media_id ? fetchTrack(r.media_id).catch(() => []) : Promise.resolve([]),
        ]);
        const id = `run-${r.run_id}`;
        const { placed, unplaced } = pointsToDetections(id, points);
        const trk: TrackPoint[] = track.map((p: any) => ({
          t: p.t ?? 0, lat: p.lat, lng: p.lng, alt: p.alt ?? undefined,
        }));
        const best = r.best ?? null;
        let center: { lat: number; lng: number } | null = null;
        if (trk.length) center = trk[Math.floor(trk.length / 2)];
        else if (placed.length) {
          center = {
            lat: placed.reduce((s2, d) => s2 + d.lat, 0) / placed.length,
            lng: placed.reduce((s2, d) => s2 + d.lng, 0) / placed.length,
          };
        }
        if (!center) continue;
        let detections = placed;
        if (!placed.length && best != null && best > 0) {
          detections = [{
            id: `${id}-agg`, footageId: id, t: 0,
            lat: center.lat, lng: center.lng,
            count: best, confidence: 1, status: "auto" as const,
          }];
        }
        out.push({
          id,
          filename: r.filename ?? "(archived survey)",
          size: 0,
          duration: 0,
          uploadedAt: r.created_at ?? new Date().toISOString(),
          track: trk,
          detections,
          center,
          region: center.lat > 44.5 ? "KZ-East" : center.lat > 43.4 ? "KZ-South" : "KZ-North",
          status: "ready",
          source: "archive",
          videoUrl: r.kind === "video" && r.media_id ? mediaFileUrl(r.media_id) : undefined,
          band: { low: r.low ?? null, best, high: r.high ?? null, basis: r.basis ?? "" },
          unplaced,
        });
      } catch {
        /* one unreadable run must not sink the other nineteen */
      }
    }
    if (out.length && get().footages.length === 0) {
      set({ footages: out, detections: out.flatMap(f => f.detections) });
    }
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
        region: site.region,
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
        track, detections: dets, center, region: "KZ-South" as const, status: "ready" as const, source: "test" as const
      } as Footage;
    });
    const all = [...demo, ...extras];
    set({ footages: all, detections: all.flatMap(f=>f.detections) });
  }
}));
