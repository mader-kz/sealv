"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFootageStore } from "@/store/useFootageStore";
import { Button, IconButton, Field, Pill } from "@/components/ui/primitives";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { csvCell, downloadText } from "@/lib/export/animals";
import type { Detection } from "@/lib/types";
import { useT } from "@/lib/i18n";

type SortKey = "date" | "conf";
type StatusFilter = "all" | "auto" | "validated" | "false_positive";
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
   edit log another. */
const restoreTo = (prev: Status): Status => (prev === "false_positive" ? "false_positive" : "validated");

/* The drawer subscribes to nothing while it is shut. It used to derive the
   filtered list, an id array and the select-all flag on every store change
   even when closed — three full passes over every detection of the season for
   a component that then rendered null. Radix owns the shell: Escape, the
   focus trap, aria-modal, outside-click and focus restore come from there
   instead of from a hand-rolled backdrop div with an onClick. */
export default function Workbench({ open, onClose }: { open: boolean; onClose: ()=>void }){
  return (
    <Dialog open={open} onOpenChange={(v)=>{ if(!v) onClose(); }}>
      {open && <WorkbenchBody onClose={onClose} />}
    </Dialog>
  );
}

function WorkbenchBody({ onClose }: { onClose: ()=>void }){
  const { t } = useT();
  const footages = useFootageStore(s=>s.footages);
  const detections = useFootageStore(s=>s.detections);
  const updateDetection = useFootageStore(s=>s.updateDetection);
  const bulkUpdate = useFootageStore(s=>s.bulkUpdateDetections);
  const select = useFootageStore(s=>s.select);

  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<SortKey>("date");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /* Rows the reviewer just ruled on stay in the list for this pass even when
     the status filter no longer matches them. Reviewing with filter=auto — the
     natural review mode — used to delete the row under the cursor on every
     verdict and shift the list up, which is how a mis-click becomes invisible.
     Kept rows render dimmed and still carry their undo button. */
  const [recent, setRecent] = useState<Set<string>>(new Set());
  const [pendingFalse, setPendingFalse] = useState<string[] | null>(null);
  const [lastBulk, setLastBulk] = useState<{ prev: Map<string, Status>; to: Status } | null>(null);

  const footageById = useMemo(()=> new Map(footages.map(f=>[f.id,f])),[footages]);

  const filtered = useMemo(()=>{
    const needle = q.trim().toLowerCase();
    const rows = detections.filter(d=>{
      if (status!=="all" && d.status!==status && !recent.has(d.id)) return false;
      if (!needle) return true;
      const f=footageById.get(d.footageId);
      return d.id.toLowerCase().includes(needle)
        || d.footageId.toLowerCase().includes(needle)
        || (f ? f.filename.toLowerCase().includes(needle) : false);
    });
    rows.sort((a,b)=>{
      // Unscored animals sort last, not first: -1 is below every real score.
      if(sort==="conf") return (scoreOf(b) ?? -1) - (scoreOf(a) ?? -1);
      // date: by footage uploadedAt
      const fa=footageById.get(a.footageId)?.uploadedAt||""; const fb=footageById.get(b.footageId)?.uploadedAt||"";
      return fb.localeCompare(fa);
    });
    return rows;
  },[detections, footageById, q, status, sort, recent]);

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
  useEffect(()=>{
    setRecent(s=> s.size ? new Set() : s);
    setLastBulk(v=> v ? null : v);
    setPendingFalse(v=> v ? null : v);
  },[q, status, sort]);

  /* The selection is pruned to what is actually on screen. It used to survive
     every filter change untouched, so select-all under "all status" followed
     by a search narrowing the list to three rows left 1470 invisible rows
     armed — and the toolbar counted them as if the reviewer had chosen them. */
  useEffect(()=>{
    setSelected(prev=>{
      if (prev.size===0) return prev;
      const keep = new Set<string>();
      for (const d of filtered) if (prev.has(d.id)) keep.add(d.id);
      return keep.size===prev.size ? prev : keep;
    });
  },[filtered]);

  const toggle = useCallback((id:string)=> setSelected(prev=>{
    const s=new Set(prev);
    if(s.has(id)) s.delete(id); else s.add(id);
    return s;
  }),[]);

  const allSelected = total>0 && selected.size>=total && filtered.every(d=>selected.has(d.id));

  /* ------------------------------------------------------------ windowing */
  /* One <tr> here is ~15 elements. Painting all 1473 of the fixture's rows
     the moment the drawer opens is ~22k nodes built synchronously, and the
     stated design target is a season of hundreds of sorties. Only the visible
     slice is mounted; two spacer rows of computed height stand in for the
     rest, so the scrollbar and the scroll position stay truthful. */
  const [rowH, setRowH] = useState(ROW_H);
  const [range, setRange] = useState<{start:number; end:number}>({start:0, end:0});

  const recompute = useCallback(()=>{
    const el = listEl;
    if(!el) return;
    const h = el.clientHeight || 1;
    const start = Math.max(0, Math.floor(el.scrollTop / rowH) - OVERSCAN);
    const end = Math.min(total, Math.ceil((el.scrollTop + h) / rowH) + OVERSCAN);
    setRange(r => (r.start===start && r.end===end) ? r : { start, end });
  },[listEl, rowH, total]);

  useEffect(()=>{
    const el = listEl;
    if(!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(()=> recompute());
    ro.observe(el);
    return ()=> ro.disconnect();
  },[listEl, recompute]);

  /* One post-render pass over the scroller, pre-paint so the first frame
     already carries the right slice, and in a single effect so it costs one
     forced reflow rather than three:
       1. a new filter scrolls back to the top — and it must happen BEFORE the
          window is chosen, or the slice is picked for the old scroll offset
          and the reviewer stares at a blank strip until they nudge the wheel;
       2. rowH is measured off a real row rather than trusted from the
          constant, so the spacers cannot drift out of step with the content
          (self-correcting; the 0.5px guard closes the feedback loop);
       3. the window is recomputed from the live scrollTop and height. */
  const firstRowRef = useRef<HTMLTableRowElement | null>(null);
  const passRef = useRef("");
  const measuredRef = useRef(false);
  /* Rows are mounted, so there is something to measure. Read off `range`
     rather than `visible`, which is derived below this effect. */
  const hasRows = range.end > range.start;
  useLayoutEffect(()=>{
    const el = listEl;
    if(!el) return;
    const pass = `${q} ${status} ${sort}`;
    const passChanged = passRef.current !== pass;
    if (passChanged){
      passRef.current = pass;
      if (el.scrollTop !== 0) el.scrollTop = 0;
      measuredRef.current = false;
    }
    /* Measure ONCE per list, not once per render. getBoundingClientRect is a
       synchronous reflow, and this effect used to carry no dependency array —
       so every scroll event (recompute -> setRange -> render) paid a forced
       layout on top of re-rendering the slice. A row's height only changes
       when the pass or the mount does, which is what these deps cover. */
    if (!measuredRef.current){
      const row = firstRowRef.current;
      if (row){
        const h = row.getBoundingClientRect().height;
        if (h > 8){
          measuredRef.current = true;
          // Re-render on the corrected height; this pass runs again right after.
          if (Math.abs(h - rowH) > 0.5){ setRowH(h); return; }
        }
      }
    }
    recompute();
    // rowH is compared, not tracked: setRowH changes `recompute`'s identity,
    // which re-runs this effect anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[listEl, recompute, q, status, sort, hasRows]);

  /* One recompute per frame while scrolling. A trackpad fling fires scroll
     events faster than React can render, and each one read scrollTop and set
     state; the map overlay coalesces the same way. */
  const rafRef = useRef(0);
  const onScroll = useCallback(()=>{
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(()=>{ rafRef.current = 0; recompute(); });
  },[recompute]);
  useEffect(()=> ()=> { if (rafRef.current) cancelAnimationFrame(rafRef.current); },[]);

  const start = Math.max(0, Math.min(range.start, total));
  const end = Math.max(start, Math.min(range.end, total));
  const visible = filtered.slice(start, end);
  const padTop = start * rowH;
  const padBottom = Math.max(0, (total - end) * rowH);

  /* ------------------------------------------------------------- verdicts */
  const verdict = (d: Detection)=>{
    /* Restore writes "validated", not "auto". "auto" never reached the
       service — the store maps it to no operation at all — so undoing a false
       positive was a UI gesture with no effect: after a reload the animal was
       gone from the map, from the counts and from the exports. */
    const to: Status = d.status==="false_positive" ? "validated" : "false_positive";
    updateDetection(d.id, { status: to });
    setRecent(s=> s.has(d.id) ? s : new Set(s).add(d.id));
  };

  const visibleSelectedIds = useCallback(
    ()=> filtered.filter(d=>selected.has(d.id)).map(d=>d.id),
    [filtered, selected],
  );

  const applyBulk = useCallback((ids: string[], to: Status)=>{
    if (!ids.length) return;
    const want = new Set(ids);
    const prev = new Map<string, Status>();
    for (const d of filtered) if (want.has(d.id)) prev.set(d.id, d.status);
    bulkUpdate(ids, { status: to });
    setRecent(s=> { const n=new Set(s); for(const id of ids) n.add(id); return n; });
    setLastBulk({ prev, to });
    setSelected(new Set());
    setPendingFalse(null);
  },[filtered, bulkUpdate]);

  /* Only the rows an undo would genuinely move. A bulk validate over rows that
     were "auto" has no inverse the service can record, and offering an Undo
     button that quietly does nothing would be the same lie in a friendlier
     shape. */
  const undoIds = useMemo(()=>{
    if(!lastBulk) return [] as Array<[string, Status]>;
    return [...lastBulk.prev].filter(([,st])=> restoreTo(st) !== lastBulk.to);
  },[lastBulk]);

  const undoBulk = ()=>{
    const toFalse = undoIds.filter(([,st])=> restoreTo(st)==="false_positive").map(([id])=>id);
    const toValid = undoIds.filter(([,st])=> restoreTo(st)==="validated").map(([id])=>id);
    if (toFalse.length) bulkUpdate(toFalse, { status:"false_positive" });
    if (toValid.length) bulkUpdate(toValid, { status:"validated" });
    setLastBulk(null);
  };

  /* --------------------------------------------------------------- export */
  const exportCSV = ()=>{
    /* csvCell/downloadText from the animals exporter: a comma in a filename
       used to split the row, the exact bug that export already fixed once. */
    const rows=["id,footageId,filename,t,lat,lng,score,status"];
    for(const d of filtered){
      const f=footageById.get(d.footageId);
      rows.push([
        csvCell(d.id), csvCell(d.footageId), csvCell(f?.filename ?? ""),
        csvCell(d.t), csvCell(d.lat), csvCell(d.lng),
        csvCell(scoreOf(d)), csvCell(d.status),
      ].join(","));
    }
    downloadText(`sealv-detections-${new Date().toISOString().slice(0,10)}.csv`, "text/csv", rows.join("\n"));
  };

  const showOnMap = (d: Detection)=>{
    const f = footageById.get(d.footageId);
    const lat = Number.isFinite(d.lat) ? d.lat : f?.center.lat;
    const lng = Number.isFinite(d.lng) ? d.lng : f?.center.lng;
    select(d.footageId);
    /* `flyto` on document is the app's one camera channel. `zoom` is a hint:
       a listener that ignores it still lands on the animal. */
    if (lat != null && lng != null) {
      document.dispatchEvent(new CustomEvent("flyto", { detail: { lat, lng, zoom: 11 } }));
    }
    onClose();
  };

  const th = "px-3 py-2 label font-normal";

  return (
    <DialogContent
      aria-describedby={undefined}
      className="left-auto right-0 top-0 translate-x-0 translate-y-0 h-full w-[94vw] max-w-[940px] p-0 gap-0 flex flex-col overflow-hidden bg-surface border-0 border-l border-line rounded-none sm:rounded-none shadow-pop"
    >
      <DialogHeader className="h-11 shrink-0 border-b border-line flex-row items-center text-left space-y-0 px-4 pr-12 gap-3">
        <DialogTitle className="text-base font-medium text-ink tracking-normal">{t("nav.detections")}</DialogTitle>
        <span className="text-xs text-ink3 tnum">
          {t("wb.ofTotal", { a: total, b: detections.length })}{selected.size>0 && ` · ${t("wb.selected", { n: selected.size })}`}
        </span>
        <div className="flex-1" />
        <Button icon="download" onClick={exportCSV}>{t("btn.exportCsv")}</Button>
      </DialogHeader>

      <div className="px-4 py-2.5 border-b border-line flex flex-wrap items-center gap-2">
        <div className="w-56"><Field value={q} onChange={setQ} placeholder={t("wb.filter")} icon="search" /></div>
        <select
          aria-label={t("wb.status")}
          value={status}
          onChange={e=>setStatus(e.target.value as StatusFilter)}
          className="h-7 bg-surface2 border border-line rounded px-2 text-xs text-ink2"
        >
          <option value="all">{t("wb.allStatus")}</option>
          <option value="auto">{t("status.auto")}</option>
          <option value="validated">{t("status.validated")}</option>
          <option value="false_positive">{t("status.falsePositive")}</option>
        </select>
        <select
          aria-label={t("wb.sortBy")}
          value={sort}
          onChange={e=>setSort(e.target.value as SortKey)}
          className="h-7 bg-surface2 border border-line rounded px-2 text-xs text-ink2"
        >
          <option value="date">{t("wb.sortDate")}</option>
          <option value="conf">{t("wb.sortConf")}</option>
        </select>
        <div className="flex-1" />
        {selected.size>0 && !pendingFalse && (
          <div className="flex items-center gap-1.5">
            <Button icon="check" onClick={()=> applyBulk(visibleSelectedIds(), "validated")}>{t("wb.validate")}</Button>
            <Button onClick={()=>{
              const ids = visibleSelectedIds();
              if (!ids.length) return;
              if (ids.length > CONFIRM_ABOVE) setPendingFalse(ids); else applyBulk(ids, "false_positive");
            }}>{t("wb.markFalse")}</Button>
            <Button variant="ghost" onClick={()=> setSelected(new Set())}>{t("btn.clear")}</Button>
          </div>
        )}
      </div>

      {/* A destructive bulk names its exact size before it fires. */}
      {pendingFalse && (
        <div className="px-4 py-2 border-b border-line bg-surface2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink2">{t("wb.confirmFalse", { n: pendingFalse.length })}</span>
          <div className="flex-1" />
          <Button variant="primary" onClick={()=> applyBulk(pendingFalse, "false_positive")}>{t("btn.confirm")}</Button>
          <Button variant="ghost" onClick={()=> setPendingFalse(null)}>{t("btn.cancel")}</Button>
        </div>
      )}

      {/* The write is already persisted, so the undo is a real inverse verdict
          sent to the service, not a hidden local rollback. */}
      {lastBulk && !pendingFalse && (
        <div className="px-4 py-2 border-b border-line flex items-center gap-2">
          <span className="text-xs text-ink2 tnum">{t("wb.bulkDone", { n: lastBulk.prev.size })}</span>
          {undoIds.length>0 && <Button onClick={undoBulk}>{t("wb.undo")}</Button>}
          <div className="flex-1" />
          <IconButton name="close" title={t("btn.close")} onClick={()=> setLastBulk(null)} />
        </div>
      )}

      <div ref={setListEl} onScroll={onScroll} className="flex-1 overflow-auto">
        {/* table-fixed: with only a window of rows mounted, auto layout would
            re-measure the columns against each slice and the header would
            jitter under the reviewer's eyes as they scroll. */}
        <table className="w-full min-w-[816px] text-sm table-fixed" aria-rowcount={total+1}>
          <thead className="sticky top-0 bg-surface border-b border-line z-10 text-left">
            <tr aria-rowindex={1}>
              <th className="pl-4 pr-2 py-2 w-11">
                <input
                  type="checkbox"
                  aria-label={t("wb.selectAll")}
                  ref={el=>{ if(el) el.indeterminate = selected.size>0 && !allSelected; }}
                  className="accent-[color:var(--accent)]"
                  checked={allSelected}
                  onChange={e=>{ setSelected(e.target.checked ? new Set(filtered.map(d=>d.id)) : new Set()); }}
                />
              </th>
              <th className={th}>{t("nav.footage")}</th>
              <th className={`${th} text-right w-[76px]`}>{t("wb.score")}</th>
              <th className={`${th} w-[88px]`}>{t("wb.status")}</th>
              <th className={`${th} w-[128px]`}>{t("wb.coords")}</th>
              <th className={`${th} w-[280px]`}></th>
            </tr>
          </thead>
          <tbody>
            {padTop>0 && (
              <tr aria-hidden="true" style={{ height: padTop }}>
                <td colSpan={6} className="p-0 border-0" style={{ height: padTop }} />
              </tr>
            )}
            {visible.map((d,i)=>{
              const f=footageById.get(d.footageId);
              const isSel = selected.has(d.id);
              // Ruled on during this pass and no longer matching the filter.
              const kept = status!=="all" && d.status!==status && recent.has(d.id);
              const score = scoreOf(d);
              const name = f?.filename || d.footageId;
              return (
                <tr
                  key={d.id}
                  ref={i===0 ? firstRowRef : undefined}
                  aria-rowindex={start + i + 2}
                  title={kept ? t("wb.kept") : undefined}
                  className={`border-b border-line-soft transition-colors ${isSel ? "bg-surface2" : "hover:bg-surface2/60"} ${(d.status==="false_positive" || kept) ? "opacity-45" : ""}`}
                >
                  <td className="pl-4 pr-2 py-2">
                    <input
                      type="checkbox"
                      aria-label={t("wb.selectRow")}
                      className="accent-[color:var(--accent)]"
                      checked={isSel}
                      onChange={()=> toggle(d.id)}
                    />
                  </td>
                  <td className="px-3 py-2 font-mono text-ink truncate" title={name}>{name}</td>
                  {/* raw model score, not a percentage: it is not a calibrated probability */}
                  <td className="px-3 py-2 text-right text-ink2 tnum">
                    {score===null ? <span title={t("wb.noScore")}>—</span> : score.toFixed(2)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {/* A verdict the service refused. The store keeps the
                        reviewer's decision on screen, which is right — but a
                        row that did not reach the archive must not look
                        identical to one that did, or the reviewer walks away
                        believing work is saved that is not. */}
                    {d.unsaved && (
                      <span
                        className="inline-block w-1.5 h-1.5 rounded-full bg-bad mr-1.5 align-middle"
                        title={t("wb.unsaved")}
                        aria-label={t("wb.unsaved")}
                      />
                    )}
                    <Pill tone={d.status==="validated" ? "good" : "neutral"}>
                      {d.status==="false_positive" ? t("status.falseShort") : d.status==="validated" ? t("status.validatedL") : t("status.autoL")}
                    </Pill>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-ink3 tnum">{d.lat.toFixed(3)}, {d.lng.toFixed(3)}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1 justify-end">
                      <Button variant="ghost" className="whitespace-nowrap" onClick={()=> showOnMap(d)}>{t("wb.showOnMap")}</Button>
                      <Button variant="ghost" className="whitespace-nowrap" onClick={()=> verdict(d)}>
                        {d.status==="false_positive" ? t("wb.restore") : t("wb.markFalse")}
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {padBottom>0 && (
              <tr aria-hidden="true" style={{ height: padBottom }}>
                <td colSpan={6} className="p-0 border-0" style={{ height: padBottom }} />
              </tr>
            )}
            {total===0 && (
              <tr><td colSpan={6} className="px-4 py-16 text-center text-sm text-ink3">{t("wb.noMatch")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </DialogContent>
  );
}
