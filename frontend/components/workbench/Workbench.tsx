"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFootageStore } from "@/store/useFootageStore";
import {
  useReviewStore,
  type ReviewSort,
  type ReviewStatusFilter,
} from "@/store/useReviewStore";
import { isAggregateMarker, reviewStats, seasonReviewStats } from "@/lib/analytics/review";
import { Button, IconButton, Field, Pill } from "@/components/ui/primitives";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { csvCell, downloadText } from "@/lib/export/animals";
import type { Detection, Footage } from "@/lib/types";
import { useT } from "@/lib/i18n";

type Status = Detection["status"];

/* First guess at the row height (a 28px button inside a py-2 cell plus the
   1px rule). It is only a seed: the real height is measured off the first
   rendered row, so a font swap or a density change can never desync the
   spacer rows from the content they stand in for. */
const ROW_H = 45;
/* Rows rendered above and below the viewport. Enough that a fast flick never
   shows blank space before the next scroll event lands. */
const OVERSCAN = 8;
/* Above this many rows a destructive bulk verdict asks first. Small enough
   that one slip of the select-all checkbox cannot quietly rewrite a season,
   large enough that reviewing a handful of animals stays one click. */
const CONFIRM_ABOVE = 25;

/* A score the model never produced is not a score of zero. `?? 0` upstream is
   why unscored animals used to print "0.00" and sort below genuinely bad
   detections. Written to compile whether `confidence` is `number` or
   `number | null`. */
const scoreOf = (d: Detection): number | null =>
  typeof d.confidence === "number" && Number.isFinite(d.confidence) ? d.confidence : null;

/* The service records exactly two operator verdicts: `remove` writes
   false_positive, `reinstate` writes validated (service/db.py apply_edit).
   "auto" is a state a point can leave but can never be put back into. So
   undoing a verdict means validated — what the server will say the point is —
   and never "auto", which would leave the client asserting one thing and the
   edit log another. That is also why no control in this table says "Restore":
   the word describes putting something back, and the write it performs is a
   human certification of an animal nobody has looked at. Wave 2 adds the
   service op that would make "restore" true; until then the buttons say what
   they write. */
const restoreTo = (prev: Status): Status => (prev === "false_positive" ? "false_positive" : "validated");

/** Short, sayable run id for the sortie picker. Three of the fixture's sorties
 *  are the same filename; without this there is no way to tell them apart in
 *  the UI at all. */
const shortRun = (f: Footage): string => (f.runId ?? f.id.replace(/^run-/, "")).slice(0, 8);

/* The drawer subscribes to nothing while it is shut. It used to derive the
   filtered list, an id array and the select-all flag on every store change
   even when closed — three full passes over every detection of the season for
   a component that then rendered null. Radix owns the shell: Escape, the
   focus trap, aria-modal, outside-click and focus restore come from there
   instead of from a hand-rolled backdrop div with an onClick.

   The pass itself is no longer in here. Escape unmounts this body, and with it
   used to go the filter, the sort, the scroll offset and the reviewer's place
   in 1473 animals — one reflex keystroke, a whole session's bearings. It lives
   in useReviewStore now; this component only draws it. */
export default function Workbench({ open, onClose }: { open?: boolean; onClose?: () => void }) {
  const storeOpen = useReviewStore((s) => s.open);
  const openReview = useReviewStore((s) => s.openReview);
  const closeReview = useReviewStore((s) => s.close);

  /* Two ways in: the rail button (a boolean on the page) and openReview() from
     anywhere else. The prop is mirrored into the store rather than or-ed with
     it, or the rail's toggle would stop being able to close a drawer that the
     store had opened. */
  const prevProp = useRef(Boolean(open));
  useEffect(() => {
    const v = Boolean(open);
    if (v === prevProp.current) return;
    prevProp.current = v;
    if (v) openReview();
    else closeReview();
  }, [open, openReview, closeReview]);

  const handleClose = useCallback(() => {
    closeReview();
    onClose?.();
  }, [closeReview, onClose]);

  return (
    <Dialog open={storeOpen} onOpenChange={(v) => { if (!v) handleClose(); }}>
      {storeOpen && <WorkbenchBody onClose={handleClose} />}
    </Dialog>
  );
}

function WorkbenchBody({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const footages = useFootageStore((s) => s.footages);
  const detections = useFootageStore((s) => s.detections);
  const updateDetection = useFootageStore((s) => s.updateDetection);
  const bulkUpdate = useFootageStore((s) => s.bulkUpdateDetections);
  const select = useFootageStore((s) => s.select);
  /* Package C adds `verdictsInFlight` to the footage store; read defensively
     so this drawer renders correctly with or without it. The batch PATCH is
     deliberately not awaited, so without a signal here closing the tab
     mid-write looks exactly like a finished pass. */
  const saving = useFootageStore((s) => Number((s as any).verdictsInFlight ?? 0) > 0);

  const q = useReviewStore((s) => s.q);
  const setQ = useReviewStore((s) => s.setQ);
  const status = useReviewStore((s) => s.status);
  const setStatus = useReviewStore((s) => s.setStatus);
  const sort = useReviewStore((s) => s.sort);
  const setSort = useReviewStore((s) => s.setSort);
  const runScope = useReviewStore((s) => s.runScope);
  const setRunScope = useReviewStore((s) => s.setRunScope);
  /* Read once, never subscribed: the scroll offset is written on every frame
     of a fling, and a subscription would re-render the table on each one. */
  const setScrollTop = useReviewStore((s) => s.setScrollTop);
  const savedScroll = useRef(useReviewStore.getState().scrollTop);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  /* Rows the reviewer just ruled on stay in the list for this pass even when
     the status filter no longer matches them. Reviewing with filter=auto — the
     natural review mode — used to delete the row under the cursor on every
     verdict and shift the list up, which is how a mis-click becomes invisible.
     Kept rows render dimmed and still carry their undo button. */
  const [recent, setRecent] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<{ ids: string[]; to: Status } | null>(null);
  const [lastBulk, setLastBulk] = useState<{ prev: Map<string, Status>; to: Status } | null>(null);
  /* Which row the keyboard is on, as an index into the filtered list. */
  const [focusIdx, setFocusIdx] = useState<number | null>(null);

  const footageById = useMemo(() => new Map(footages.map((f) => [f.id, f])), [footages]);

  /* Scope: one sortie or the season. Matched on either spelling of the id —
     the inspector knows the run id, the store knows the footage id. */
  const inScope = useCallback(
    (footageIdOfRow: string) => {
      if (!runScope) return true;
      if (footageIdOfRow === runScope) return true;
      return footageById.get(footageIdOfRow)?.runId === runScope;
    },
    [runScope, footageById],
  );

  const scopeFootages = useMemo(
    () => (runScope ? footages.filter((f) => inScope(f.id)) : footages),
    [footages, runScope, inScope],
  );
  /* The picker is keyed by footage id, but the inspector's "review this
     sortie" button hands over a bare RUN id — the only id it has. Resolve it,
     or the list would be scoped to one sortie while the control above it
     showed "All sorties". */
  const scopeValue = runScope ? (scopeFootages[0]?.id ?? runScope) : "";
  /* A scope that matches nothing in the store — a run that did not hydrate.
     It gets its own option, or the picker would read "All sorties" over an
     empty list and choosing "All sorties" would fire no change at all,
     leaving the reviewer stuck. */
  const scopeUnresolved = !!runScope && scopeFootages.length === 0;
  const scopeDetections = useMemo(
    () => (runScope ? detections.filter((d) => inScope(d.footageId)) : detections),
    [detections, runScope, inScope],
  );

  /* Review progress for whatever the drawer is currently showing. `pct` is
     null when there is nothing to review, and that is printed as such: "0%
     reviewed" over a sortie the product cannot offer a reviewer is an
     accusation, not a measurement. */
  const stats = useMemo(() => seasonReviewStats(scopeFootages), [scopeFootages]);
  const statsByFootage = useMemo(() => {
    const m = new Map<string, ReturnType<typeof reviewStats>>();
    for (const f of footages) m.set(f.id, reviewStats(f));
    return m;
  }, [footages]);

  const unsavedRows = useMemo(() => scopeDetections.filter((d) => d.unsaved), [scopeDetections]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = scopeDetections.filter((d) => {
      if (status === "unsaved") {
        if (!d.unsaved && !recent.has(d.id)) return false;
      } else if (status !== "all" && d.status !== status && !recent.has(d.id)) {
        return false;
      }
      if (!needle) return true;
      const f = footageById.get(d.footageId);
      return d.id.toLowerCase().includes(needle)
        || d.footageId.toLowerCase().includes(needle)
        || (f ? f.filename.toLowerCase().includes(needle) : false);
    });
    const dateOf = (d: Detection) => footageById.get(d.footageId)?.uploadedAt || "";
    rows.sort((a, b) => {
      if (sort === "score_asc" || sort === "score_desc") {
        const x = scoreOf(a);
        const y = scoreOf(b);
        /* Unscored last in BOTH directions. A point the model never scored is
           not a point it scored zero, and worst-first exists to put the
           animals a human must look at on screen one — not the ones there is
           nothing to say about. */
        if (x === null && y === null) return a.id.localeCompare(b.id);
        if (x === null) return 1;
        if (y === null) return -1;
        return (sort === "score_asc" ? x - y : y - x) || a.id.localeCompare(b.id);
      }
      if (sort === "unsaved") {
        const d = Number(!!b.unsaved) - Number(!!a.unsaved);
        if (d) return d;
      }
      return dateOf(b).localeCompare(dateOf(a)) || a.id.localeCompare(b.id);
    });
    return rows;
  }, [scopeDetections, footageById, q, status, sort, recent]);

  const total = filtered.length;
  /* The scroller as STATE, not a ref. DialogContent does not commit its
     children on the drawer's first render, so a ref is still null when the
     layout effect below first runs - and with a dependency array that effect
     never ran again, which left the table showing nothing but its bottom
     spacer until the reviewer happened to scroll. A callback ref into state
     re-runs every effect at the moment the element actually attaches. */
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);

  /* A new filter is a new pass: the retained rows, the undo offer and the
     pending confirmation all belong to the previous one. (The scroll position
     is reset by the layout pass below, before the window is chosen.) */
  useEffect(() => {
    setRecent((s) => (s.size ? new Set() : s));
    setLastBulk((v) => (v ? null : v));
    setConfirming((v) => (v ? null : v));
    setFocusIdx(null);
  }, [q, status, sort, runScope]);

  /* The selection is pruned to what is actually on screen. It used to survive
     every filter change untouched, so select-all under "all status" followed
     by a search narrowing the list to three rows left 1470 invisible rows
     armed — and the toolbar counted them as if the reviewer had chosen them. */
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const keep = new Set<string>();
      for (const d of filtered) if (prev.has(d.id)) keep.add(d.id);
      return keep.size === prev.size ? prev : keep;
    });
  }, [filtered]);

  const toggle = useCallback((id: string) => setSelected((prev) => {
    const s = new Set(prev);
    if (s.has(id)) s.delete(id); else s.add(id);
    return s;
  }), []);

  /* The aggregate marker is not a row anyone can rule on: it stands for a
     whole run's animals and has no point behind it. It is excluded from
     select-all so a season-wide gesture cannot appear to certify it. */
  const selectableIds = useMemo(
    () => filtered.filter((d) => !isAggregateMarker(d)).map((d) => d.id),
    [filtered],
  );
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  /* ------------------------------------------------------------ windowing */
  /* One <tr> here is ~15 elements. Painting all 1473 of the fixture's rows
     the moment the drawer opens is ~22k nodes built synchronously, and the
     stated design target is a season of hundreds of sorties. Only the visible
     slice is mounted; two spacer rows of computed height stand in for the
     rest, so the scrollbar and the scroll position stay truthful. */
  const [rowH, setRowH] = useState(ROW_H);
  const [range, setRange] = useState<{ start: number; end: number }>({ start: 0, end: 0 });

  const recompute = useCallback(() => {
    const el = listEl;
    if (!el) return;
    const h = el.clientHeight || 1;
    const start = Math.max(0, Math.floor(el.scrollTop / rowH) - OVERSCAN);
    const end = Math.min(total, Math.ceil((el.scrollTop + h) / rowH) + OVERSCAN);
    setRange((r) => (r.start === start && r.end === end) ? r : { start, end });
  }, [listEl, rowH, total]);

  useEffect(() => {
    const el = listEl;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => recompute());
    ro.observe(el);
    return () => ro.disconnect();
  }, [listEl, recompute]);

  /* One post-render pass over the scroller, pre-paint so the first frame
     already carries the right slice, and in a single effect so it costs one
     forced reflow rather than three:
       1. a new pass scrolls back to the top — and it must happen BEFORE the
          window is chosen, or the slice is picked for the old scroll offset
          and the reviewer stares at a blank strip until they nudge the wheel.
          The FIRST pass is the exception: it restores where the reviewer
          stopped, which is the whole point of hoisting the offset out of here;
       2. rowH is measured off a real row rather than trusted from the
          constant, so the spacers cannot drift out of step with the content
          (self-correcting; the 0.5px guard closes the feedback loop);
       3. the window is recomputed from the live scrollTop and height. */
  const firstRowRef = useRef<HTMLTableRowElement | null>(null);
  const passRef = useRef<string | null>(null);
  const measuredRef = useRef(false);
  /* Rows are mounted, so there is something to measure. Read off `range`
     rather than `visible`, which is derived below this effect. */
  const hasRows = range.end > range.start;
  useLayoutEffect(() => {
    const el = listEl;
    if (!el) return;
    const pass = `${q} ${status} ${sort} ${runScope ?? ""}`;
    const first = passRef.current === null;
    const passChanged = passRef.current !== pass;
    if (passChanged) {
      passRef.current = pass;
      measuredRef.current = false;
      if (first) {
        // Clamped to the list we actually have: yesterday's offset over a
        // shorter list would leave the reviewer past the end of it.
        const max = Math.max(0, total * rowH - el.clientHeight);
        const want = Math.min(savedScroll.current, max);
        if (Math.abs(el.scrollTop - want) > 0.5) el.scrollTop = want;
      } else {
        if (el.scrollTop !== 0) el.scrollTop = 0;
        setScrollTop(0);
      }
    }
    /* Measure ONCE per list, not once per render. getBoundingClientRect is a
       synchronous reflow, and this effect used to carry no dependency array —
       so every scroll event (recompute -> setRange -> render) paid a forced
       layout on top of re-rendering the slice. A row's height only changes
       when the pass or the mount does, which is what these deps cover. */
    if (!measuredRef.current) {
      const row = firstRowRef.current;
      if (row) {
        const h = row.getBoundingClientRect().height;
        if (h > 8) {
          measuredRef.current = true;
          // Re-render on the corrected height; this pass runs again right after.
          if (Math.abs(h - rowH) > 0.5) { setRowH(h); return; }
        }
      }
    }
    recompute();
    // rowH and total are compared, not tracked: setRowH changes `recompute`'s
    // identity, which re-runs this effect anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listEl, recompute, q, status, sort, runScope, hasRows]);

  /* One recompute per frame while scrolling. A trackpad fling fires scroll
     events faster than React can render, and each one read scrollTop and set
     state; the map overlay coalesces the same way. */
  const rafRef = useRef(0);
  const onScroll = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      recompute();
      if (listEl) setScrollTop(listEl.scrollTop);
    });
  }, [recompute, listEl, setScrollTop]);
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  const start = Math.max(0, Math.min(range.start, total));
  const end = Math.max(start, Math.min(range.end, total));
  const visible = filtered.slice(start, end);
  const padTop = start * rowH;
  const padBottom = Math.max(0, (total - end) * rowH);

  /* Keyboard pass over the table. The focused row is moved by index and the
     window is scrolled to contain it first — with only thirty rows mounted,
     focusing row 900 means mounting it. */
  const wantFocus = useRef<number | null>(null);
  useEffect(() => {
    const idx = wantFocus.current;
    if (idx === null || !listEl) return;
    const el = listEl.querySelector<HTMLElement>(`[data-row="${idx}"]`);
    if (el) { el.focus(); wantFocus.current = null; }
  });
  const moveFocus = useCallback((next: number) => {
    if (!total) return;
    const i = Math.max(0, Math.min(total - 1, next));
    setFocusIdx(i);
    wantFocus.current = i;
    const el = listEl;
    if (el) {
      const top = i * rowH;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + rowH > el.scrollTop + el.clientHeight) el.scrollTop = top + rowH - el.clientHeight;
    }
  }, [total, listEl, rowH]);

  /* ------------------------------------------------------------- verdicts */
  /* One entry point, and it names the status it writes. The old single
     `verdict()` toggled between the two, which is how a button labelled
     "Restore" came to write "a human confirmed this". */
  const rule = useCallback((d: Detection, to: Status) => {
    if (isAggregateMarker(d)) return;
    if (d.status === to) return;
    updateDetection(d.id, { status: to });
    setRecent((s) => (s.has(d.id) ? s : new Set(s).add(d.id)));
  }, [updateDetection]);

  const visibleSelectedIds = useCallback(
    () => filtered.filter((d) => selected.has(d.id) && !isAggregateMarker(d)).map((d) => d.id),
    [filtered, selected],
  );

  const applyBulk = useCallback((ids: string[], to: Status) => {
    if (!ids.length) return;
    const want = new Set(ids);
    const prev = new Map<string, Status>();
    for (const d of filtered) if (want.has(d.id)) prev.set(d.id, d.status);
    bulkUpdate(ids, { status: to });
    setRecent((s) => { const n = new Set(s); for (const id of ids) n.add(id); return n; });
    setLastBulk({ prev, to });
    setSelected(new Set());
    setConfirming(null);
  }, [filtered, bulkUpdate]);

  /* A mass VALIDATE always asks. It is the one gesture in the product that
     manufactures the headline number the whole thing is judged on — and it has
     no inverse: `undoIds` correctly refuses to offer an Undo for it, because
     the service cannot put a point back to "auto". Two clicks and a season is
     certified by nobody. The confirmation names the figure and the sorties. */
  const requestBulk = useCallback((to: Status) => {
    const ids = visibleSelectedIds();
    if (!ids.length) return;
    if (to === "validated" || ids.length > CONFIRM_ABOVE) setConfirming({ ids, to });
    else applyBulk(ids, to);
  }, [visibleSelectedIds, applyBulk]);

  const confirmingSorties = useMemo(() => {
    if (!confirming) return 0;
    const want = new Set(confirming.ids);
    const runs = new Set<string>();
    for (const d of filtered) if (want.has(d.id)) runs.add(d.footageId);
    return runs.size;
  }, [confirming, filtered]);

  /* Only the rows an undo would genuinely move. A bulk validate over rows that
     were "auto" has no inverse the service can record, and offering an Undo
     button that quietly does nothing would be the same lie in a friendlier
     shape. */
  const undoIds = useMemo(() => {
    if (!lastBulk) return [] as Array<[string, Status]>;
    return [...lastBulk.prev].filter(([, st]) => restoreTo(st) !== lastBulk.to);
  }, [lastBulk]);

  const undoBulk = () => {
    const toFalse = undoIds.filter(([, st]) => restoreTo(st) === "false_positive").map(([id]) => id);
    const toValid = undoIds.filter(([, st]) => restoreTo(st) === "validated").map(([id]) => id);
    if (toFalse.length) bulkUpdate(toFalse, { status: "false_positive" });
    if (toValid.length) bulkUpdate(toValid, { status: "validated" });
    setLastBulk(null);
  };

  /* Re-send exactly the rows the service refused, grouped by the verdict they
     carry. Nothing else is touched: a retry that re-sent the whole list would
     be a second mass write dressed as a repair. */
  const retryUnsaved = () => {
    const byStatus = new Map<Status, string[]>();
    for (const d of unsavedRows) {
      const arr = byStatus.get(d.status);
      if (arr) arr.push(d.id); else byStatus.set(d.status, [d.id]);
    }
    for (const [st, ids] of byStatus) bulkUpdate(ids, { status: st });
  };

  /* --------------------------------------------------------------- export */
  const exportCSV = () => {
    /* csvCell/downloadText from the animals exporter: a comma in a filename
       used to split the row, the exact bug that export already fixed once. */
    const rows = ["id,footageId,filename,t,lat,lng,score,status"];
    for (const d of filtered) {
      const f = footageById.get(d.footageId);
      rows.push([
        csvCell(d.id), csvCell(d.footageId), csvCell(f?.filename ?? ""),
        csvCell(d.t), csvCell(d.lat), csvCell(d.lng),
        csvCell(scoreOf(d)), csvCell(d.status),
      ].join(","));
    }
    downloadText(`sealv-detections-${new Date().toISOString().slice(0, 10)}.csv`, "text/csv", rows.join("\n"));
  };

  const showOnMap = (d: Detection) => {
    const f = footageById.get(d.footageId);
    const lat = Number.isFinite(d.lat) ? d.lat : f?.center.lat;
    const lng = Number.isFinite(d.lng) ? d.lng : f?.center.lng;
    select(d.footageId);
    /* `flyto` on document is the app's one camera channel. `zoom` is a hint:
       a listener that ignores it still lands on the animal. */
    if (lat != null && lng != null) {
      document.dispatchEvent(new CustomEvent("flyto", { detail: { lat, lng, zoom: 11 } }));
    }
    /* The drawer does close — it is a modal over an opaque scrim, and aiming
       the camera at an animal nobody can see would be a button that does
       nothing. What it no longer costs is the pass: the filter, the sort, the
       scroll offset and the walk cursor are in useReviewStore, so reopening
       lands on the same row rather than at the top of seventy-three screens. */
    onClose();
  };

  /* Column heads are plain-case labels, not letter-spaced small caps: the
     table's hierarchy is the rule under the head and the alignment of the
     figures, not a typographic costume on the word. */
  const th = "px-3 py-2 label font-normal";
  /* The toolbar's controls are ruled, not boxed — one line under the value,
     the same object as the search field beside them. */
  const control =
    "h-7 bg-transparent border-0 border-b border-line px-0 text-xs text-ink2 " +
    "hover:border-ink4 focus:border-ink2 transition-colors";
  const progressText = stats.pct === null
    ? t("wb.reviewNothing")
    : t("wb.reviewProgress", { n: stats.verified, m: stats.reviewable, pct: Math.round(stats.pct) });

  return (
    <DialogContent
      aria-describedby={undefined}
      className="left-auto right-0 top-0 translate-x-0 translate-y-0 h-full w-[94vw] max-w-[940px] p-0 gap-0 flex flex-col overflow-hidden bg-surface border-0 border-l border-line rounded-none sm:rounded-none shadow-pop"
    >
      <DialogHeader className="h-11 shrink-0 border-b border-line flex-row items-center text-left space-y-0 px-4 pr-12 gap-3">
        {/* The drawer's one large word. Everything else in the header steps
            down to 11px, which is what lets a 17px title do the work a rule
            and a fill used to. */}
        <DialogTitle className="text-title font-semibold text-ink">{t("nav.detections")}</DialogTitle>
        <span className="text-xs text-ink3 tnum">
          {t("wb.ofTotal", { a: total, b: scopeDetections.length })}
          {selected.size > 0 && ` · ${t("wb.selected", { n: selected.size })}`}
        </span>
        {unsavedRows.length > 0 && (
          <span className="text-xs text-bad tnum">{t("wb.unsavedCount", { n: unsavedRows.length })}</span>
        )}
        {saving && <span className="text-xs text-ink3">{t("wb.saving")}</span>}
        <div className="flex-1" />
        <Button icon="download" onClick={exportCSV}>{t("btn.exportCsv")}</Button>
      </DialogHeader>

      {/* How much of what is in scope a human has actually ruled on, and how
          much of it this build cannot show a human at all. */}
      <div className="px-4 py-1.5 border-b border-line flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs text-ink2 tnum">{progressText}</span>
        {stats.unreviewable > 0 && (
          <span className="text-2xs text-ink3" title={t("wb.noMapPositionWhy")}>
            {t("wb.noMapPosition", { n: stats.unreviewable })}
          </span>
        )}
        <div className="flex-1" />
        <span className="text-2xs text-ink3 hidden sm:block">{t("wb.keyHint")}</span>
      </div>

      <div className="px-4 py-2.5 border-b border-line flex flex-wrap items-center gap-2">
        <div className="w-56"><Field value={q} onChange={setQ} placeholder={t("wb.filter")} icon="search" /></div>
        {/* Three of the fixture's sorties share a filename and the run id was
            nowhere in the UI, so isolating one meant exporting the GeoJSON. */}
        <select
          aria-label={t("wb.scope")}
          value={scopeValue}
          onChange={(e) => setRunScope(e.target.value || null)}
          className={`${control} max-w-[280px]`}
        >
          <option value="">{t("wb.scopeAll")}</option>
          {scopeUnresolved && <option value={runScope as string}>{runScope}</option>}
          {footages.map((f) => {
            const st = statsByFootage.get(f.id);
            const reviewed = st && st.reviewable > 0 ? ` · ${st.verified}/${st.reviewable}` : "";
            return (
              <option key={f.id} value={f.id}>
                {`${f.filename} · ${shortRun(f)}${reviewed}`}
              </option>
            );
          })}
        </select>
        <select
          aria-label={t("wb.status")}
          value={status}
          onChange={(e) => setStatus(e.target.value as ReviewStatusFilter)}
          className={control}
        >
          <option value="all">{t("wb.allStatus")}</option>
          <option value="auto">{t("status.auto")}</option>
          <option value="validated">{t("status.validated")}</option>
          <option value="false_positive">{t("status.falsePositive")}</option>
          <option value="unsaved">{t("wb.statusUnsaved")}</option>
        </select>
        <select
          aria-label={t("wb.sortBy")}
          value={sort}
          onChange={(e) => setSort(e.target.value as ReviewSort)}
          className={control}
        >
          <option value="score_asc">{t("wb.sortScoreAsc")}</option>
          <option value="score_desc">{t("wb.sortScoreDesc")}</option>
          <option value="date">{t("wb.sortDate")}</option>
          <option value="unsaved">{t("wb.sortUnsavedFirst")}</option>
        </select>
        {unsavedRows.length > 0 && (
          <Button icon="alert" onClick={retryUnsaved}>{t("wb.retryUnsaved")}</Button>
        )}
        <div className="flex-1" />
        {selected.size > 0 && !confirming && (
          <div className="flex items-center gap-1.5">
            {/* A verdict button carries its verdict's colour, and only on
                hover — at rest the toolbar stays monochrome. The important
                modifier is load-bearing: the shared Button already declares a
                `hover:text-ink`, and which of two same-specificity rules wins
                would otherwise depend on the order Tailwind happened to emit
                them in. */}
            <Button
              icon="check"
              onClick={() => requestBulk("validated")}
              title={t("wb.markVerifiedWhy")}
              className="hover:!text-good hover:!border-good"
            >
              {t("wb.markVerified")}
            </Button>
            <Button
              onClick={() => requestBulk("false_positive")}
              title={t("wb.markFalseWhy")}
              className="hover:!text-bad hover:!border-bad"
            >
              {t("wb.markFalse")}
            </Button>
            <Button variant="ghost" onClick={() => setSelected(new Set())}>{t("btn.clear")}</Button>
          </div>
        )}
      </div>

      {/* A bulk verdict names its exact size — and, for a certification, the
          number of sorties it is about to sign for — before it fires. */}
      {confirming && (
        <div className="px-4 py-2 border-b border-line flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink2">
            {confirming.to === "validated"
              ? t("wb.confirmValidate", { n: confirming.ids.length, m: confirmingSorties })
              : t("wb.confirmFalse", { n: confirming.ids.length })}
          </span>
          <div className="flex-1" />
          <Button variant="primary" onClick={() => applyBulk(confirming.ids, confirming.to)}>{t("btn.confirm")}</Button>
          <Button variant="ghost" onClick={() => setConfirming(null)}>{t("btn.cancel")}</Button>
        </div>
      )}

      {/* The write is already persisted, so the undo is a real inverse verdict
          sent to the service, not a hidden local rollback. */}
      {lastBulk && !confirming && (
        <div className="px-4 py-2 border-b border-line flex items-center gap-2">
          <span className="text-xs text-ink2 tnum">{t("wb.bulkDone", { n: lastBulk.prev.size })}</span>
          {undoIds.length > 0 && <Button onClick={undoBulk}>{t("wb.undo")}</Button>}
          <div className="flex-1" />
          <IconButton name="close" title={t("btn.close")} onClick={() => setLastBulk(null)} />
        </div>
      )}

      <div ref={setListEl} onScroll={onScroll} className="flex-1 overflow-auto">
        {/* table-fixed: with only a window of rows mounted, auto layout would
            re-measure the columns against each slice and the header would
            jitter under the reviewer's eyes as they scroll. */}
        <table className="w-full min-w-[880px] text-sm table-fixed" aria-rowcount={total + 1}>
          <thead className="sticky top-0 bg-surface border-b border-line z-10 text-left">
            <tr aria-rowindex={1}>
              <th className="pl-4 pr-2 py-2 w-11">
                <input
                  type="checkbox"
                  aria-label={t("wb.selectAll")}
                  ref={(el) => { if (el) el.indeterminate = selected.size > 0 && !allSelected; }}
                  /* Checkboxes are neutral. Selecting rows is not a live state
                     and not the standing estimate, which is all the signal
                     colour is for; a screenful of green boxes would spend it
                     on the least meaningful thing on the panel. */
                  className="accent-[color:var(--ink-2)]"
                  checked={allSelected}
                  onChange={(e) => { setSelected(e.target.checked ? new Set(selectableIds) : new Set()); }}
                />
              </th>
              <th className={th}>{t("nav.footage")}</th>
              <th className={`${th} text-right w-[76px]`}>{t("wb.score")}</th>
              <th className={`${th} w-[88px]`}>{t("wb.status")}</th>
              <th className={`${th} w-[128px]`}>{t("wb.coords")}</th>
              <th className={`${th} w-[300px]`}></th>
            </tr>
          </thead>
          <tbody>
            {padTop > 0 && (
              <tr aria-hidden="true" style={{ height: padTop }}>
                <td colSpan={6} className="p-0 border-0" style={{ height: padTop }} />
              </tr>
            )}
            {visible.map((d, i) => {
              const rowIdx = start + i;
              const f = footageById.get(d.footageId);
              const isSel = selected.has(d.id);
              const agg = isAggregateMarker(d);
              // Ruled on during this pass and no longer matching the filter.
              const kept = status !== "all" && d.status !== status && recent.has(d.id);
              const score = scoreOf(d);
              const name = f?.filename || d.footageId;
              const unreviewable = agg ? (statsByFootage.get(d.footageId)?.unreviewable ?? d.count) : 0;
              return (
                <tr
                  key={d.id}
                  ref={i === 0 ? firstRowRef : undefined}
                  data-row={rowIdx}
                  tabIndex={(focusIdx === null ? rowIdx === 0 : rowIdx === focusIdx) ? 0 : -1}
                  onFocus={() => setFocusIdx(rowIdx)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown") { e.preventDefault(); moveFocus(rowIdx + 1); return; }
                    if (e.key === "ArrowUp") { e.preventDefault(); moveFocus(rowIdx - 1); return; }
                    if (agg) return;
                    /* Read off `code` as well as `key`: on the Cyrillic layout
                       two thirds of this product's users type, the physical V
                       key emits "м". */
                    if (e.code === "KeyV" || e.key.toLowerCase() === "v") { e.preventDefault(); rule(d, "validated"); return; }
                    if (e.code === "KeyX" || e.key.toLowerCase() === "x") { e.preventDefault(); rule(d, "false_positive"); }
                  }}
                  aria-rowindex={rowIdx + 2}
                  title={kept ? t("wb.kept") : undefined}
                  /* Hover and selection share the one quiet fill; what marks a
                     SELECTED row is the bar down its left edge (drawn on the
                     first cell, below, so it composes with the focus ring
                     instead of fighting it). The keyboard's row wears the
                     app's one focus colour rather than the signal green —
                     walking a table is not a live state.

                     The old pair was `bg-surface2` against `bg-surface2/60`,
                     and the /60 half generated no CSS at all: Tailwind cannot
                     put an alpha on a colour declared as a bare `var(--x)`, so
                     hovering a row had been doing nothing since the token
                     rename. */
                  className={`border-b border-hair transition-colors outline-none focus:shadow-[inset_0_0_0_1px_var(--ink-2)] ${isSel ? "bg-hover" : "hover:bg-hover"} ${(d.status === "false_positive" || kept) ? "opacity-45" : ""}`}
                >
                  <td className={`pl-4 pr-2 py-2 ${isSel ? "shadow-[inset_2px_0_0_var(--ink)]" : ""}`}>
                    {/* No checkbox on the aggregate marker: there is nothing
                        behind it a bulk verdict could write to. */}
                    {!agg && (
                      <input
                        type="checkbox"
                        aria-label={t("wb.selectRow")}
                        className="accent-[color:var(--ink-2)]"
                        checked={isSel}
                        onChange={() => toggle(d.id)}
                      />
                    )}
                  </td>
                  {/* A filename is prose, not a hash — it is set in the same
                      face as everything else. The monospace face is reserved
                      for run/survey ids, where reading character by character
                      is the actual task. */}
                  <td className="px-3 py-2 text-ink truncate" title={`${name} · ${f ? shortRun(f) : d.footageId}`}>
                    {name}
                  </td>
                  {/* raw model score, not a percentage: it is not a calibrated probability */}
                  <td className="px-3 py-2 text-right text-ink2 tnum">
                    {score === null ? <span title={t("wb.noScore")}>—</span> : score.toFixed(2)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {/* A verdict the service refused. The store keeps the
                        reviewer's decision on screen, which is right — but a
                        row that did not reach the archive must not look
                        identical to one that did, or the reviewer walks away
                        believing work is saved that is not.

                        A square tick, not a round lamp — and it stays a mark
                        rather than becoming the sentence, because the sentence
                        is forty characters wide and this column is 88px. The
                        header carries the count in words; here the job is only
                        "this row is not the same as its neighbours". */}
                    {d.unsaved && (
                      <span
                        className="inline-block w-[5px] h-[5px] bg-bad mr-1.5 align-middle"
                        title={t("wb.unsaved")}
                        aria-label={t("wb.unsaved")}
                      />
                    )}
                    {/* Both verdicts keep their semantic colour; "auto" is not
                        a verdict and stays quiet. */}
                    <Pill tone={d.status === "validated" ? "good" : d.status === "false_positive" ? "bad" : "neutral"}>
                      {d.status === "false_positive" ? t("status.falseShort") : d.status === "validated" ? t("status.validatedL") : t("status.autoL")}
                    </Pill>
                  </td>
                  {/* Coordinates are figures: Inter with tabular numerals lines
                      the column up without a typewriter face. */}
                  <td className="px-3 py-2 text-xs text-ink3 tnum">
                    {Number.isFinite(d.lat) && Number.isFinite(d.lng)
                      ? `${d.lat.toFixed(3)}, ${d.lng.toFixed(3)}`
                      : t("misc.notPlaced")}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1 justify-end">
                      {agg ? (
                        /* Non-actionable by construction, and it says why in
                           the same words the dashboard uses. */
                        <span className="text-2xs text-ink3 text-right leading-tight" title={t("wb.noMapPositionWhy")}>
                          {t("wb.noMapPosition", { n: unreviewable })}
                        </span>
                      ) : (
                        <>
                          <Button variant="ghost" className="whitespace-nowrap" onClick={() => showOnMap(d)}>{t("wb.showOnMap")}</Button>
                          {/* Both verdicts, side by side. The affirmative one
                              used to cost a checkbox plus a 700px round trip
                              to a toolbar button — and the product's whole
                              verified share depends on that one. */}
                          <Button
                            variant="ghost"
                            className="whitespace-nowrap hover:!text-good"
                            disabled={d.status === "validated"}
                            title={d.status === "validated" ? t("wb.alreadyVerified") : t("wb.markVerifiedWhy")}
                            onClick={() => rule(d, "validated")}
                          >
                            {t("wb.markVerified")}
                          </Button>
                          <Button
                            variant="ghost"
                            className="whitespace-nowrap hover:!text-bad"
                            disabled={d.status === "false_positive"}
                            title={d.status === "false_positive" ? t("wb.alreadyFalse") : t("wb.markFalseWhy")}
                            onClick={() => rule(d, "false_positive")}
                          >
                            {t("wb.markFalse")}
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {padBottom > 0 && (
              <tr aria-hidden="true" style={{ height: padBottom }}>
                <td colSpan={6} className="p-0 border-0" style={{ height: padBottom }} />
              </tr>
            )}
            {total === 0 && (
              <tr><td colSpan={6} className="px-4 py-16 text-center text-sm text-ink3">{t("wb.noMatch")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </DialogContent>
  );
}
