"use client";
/* What the environment layer is currently showing, and nothing else.
 *
 * Deliberately its own store rather than a third flag on `layerState`: the
 * environment carries a MOMENT, a chosen field and a fetch of its own, and
 * folding that into the sortie store would put a network request behind every
 * counts render. Toggling this layer must not disturb a single chip.
 *
 * The moment is held as an explicit ISO instant, `null` meaning "now". The
 * distinction matters: a pinned moment must not drift while the tab is open,
 * and "now" must not freeze at page load.
 */
import { create } from "zustand";
import { fetchEnvGrid, fetchEnvAt, type EnvGrid, type EnvAt } from "@/lib/env";

/** A layer's identity on the wire: one source, one variable. Never a variable
 *  alone — MUR and CoralTemp both measure sst_c and they disagree. */
export const layerKey = (source: string, v: string) => `${source}|${v}`;

export type EnvState = {
  enabled: boolean;
  /** ISO instant, or null for "now" (resolved at fetch time). */
  time: string | null;
  /** `source|var` of the field drawn as cells, or null = pick the finest
   *  available. Never "the temperature": the source is half the identity. */
  field: string | null;
  /** Wind arrows, independent of the cell field — they are a different mark
   *  at a different scale and stacking them is the point. */
  wind: boolean;

  grid: EnvGrid | null;
  loading: boolean;
  error: string | null;
  /** The instant the loaded grid was requested for. `grid.time` echoes it, but
   *  this survives a failed reload, so the panel never labels an old grid with
   *  a new moment. */
  loadedFor: string | null;

  /** The "every source at this point" probe, opened by clicking a cell. */
  probe: EnvAt | null;
  probeLoading: boolean;
  probeError: string | null;

  setEnabled: (v: boolean) => void;
  setTime: (iso: string | null) => void;
  setField: (key: string | null) => void;
  setWind: (v: boolean) => void;
  /** Fetch the grid for the current moment. Safe to call repeatedly: an
   *  in-flight request is aborted and only the newest response is kept. */
  load: () => Promise<void>;
  probeAt: (lat: number, lng: number) => Promise<void>;
  clearProbe: () => void;
};

let gridAbort: AbortController | null = null;
let gridSeq = 0;
let probeAbort: AbortController | null = null;
let probeSeq = 0;

export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export const useEnvStore = create<EnvState>((set, get) => ({
  enabled: false,
  time: null,
  field: null,
  wind: true,

  grid: null,
  loading: false,
  error: null,
  loadedFor: null,

  probe: null,
  probeLoading: false,
  probeError: null,

  setEnabled: (v) => {
    set({ enabled: v });
    if (v) void get().load();
    else {
      /* Leaving the layer drops the probe but keeps the grid: coming back to a
         layer that is still showing the moment you left it on is worth more
         than the few hundred kilobytes, and the panel re-states the slice
         times anyway. */
      try { gridAbort?.abort(); } catch {}
      gridAbort = null;
      set({ probe: null, probeError: null, loading: false });
    }
  },
  setTime: (iso) => {
    set({ time: iso, probe: null, probeError: null });
    if (get().enabled) void get().load();
  },
  setField: (key) => set({ field: key }),
  setWind: (v) => set({ wind: v }),

  load: async () => {
    const seq = ++gridSeq;
    try { gridAbort?.abort(); } catch {}
    const ac = new AbortController();
    gridAbort = ac;
    const when = get().time ?? nowIso();
    set({ loading: true, error: null });
    try {
      const grid = await fetchEnvGrid({ time: when, signal: ac.signal });
      if (seq !== gridSeq) return; // a newer request won
      set({ grid, loading: false, error: null, loadedFor: when });
    } catch (e: any) {
      if (seq !== gridSeq || e?.name === "AbortError") return;
      /* The grid is NOT cleared on a failure. Blanking it would replace a
         labelled slice with an unlabelled emptiness that looks exactly like
         "no environment here". The old grid keeps its own timestamps and the
         panel shows the error next to it. */
      set({ loading: false, error: String(e?.message ?? e) });
    }
  },

  probeAt: async (lat, lng) => {
    const seq = ++probeSeq;
    try { probeAbort?.abort(); } catch {}
    const ac = new AbortController();
    probeAbort = ac;
    set({ probeLoading: true, probeError: null, probe: null });
    try {
      const at = await fetchEnvAt({
        lat,
        lng,
        time: get().time ?? get().loadedFor ?? nowIso(),
        signal: ac.signal,
      });
      if (seq !== probeSeq) return;
      set({ probe: at, probeLoading: false });
    } catch (e: any) {
      if (seq !== probeSeq || e?.name === "AbortError") return;
      set({ probeLoading: false, probeError: String(e?.message ?? e) });
    }
  },

  clearProbe: () => {
    try { probeAbort?.abort(); } catch {}
    probeAbort = null;
    set({ probe: null, probeError: null, probeLoading: false });
  },
}));
