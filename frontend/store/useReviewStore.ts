"use client";
/**
 * useReviewStore — the state of a review PASS, kept outside the screen.
 *
 * Everything the detections drawer needed to know about where a reviewer had
 * got to lived in `useState` inside a body that is mounted only while the
 * dialog is open. Escape — which Radix owns and which a reviewer hits by
 * reflex — unmounted it, so the filter, the sort, the scroll position and the
 * place in the queue were all destroyed by the same keystroke that closed the
 * window. On 1473 animals that is not an inconvenience, it is the reason a
 * pass never finishes.
 *
 * So the pass lives here: it survives a look at the map and (within the
 * session) coming back tomorrow.
 *
 * The drawer itself is gone. Проверка is a MODE now — a screen of its own, at
 * `#review` — so "is the review open" is no longer a boolean this store owns;
 * it is `useMode()`. What is left here is everything about the pass that the
 * mode must not lose when the reviewer walks over to the map and back: which
 * sortie, which filter, which sort, where in the queue, and which of the two
 * shapes of the screen (the frame, or the season-wide table) they work in.
 *
 * Deliberately NOT here: the selection, the "kept" rows and the pending
 * confirmation. Those belong to one gesture on one open screen — carrying an
 * armed 1476-row selection across a mode switch would be a loaded gun in a
 * drawer nobody remembers opening.
 */
import { create } from "zustand";
import { setMode } from "@/lib/modes";

export type ReviewStatusFilter = "all" | "auto" | "validated" | "false_positive" | "unsaved";

/** Sort orders of the detections list. `score_asc` is the default because a
 *  review pass wants the animals the model was least sure about FIRST; with
 *  `score_desc` (the old only-score option) the rows that actually need a
 *  human sit at the bottom of seventy-three screens. */
export type ReviewSort = "date" | "score_desc" | "score_asc" | "unsaved";

export const DEFAULT_REVIEW_SORT: ReviewSort = "score_asc";

/** The two shapes of Проверка.
 *
 *  `frame` is the workspace: one sortie's photograph, every animal on it, a
 *  verdict a keystroke away. It is where a review is meant to happen, and it
 *  is the default.
 *
 *  `table` is the old workbench — every animal of the season as a row, with
 *  bulk verdicts, filters and a CSV. It is triage, not review: it is how you
 *  find the sorties nobody has touched and how you undo a mass mistake, and
 *  losing it would have cost real capability. It is a toggle inside the mode
 *  rather than a screen of its own, because it answers questions ABOUT the
 *  same pass. */
export type ReviewView = "frame" | "table";

export type ReviewState = {
  /** Footage id (`run-<run>`) or bare run id to restrict the pass to; null =
   *  the whole season. Both forms are accepted because the inspector knows the
   *  run id and the store knows the footage id, and neither should have to
   *  learn the other's spelling. */
  runScope: string | null;
  /** Frame workspace or season table. */
  view: ReviewView;
  q: string;
  status: ReviewStatusFilter;
  sort: ReviewSort;
  /** Where the queue walk stopped, and on which sortie. Scoped, so opening a
   *  different sortie starts at its own beginning instead of resuming into the
   *  middle of somebody else's frame. */
  cursor: number;
  cursorScope: string | null;
  /** Pixels down the detections table. Restored on the next open. */
  scrollTop: number;

  /** Go to Проверка. With an id, scope the pass to that sortie — this is the
   *  entry point the inspector's "review this sortie" button calls, and it now
   *  takes the reviewer to the screen as well as aiming it, because there is
   *  no drawer left to pop over what they were looking at. Without an id,
   *  resume exactly where they left off. */
  openReview: (runId?: string) => void;
  setView: (v: ReviewView) => void;
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
  runScope: null,
  view: "frame",
  q: "",
  status: "all",
  sort: DEFAULT_REVIEW_SORT,
  cursor: 0,
  cursorScope: null,
  scrollTop: 0,

  openReview: (runId) => {
    /* The mode change is the "open". It is done through lib/modes rather than
       by anything React so that a store action, a keyboard handler or a future
       timer all reach the same one channel — and it is a no-op when Проверка
       is already on screen, so the Back button keeps meaning "the screen
       before this one". */
    setMode("review");
    if (runId === undefined) return;
    const scope = runId || null;
    set((s) => {
      // A new scope is a new pass: the old scroll offset belongs to a list
      // that no longer exists. The filter and sort are the reviewer's working
      // preference and survive on purpose.
      if (scope === s.runScope) return s;
      return { runScope: scope, scrollTop: 0 };
    });
  },
  setView: (view) => set({ view }),
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
