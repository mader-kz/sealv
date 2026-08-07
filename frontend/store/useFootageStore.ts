"use client";
import { create } from "zustand";
import type { Footage, Detection, TrackPoint, MapLayerState } from "@/lib/types";
import { mockDetections, generateSeedTrack, KZ_SITES } from "@/lib/mock/detections";

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
  updateDetection: (id: string, patch: Partial<Pick<Detection, "count" | "status">>) => void;
  bulkUpdateDetections: (ids: string[], patch: Partial<Pick<Detection, "count" | "status">>) => void;
  seedTestData: () => void;
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
