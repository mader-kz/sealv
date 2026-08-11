"use client";
/**
 * ArchiveMode — Съёмки. Every sortie of the season as one line, full height.
 *
 * This is the list half of the old LeftPanel, grown out of a 340px column into
 * a screen. Nothing about the rows changed in kind — one line, scannable,
 * windowed — but at full width the facts that used to be squeezed out of the
 * row (the band, the basis the count rests on) fit next to the figure they
 * qualify, under a header that names each column. The panel's other half (the
 * season's headline estimate and surveyed area) did NOT come with it: that is
 * the season strip on Карта, and printing a second copy of the season total
 * over a list of sorties is how two screens come to disagree.
 *
 * What lives here, because it lived on the panel and has nowhere else to be:
 *   · search over filename / site name / sortie id
 *   · CSV export of exactly what the search is showing
 *   · a ground count (rec.manual.open → ManualCount)
 *   · retire-with-a-reason on each row
 *   · the ⋯ overflow: show withdrawn sorties, clear the season
 *   · the seed button, while the season is empty
 * Row click SELECTS; the shell puts the inspector beside this screen, which is
 * where retirement's undo, notes, metadata, corrections, the edit history and
 * the purge already live. The camera is a separate, explicit affordance on the
 * row — a click that both selected a row and threw you onto the map would make
 * this screen impossible to read down.
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFootageStore } from "@/store/useFootageStore";
import { Button, Field, Pill } from "@/components/ui/primitives";
import Icon from "@/components/ui/Icon";
import Timeline from "@/components/layout/Timeline";
import ManualCount from "@/components/record/ManualCount";
import { basisText, useT } from "@/lib/i18n";
import { countOf } from "@/lib/analytics/count";
import { footagesInRange, formatDate } from "@/lib/analytics/brush";
import { hasResult, isPlaced } from "@/lib/analytics/surveys";
import { reviewStats } from "@/lib/analytics/review";
import { csvCell, downloadText } from "@/lib/export/animals";
import { REASON_MAX } from "@/lib/api";

/* Nominal row height, px — only close enough to pick a first slice; the real
   height is measured off the first rendered row. One line per sortie. */
const ROW_H = 37;
/* Rows kept above and below the viewport. Also absorbs the sticky header. */
const OVERSCAN = 6;

/* The column rhythm, written once so the header captions and the rows cannot
   drift apart. Everything but the name is fixed-width and right-aligned where
   it is a figure — tabular digits only line up if their cell does too. The
   last three columns fold away under 1024px rather than crushing the name. */
const COL = {
  when: "w-[72px] shrink-0",
  review: "w-[56px] shrink-0 text-right",
  count: "w-[64px] shrink-0 text-right",
  range: "w-[92px] shrink-0 text-right hidden lg:block",
  basis: "w-[132px] shrink-0 hidden xl:block",
  act: "w-[40px] shrink-0",
};

export default function ArchiveMode(){
  const { t, tp, lang } = useT();
  const footages = useFootageStore(s=>s.footages);
  const selectedId = useFootageStore(s=>s.selectedId);
  const select = useFootageStore(s=>s.select);
  const retireFootage = useFootageStore(s=>s.retireFootage);
  const seedTestData = useFootageStore(s=>s.seedTestData);
  const clearAll = useFootageStore(s=>s.clearAll);
  const timeRange = useFootageStore(s=>s.timeRange);
  const hydrating = useFootageStore(s=>s.hydrating);

  const [q, setQ] = useState("");
  /* Retiring asks for a REASON, not a confirmation. "Why is this flight not
     part of the season" is the only part of a retirement worth anything a year
     later, and a bare yes/no records none of it. */
  const [pendingRetire, setPendingRetire] = useState<string|null>(null);
  const [retireReason, setRetireReason] = useState("");
  const [retireError, setRetireError] = useState<string|null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [pendingClear, setPendingClear] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement|null>(null);

  useEffect(()=>{
    /* Closing forgets a half-answered "clear everything?". Every route out —
       the button, Escape, a click elsewhere — lands here, so the confirm can
       never be waiting behind a closed menu. */
    if(!menuOpen){ setPendingClear(false); return; }
    const onPointer = (e: MouseEvent)=>{
      if(menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent)=>{ if(e.key==="Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return ()=>{
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  },[menuOpen]);

  const inWindow = useMemo(()=> footagesInRange(footages, timeRange), [footages,timeRange]);
  /* Withdrawn sorties are out of every figure — that is what withdrawing one
     means — but they are not out of the ARCHIVE, and this screen is the
     archive. They stay one toggle away, struck through, saying so. */
  const retiredInWindow = useMemo(()=> inWindow.filter(f=> !!f.retiredAt), [inWindow]);
  const live = useMemo(()=> inWindow.filter(f=> !f.retiredAt), [inWindow]);
  const listed = useMemo(
    ()=> (showRetired ? [...live, ...retiredInWindow] : live),
    [live, retiredInWindow, showRetired],
  );

  const filtered = useMemo(()=>{
    const needle = q.trim().toLowerCase();
    if(!needle) return listed;
    return listed.filter(f=>
      f.filename.toLowerCase().includes(needle)
      || (f.siteName ?? "").toLowerCase().includes(needle)
      || f.id.toLowerCase().includes(needle)
      || (f.surveyId ?? "").toLowerCase().includes(needle)
      || (f.band?.basis ?? "").toLowerCase().includes(needle));
  },[listed,q]);

  /* Per-sortie summary, exactly what the search is showing. A failed ingest is
     not a row of survey data — exporting one puts a line of empty columns into
     a spreadsheet somebody will average. Withdrawn sorties are exported only
     when they are shown, and then carry `retiredAt` so a reader can tell why
     the total does not match the row count. */
  const exportCSV = ()=>{
    const rows = ["id,surveyId,filename,siteName,uploadedAt,capturedAt,centerLat,centerLng,locationSource,trackPts,detections,seals,low,best,high,basis,engine,validated,auto,unplaced,areaM2,gsdSource,source,operator,retiredAt,notes"];
    for(const f of filtered.filter(hasResult)){
      const area = f.areaM2;
      rows.push([
        // Empty cells, not NaN: a spreadsheet reads NaN as a value, and this
        // sortie has no measured position to report.
        f.id, csvCell(f.surveyId ?? ""), csvCell(f.filename), csvCell(f.siteName ?? ""),
        f.uploadedAt, csvCell(f.capturedAt ?? ""),
        isPlaced(f) ? f.center.lat : "", isPlaced(f) ? f.center.lng : "",
        csvCell(f.locationSource ?? ""),
        f.track.length,
        // "detections" everywhere else in this app means the animals review
        // KEPT, so a false positive is not one of them here either.
        f.detections.filter(d=>d.status!=="false_positive").length,
        countOf(f),
        f.band?.low ?? "", f.band?.best ?? "", f.band?.high ?? "", csvCell(f.band?.basis ?? ""),
        csvCell(f.engine ?? ""),
        f.detections.filter(d=>d.status==="validated").length,
        f.detections.filter(d=>d.status==="auto").length,
        f.unplaced ?? 0,
        typeof area==="number" && Number.isFinite(area) ? area : "",
        // An assumed scale next to the area it produced: a reader outside this
        // app has no other way to tell a measured hectare from a guessed one.
        csvCell(f.gsdSource ?? ""),
        f.source,
        csvCell(f.operator ?? ""),
        csvCell(f.retiredAt ?? ""),
        csvCell(f.notes ?? ""),
      ].join(","));
    }
    downloadText(`sealv-footage-${new Date().toISOString().slice(0,10)}.csv`, "text/csv", rows.join("\n"));
  };

  /* ---------------------------------------------------------- windowing */
  /* Hundreds of sorties per season is the design target, and every one of them
     used to mount a dozen elements the moment the panel opened. Only the
     visible slice is mounted; two spacers of computed height stand in for the
     rest so the scrollbar and the scroll position stay truthful. */
  const total = filtered.length;
  /* The scroller as STATE, not a ref: an effect with a dependency array can
     only see the element if it re-runs when the element attaches. */
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const firstRowRef = useRef<HTMLDivElement | null>(null);
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

  const passRef = useRef("");
  const measuredRef = useRef(false);
  const hasRows = range.end > range.start;
  useLayoutEffect(()=>{
    const el = listEl;
    if(!el) return;
    /* A new search scrolls back to the top BEFORE the slice is chosen, or the
       window is picked for the old offset and the reader stares at a blank
       strip until they nudge the wheel. */
    if (passRef.current !== q){
      passRef.current = q;
      if (el.scrollTop !== 0) el.scrollTop = 0;
      measuredRef.current = false;
    }
    /* Measured once per list, not per render: getBoundingClientRect forces a
       synchronous reflow, and scrolling renders. */
    if (!measuredRef.current){
      const row = firstRowRef.current;
      if (row){
        const h = row.getBoundingClientRect().height;
        if (h > 8){
          measuredRef.current = true;
          if (Math.abs(h - rowH) > 0.5){ setRowH(h); return; }
        }
      }
    }
    recompute();
    // rowH is compared, not tracked: setRowH changes recompute's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[listEl, recompute, q, hasRows]);

  const rafRef = useRef(0);
  const onScroll = useCallback(()=>{
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(()=>{ rafRef.current = 0; recompute(); });
  },[recompute]);
  useEffect(()=> ()=> { if (rafRef.current) cancelAnimationFrame(rafRef.current); },[]);

  const winStart = Math.max(0, Math.min(range.start, total));
  const winEnd = Math.max(winStart, Math.min(range.end, total));
  const visible = filtered.slice(winStart, winEnd);
  const padTop = winStart * rowH;
  const padBottom = Math.max(0, (total - winEnd) * rowH);

  /* The one camera channel. Raised from here it leaves this screen — the shell
     switches to Карта and replays it until the map answers — so it is its own
     control with its own label, never a side effect of selecting a row. */
  const flyTo = (lat:number, lng:number)=>{
    if(!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    document.dispatchEvent(new CustomEvent("flyto", { detail:{ lat, lng, zoom: 10 } }));
  };

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col">
      {/* ------------------------------------------------------- page head */}
      <div className="shrink-0 px-6 pt-5">
        <div className="flex items-baseline gap-4 min-w-0">
          <h1 className="text-page text-ink shrink-0">{t("nav.footage")}</h1>
          <p className="text-xs text-ink3 min-w-0 leading-relaxed">{t("arch.lead")}</p>
        </div>

        <div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <div className="flex w-full min-w-0 flex-1 sm:w-auto sm:max-w-[520px]">
            <Field value={q} onChange={setQ} placeholder={t("arch.search")} icon="search" />
          </div>
          {footages.length>0 && (
            <span className="text-2xs text-ink3 tnum shrink-0">
              {t("est.showingOf", { n: filtered.length, m: listed.length })}
            </span>
          )}
          <span className="hidden flex-1 sm:block" />
          <div className="flex flex-wrap items-center gap-2">
            <Button icon="download" onClick={exportCSV} title={t("left.exportCsvTitle")} />
            {/* A count a person made is a survey too, and for most of this
                coastline it is the only way a count has ever been made. */}
            <Button icon="plus" onClick={()=> setManualOpen(true)}>{t("rec.manual.open")}</Button>
            {footages.length>0 && (
              <div className="relative shrink-0" ref={menuRef}>
                <button
                  onClick={()=> setMenuOpen(v=>!v)}
                  aria-label={t("left.more")}
                  aria-expanded={menuOpen}
                  aria-controls="arch-more"
                  title={t("left.more")}
                  className={`h-9 w-9 sm:h-7 sm:w-7 grid place-items-center border transition-colors ${
                    menuOpen ? "border-ink4 text-ink bg-surface2" : "border-line text-ink2 hover:text-ink hover:border-ink4 hover:bg-surface2"
                  }`}
                >
                  <span aria-hidden="true" className="text-sm leading-none -translate-y-[3px]">···</span>
                </button>
                {menuOpen && (
                  <div id="arch-more" className="plate absolute right-0 top-8 z-30 w-[228px] p-1 shadow-pop">
                    {retiredInWindow.length>0 && (
                      <button
                        onClick={()=>{ setShowRetired(v=>!v); setMenuOpen(false); }}
                        className="w-full text-left px-2 py-1.5 text-xs text-ink2 hover:bg-surface2 hover:text-ink transition-colors"
                      >
                        {showRetired
                          ? t("rec.retire.hide", { n: retiredInWindow.length })
                          : t("rec.retire.show", { n: retiredInWindow.length })}
                      </button>
                    )}
                    {pendingClear ? (
                      /* Discarding the season's work took one click on a 10px
                         link. It still asks, and it asks here. */
                      <div className="px-2 py-1.5 space-y-1.5">
                        <p className="text-2xs text-ink2 leading-relaxed">{t("left.confirmClear")}</p>
                        <div className="flex items-center gap-2 text-2xs">
                          <button
                            onClick={()=>{ clearAll(); setPendingClear(false); setMenuOpen(false); }}
                            className="text-bad hover:underline"
                          >
                            {t("btn.confirm")}
                          </button>
                          <button
                            onClick={()=> setPendingClear(false)}
                            className="text-ink3 hover:text-ink transition-colors"
                          >
                            {t("btn.cancel")}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={()=> setPendingClear(true)}
                        className="w-full text-left px-2 py-1.5 text-xs text-ink2 hover:bg-surface2 hover:text-bad transition-colors"
                      >
                        {t("left.clearAll")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ----------------------------------------------------------- list */}
      <div ref={setListEl} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto px-6 pb-8">
        {/* Column captions, so the row can drop its units and its labels and
            still be readable — the whole reason the row fits on one line. */}
        <div className="sticky top-0 z-10 bg-bg border-b border-line flex items-baseline gap-4 pt-1 pb-1.5">
          <span className={`label ${COL.when}`}>{t("arch.colWhen")}</span>
          <span className="label flex-1 min-w-0">{t("arch.colWhat")}</span>
          <span className={`label ${COL.review}`}>{t("arch.colReview")}</span>
          <span className={`label ${COL.count}`}>{t("arch.colCount")}</span>
          <span className={`label ${COL.range}`}>{t("arch.colRange")}</span>
          <span className={`label ${COL.basis}`}>{t("arch.colBasis")}</span>
          <span className={COL.act} aria-hidden="true" />
        </div>

        {padTop>0 && <div aria-hidden="true" style={{ height: padTop }} />}
        {visible.map((f, rowIdx)=>{
          const sealCount = countOf(f);
          const active = f.id===selectedId;
          const isManual = f.engine === "manual";
          const review = reviewStats(f);
          const band = f.band;
          const hasRange = band?.low!=null && band?.high!=null && band.high>band.low;
          /* Three sorties over one beach are three identical filenames; the
             site name is the only thing that tells them apart. A ground count
             has no filename at all. */
          const title = isManual ? t("rec.manual.title") : (f.filename || t("report.noFile"));
          const marks: React.ReactNode[] = [];
          if(f.source==="test") marks.push(<Pill key="test">{t("pill.test")}</Pill>);
          if(f.quickCount) marks.push(
            <Pill key="quick">
              <span title={t("ingest.quickFrom", { name: f.quickCount.fromVideo, s: f.quickCount.atSeconds })}>
                {t("pill.quick")}
              </span>
            </Pill>,
          );
          if(isManual) marks.push(<Pill key="manual" tone="accent">{t("rec.manual.pill")}</Pill>);
          if(f.retiredAt) marks.push(<Pill key="retired">{t("rec.retire.pill")}</Pill>);
          /* Losing the coordinates must not lose the fact that there are none:
             this sortie is in the archive and on no map. */
          if(!isPlaced(f)) marks.push(<Pill key="unplaced">{t("misc.notPlaced")}</Pill>);
          return (
            <div
              key={f.id}
              ref={rowIdx===0 ? firstRowRef : undefined}
              role="button"
              tabIndex={0}
              aria-current={active || undefined}
              onClick={()=> select(f.id)}
              onKeyDown={(e)=>{
                if(e.key==="Enter" || e.key===" "){ e.preventDefault(); select(f.id); }
              }}
              /* The selected row is marked in ink, not in the signal colour:
                 green is the standing estimate, not "you clicked this". */
              className={`group relative px-2 -mx-2 py-2 cursor-pointer border-b border-hair transition-colors outline-none focus-visible:bg-surface2 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ink2 ${active?"bg-surface2":"hover:bg-surface2"}`}
            >
              {active && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-ink" />}
              <div className="flex items-baseline gap-4">
                {/* Day and month at list density, the full date on hover. */}
                <span
                  className={`tnum text-2xs text-ink3 ${COL.when}`}
                  title={t("left.rowDate", { when: formatDate(f.uploadedAt, lang) })}
                >
                  {formatDate(f.uploadedAt, lang, { day: "2-digit", month: "2-digit" })}
                </span>

                <span className="flex-1 min-w-0 flex items-baseline gap-1.5 overflow-hidden">
                  {/* A filename is not a hash — Inter, not a typewriter. */}
                  <span
                    className={`text-sm truncate min-w-0 text-ink ${f.retiredAt ? "line-through opacity-60" : ""}`}
                    title={title}
                  >
                    {title}
                  </span>
                  {f.siteName && (
                    <span className="text-2xs text-ink2 truncate min-w-0 max-w-[160px]" title={f.siteName}>
                      {f.siteName}
                    </span>
                  )}
                  {marks.length>0 && (
                    <span className="shrink-0 flex items-baseline gap-1">
                      {marks.map((m,i)=>(
                        <Fragment key={i}>
                          {i>0 && <span aria-hidden="true" className="text-2xs text-ink4">·</span>}
                          {m}
                        </Fragment>
                      ))}
                    </span>
                  )}
                </span>

                {/* Rulings, not confirmations: a reviewer who rejected every
                    animal of this sortie has finished it. Printed only where
                    there is something to review — "0/0" reads as neglect. */}
                <span className={`tnum text-2xs text-ink3 ${COL.review}`}>
                  {review.reviewable>0
                    ? <span title={t("rec.review.short", { v: review.ruled, r: review.reviewable })}>
                        {review.ruled}/{review.reviewable}
                      </span>
                    : <span className="text-ink4">—</span>}
                </span>

                {/* A sortie still being counted has no band and no detections,
                    so countOf() is 0 — and "0" reads as a finished survey that
                    found nothing. State, not a number, until there is one. */}
                <span className={COL.count}>
                  {f.status==="processing" ? (
                    <span className="text-xs text-accent">{t("left.processing")}…</span>
                  ) : f.status==="error" ? (
                    <span className="text-xs text-bad">{t("left.failed")}</span>
                  ) : (
                    <span
                      className={`tnum text-lead font-medium ${sealCount>0 ? "text-ink" : "text-ink3"}`}
                      title={`${sealCount} ${tp(sealCount, "unit.seals")}`}
                    >
                      {sealCount}
                    </span>
                  )}
                </span>

                {/* The band, which is the honest width of that figure. The
                    340px panel had no room for it and the archive does. */}
                <span className={`tnum text-2xs text-ink3 ${COL.range}`}>
                  {hasRange ? `${band?.low}–${band?.high}` : <span className="text-ink4">—</span>}
                </span>

                {/* What the count rests on, in words — union of 4 frames, a
                    single image, a person on a beach. */}
                <span className={`text-2xs text-ink3 truncate ${COL.basis}`}>
                  {band?.basis ? basisText(lang, band.basis) : <span className="text-ink4">—</span>}
                </span>

                <span className={`${COL.act} flex items-baseline justify-end gap-1`}>
                  {isPlaced(f) && (
                    <button
                      onClick={(e)=>{ e.stopPropagation(); select(f.id); flyTo(f.center.lat, f.center.lng); }}
                      onKeyDown={(e)=> e.stopPropagation()}
                      className="grid h-8 w-8 place-items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 sm:h-auto sm:w-auto text-ink3 hover:text-ink transition-opacity"
                      aria-label={t("arch.showOnMap")}
                      title={t("arch.showOnMap")}
                    >
                      <Icon name="target" size={12} />
                    </button>
                  )}
                  {/* Retire, not remove: the × used to filter the sortie out of
                      two arrays under a prompt that said "Remove this sortie?"
                      — a durable-sounding promise over an act the app could not
                      perform. It asks for a reason. */}
                  {pendingRetire!==f.id && !f.retiredAt && (
                    <button
                      onClick={(e)=>{e.stopPropagation(); setPendingRetire(f.id); setRetireReason(""); setRetireError(null);}}
                      onKeyDown={(e)=> e.stopPropagation()}
                      className="grid h-8 w-8 place-items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 sm:h-auto sm:w-auto text-ink3 hover:text-bad transition-opacity"
                      aria-label={t("rec.retire.action")}
                      title={t("rec.retire.action")}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  )}
                </span>
              </div>

              {pendingRetire===f.id && (
                /* A nested action, held by the rule down its left edge rather
                   than by a box inside a row that is already a box. */
                <div
                  className="mt-2 ml-[88px] pl-3 border-l border-line space-y-1 max-w-[520px]"
                  onClick={e=>e.stopPropagation()}
                  onKeyDown={e=>e.stopPropagation()}
                >
                  <p className="text-2xs text-ink3 leading-relaxed">
                    {f.surveyId ? t("rec.retire.explain") : t("rec.retire.localOnly")}
                  </p>
                  <input
                    value={retireReason}
                    onChange={(e)=> setRetireReason(e.target.value)}
                    maxLength={REASON_MAX}
                    autoFocus
                    placeholder={t("rec.retire.reasonPlaceholder")}
                    aria-label={t("rec.retire.reasonLabel")}
                    className="w-full h-7 bg-transparent border-b border-line px-0 text-xs placeholder:text-ink4 focus:border-ink2 transition-colors"
                  />
                  {retireError && <p className="text-2xs text-bad">{retireError}</p>}
                  <div className="flex items-center gap-2 text-2xs">
                    <button
                      onClick={async ()=>{
                        if(!retireReason.trim()){ setRetireError(t("rec.retire.reasonRequired")); return; }
                        const ok = await retireFootage(f.id, retireReason.trim());
                        if(ok) setPendingRetire(null);
                        else setRetireError(t("rec.retire.failed"));
                      }}
                      className="text-bad hover:underline"
                    >
                      {t("rec.retire.action")}
                    </button>
                    <button
                      onClick={()=> setPendingRetire(null)}
                      className="text-ink3 hover:text-ink transition-colors"
                    >
                      {t("btn.cancel")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {padBottom>0 && <div aria-hidden="true" style={{ height: padBottom }} />}

        {filtered.length===0 && footages.length>0 && (
          <div className="py-12 text-center text-sm text-ink3">{t("left.noMatch", { q })}</div>
        )}
        {footages.length===0 && (
          <div className="py-10 max-w-[440px] text-sm text-ink3 leading-relaxed">
            {hydrating ? t("est.restoringBody") : (
              /* An empty product should teach the loop, not point at a button.
                 The three steps are the three things this platform does, in the
                 order they happen. */
              <div className="space-y-2.5">
                <p className="text-ink2">{t("rec.left.emptyTitle")}</p>
                <p>{t("rec.left.emptyUpload")}</p>
                <p>{t("rec.left.emptyReview")}</p>
                <p>{t("rec.left.emptyReport")}</p>
                <p className="text-2xs pt-2 mt-1 border-t border-hair">{t("rec.left.emptyManual")}</p>
                <p className="text-2xs">{t("left.emptyHint")}</p>
                <div className="pt-2">
                  {/* Disabled while the archive is being read: seeding
                      synthetic sorties into a store hydrate() is about to fill
                      is a race whose loser is the real data. */}
                  <Button variant="primary" onClick={seedTestData} disabled={hydrating}>
                    {t("left.loadTest")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* The date brush belongs to the two screens that are ABOUT the season's
          sorties. It gates itself on having more than one day to brush, so
          this is one line here and one line on Карта. */}
      <Timeline minimal />

      <ManualCount open={manualOpen} onOpenChange={setManualOpen} />
    </div>
  );
}
