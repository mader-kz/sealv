"use client";
/**
 * useReviewStore — the state of a review PASS, kept outside the drawer.
 *
 * Everything the detections drawer needed to know about where a reviewer had
 * got to lived in `useState` inside a body that is mounted only while the
 * dialog is open. Escape — which Radix owns and which a reviewer hits by
 * reflex — unmounted it, so the filter, the sort, the scroll position and the
 * place in the queue were all destroyed by the same keystroke that closed the
 * window. On 1473 animals that is not an inconvenience, it is the reason a
 * pass never finishes.
 *
 * So the pass lives here: it survives the drawer closing, a look at the map,
 * and (within the session) reopening tomorrow.
 *
 * Deliberately NOT here: the selection, the "kept" rows and the pending
 * confirmation. Those belong to one gesture inside one open drawer — carrying
 * an armed 1476-row selection across a close and back would be a loaded gun in
 * a drawer nobody remembers opening.
 */
import { create } from "zustand";

export type ReviewStatusFilter = "all" | "auto" | "validated" | "false_positive" | "unsaved";

/** Sort orders of the detections list. `score_asc` is the default because a
 *  review pass wants the animals the model was least sure about FIRST; with
 *  `score_desc` (the old only-score option) the rows that actually need a
 *  human sit at the bottom of seventy-three screens. */
export type ReviewSort = "date" | "score_desc" | "score_asc" | "unsaved";

export const DEFAULT_REVIEW_SORT: ReviewSort = "score_asc";

export type ReviewState = {
  /** Is the detections drawer up. */
  open: boolean;
  /** Footage id (`run-<run>`) or bare run id to restrict the pass to; null =
   *  the whole season. Both forms are accepted because the inspector knows the
   *  run id and the store knows the footage id, and neither should have to
   *  learn the other's spelling. */
  runScope: string | null;
  q: string;
  status: ReviewStatusFilter;
  sort: ReviewSort;
  /** Where the Evidence walk stopped, and on which sortie. Scoped, so opening
   *  a different sortie starts at its own beginning instead of resuming into
   *  the middle of somebody else's frame. */
  cursor: number;
  cursorScope: string | null;
  /** Pixels down the detections list. Restored on the next open. */
  scrollTop: number;

  /** Open the drawer. With an id, scope the pass to that sortie — this is the
   *  entry point an inspector's "review this sortie" button calls. Without
   *  one, resume exactly where the reviewer left off. */
  openReview: (runId?: string) => void;
  close: () => void;
  setQ: (q: string) => void;
  setStatus: (s: ReviewStatusFilter) => void;
  setSort: (s: ReviewSort) => void;
  setRunScope: (id: string | null) => void;
  setCursor: (i: number, scope?: string | null) => void;
  setScrollTop: (px: number) => void;
};

const clampIndex = (i: number): number => {
  const n = Math.floor(Number(i));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export const useReviewStore = create<ReviewState>((set) => ({
  open: false,
  runScope: null,
  q: "",
  status: "all",
  sort: DEFAULT_REVIEW_SORT,
  cursor: 0,
  cursorScope: null,
  scrollTop: 0,

  openReview: (runId) =>
    set((s) => {
      if (runId === undefined) return { open: true };
      const scope = runId || null;
      // A new scope is a new pass: the old scroll offset belongs to a list
      // that no longer exists. The filter and sort are the reviewer's working
      // preference and survive on purpose.
      if (scope === s.runScope) return { open: true };
      return { open: true, runScope: scope, scrollTop: 0 };
    }),
  close: () => set({ open: false }),
  setQ: (q) => set({ q: String(q ?? "") }),
  setStatus: (status) => set({ status }),
  setSort: (sort) => set({ sort }),
  setRunScope: (id) =>
    set((s) => (id === s.runScope ? s : { runScope: id || null, scrollTop: 0 })),
  setCursor: (i, scope) =>
    set((s) => ({
      cursor: clampIndex(i),
      cursorScope: scope === undefined ? s.cursorScope : scope,
    })),
  setScrollTop: (px) => set({ scrollTop: Math.max(0, Number(px) || 0) }),
}));
