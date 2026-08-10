"use client";
/* ─────────────────────────────────────────────────────────────────────────────
 * HANDOVER — this panel is being taken apart, and this note is the coordination.
 *
 * It used to be the permanent left column: the season's headline figures on top
 * of the sortie list, beside the map, always. In the five-mode shell it has no
 * home — Карта is places, not flights — so its two halves went different ways:
 *
 *   the STATS (standing estimate, the observed-across-N-sorties line, the
 *   surveyed-area readout with its no-GSD / assumed-GSD caveats) have MOVED to
 *   the season strip at the top of Карта — components/modes/SeasonMode.tsx.
 *   They are gone from this file; do not restore them here, or the season total
 *   will be stated in two places again, which is how it came to be stated
 *   differently in two places.
 *
 *   the LIST and everything hanging off it — search, the CSV export, retire
 *   (with its reason), show-retired, clear-all, the ground-count entry, the
 *   seed-test-data button, the empty state that teaches the loop — are
 *   ArchiveMode's material (Съёмки). This file is kept, unmounted, purely as
 *   that agent's source: it is the windowed list, working, with every one of
 *   those capabilities attached.
 *
 * ARCHIVE AGENT: once ArchiveMode.tsx carries the list and the actions above,
 * DELETE this file. Nothing imports it — the shell dropped it when the modes
 * landed — so it is dead weight the moment you no longer need it to copy from.
 * ───────────────────────────────────────────────────────────────────────────── */
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFootageStore } from "@/store/useFootageStore";
import { Button, Field, SectionHead, Pill } from "@/components/ui/primitives";
import Icon from "@/components/ui/Icon";
import { useT } from "@/lib/i18n";
import { countOf } from "@/lib/analytics/count";
import { footagesInRange, formatDate } from "@/lib/analytics/brush";
import { hasResult, isPlaced } from "@/lib/analytics/surveys";
import { reviewStats } from "@/lib/analytics/review";
import { csvCell, downloadText } from "@/lib/export/animals";
import { REASON_MAX } from "@/lib/api";
import ManualCount from "@/components/record/ManualCount";

/* Nominal sortie row height, px. Corrected from a real measurement on the
   first pass; the constant only has to be close enough to pick a first slice.
   One line per sortie since the row shed its coordinates, so ~37 rather than
   the two-storey 62. */
const ROW_H = 37;
/* Rows above and below the viewport. Also absorbs the sticky section header,
   which eats into the scroller's usable height. */
const OVERSCAN = 6;

export default function LeftPanel(){
  const { t, tp, lang } = useT();
  const footages = useFootageStore(s=>s.footages);
  const selectedId = useFootageStore(s=>s.selectedId);
  const select = useFootageStore(s=>s.select);
  const retireFootage = useFootageStore(s=>s.retireFootage);
  const seedTestData = useFootageStore(s=>s.seedTestData);
  const clearAll = useFootageStore(s=>s.clearAll);
  const [q, setQ] = useState("");
  /* Retiring asks for a REASON, not just a confirmation. "Why is this flight
     not part of the season" is the only part of a retirement that is worth
     anything a year later, and a bare yes/no records none of it. */
  const [pendingRetire, setPendingRetire] = useState<string|null>(null);
  const [retireReason, setRetireReason] = useState("");
  const [retireError, setRetireError] = useState<string|null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [pendingClear, setPendingClear] = useState(false);
  /* The header's overflow: a disclosure, not an ARIA menu — there is no
     arrow-key ring here, so it does not claim one. Tab reaches the two
     actions, Escape and a click outside put it away. */
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement|null>(null);
  useEffect(()=>{
    /* Closing forgets a half-answered "clear everything?". Every route out —
       the button, Escape, a click elsewhere, the season emptying — lands here,
       so the confirm can never be waiting behind a closed panel. */
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
  const timeRange = useFootageStore(s=>s.timeRange);
  /* Read defensively: the store gains these while the archive is being
     restored, and this panel must compile and behave whether or not that
     landing has happened yet. */
  const hydrating = useFootageStore(s=> ((s as any).hydrating ?? false) as boolean);

  const inWindow = useMemo(()=> footagesInRange(footages, timeRange), [footages,timeRange]);

  /* Retired sorties are out of every FIGURE on this panel — that is what
     retiring one means — but they are not out of the archive, so they stay
     available behind a toggle with their retirement stated. */
  const retiredInWindow = useMemo(()=> inWindow.filter(f=> !!f.retiredAt), [inWindow]);
  const filteredByTime = useMemo(()=> inWindow.filter(f=> !f.retiredAt), [inWindow]);

  /* The sorties that actually produced a count. A failed ingest is a row in
     this list and nothing else: seven of them used to add seven sorties to
     "N animals observed across M sorties" and seven entries to the "without
     GSD" tally — two sentences about surveys, counting rows that are not
     surveys. One predicate, shared with the CSV and the report. */
  const counted = useMemo(()=> filteredByTime.filter(hasResult), [filteredByTime]);

  const listed = useMemo(
    ()=> (showRetired ? [...filteredByTime, ...retiredInWindow] : filteredByTime),
    [filteredByTime, retiredInWindow, showRetired],
  );

  const filtered = useMemo(()=>{
    const needle=q.toLowerCase();
    return listed.filter(f=> !needle
      || f.filename.toLowerCase().includes(needle)
      || (f.siteName ?? "").toLowerCase().includes(needle)
      || f.id.toLowerCase().includes(needle));
  },[listed,q]);

  /* The standing estimate and the surveyed-area readout used to be computed
     here and printed above the list. They are the season's statement, so they
     belong to the season's screen: both now live in SeasonMode's strip, from
     the same shared helpers (seasonEstimate, totalAreaM2). See the handover
     note at the top of this file. */

  /* Per-sortie summary. Every column is measured: the band with its basis, the
     reviewed share, the photographed area. Filenames go through csvCell —
     a comma in a filename used to split a row into nonsense. */
  /* Sorties that produced a count, in the current window. A failed ingest is
     not a row of survey data, and exporting one puts a line of empty columns
     into a spreadsheet somebody will average. Retired sorties are exported
     only when they are shown, and then carry `retiredAt` so the reader can
     tell why the total does not match the row count. */
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
        // Rejected rows live in this list too. The header says "detections",
        // which in every other figure this app prints means "animals the
        // review kept" — so a false positive is not one of them here either.
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
        // Free text, quoted by csvCell — a field note is the one column here
        // that can contain a comma, a quote and a newline all at once.
        csvCell(f.notes ?? ""),
      ].join(","));
    }
    downloadText(`sealv-footage-${new Date().toISOString().slice(0,10)}.csv`, "text/csv", rows.join("\n"));
  };

  /* ---------------------------------------------------------- windowing */
  /* The same defect the Detections table had, one panel over: every sortie in
     the season mounted a ~12-element row the moment the panel opened, and the
     design target is hundreds of sorties per season — several thousand nodes
     built synchronously, rebuilt whenever the store's array identity changes
     (which the progressive hydrate does once per merged run). Only the visible
     slice is mounted; two spacers of computed height stand in for the rest so
     the scrollbar and the scroll position stay truthful. Dependency-free, and
     the same shape as components/workbench/Workbench.tsx. */
  const total = filtered.length;
  /* The scroller as STATE, not a ref: an effect with a dependency array can
     only see the element if it re-runs when the element attaches, and this
     panel mounts inside a width-collapsed wrapper. Same shape as Workbench. */
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
    /* A new filter scrolls back to the top BEFORE the slice is chosen, or the
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

  /* One camera channel for the whole app. This reached through
     `window.__sealvMap`, a global the map used to set — a second, private
     path to the same camera that nothing else could see or replace. The map
     no longer publishes it. */
  const flyTo = (lat:number, lng:number)=>{
    if(!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    document.dispatchEvent(new CustomEvent("flyto", { detail:{ lat, lng, zoom: 10 } }));
  };

  return (
    <div className="w-[340px] shrink-0 bg-surface flex flex-col overflow-hidden h-full">
      {/* No headline block. The season's figures are stated once, on Карта. */}

      <div className="px-4 pt-4 pb-3 space-y-2 border-b border-line">
        <div className="flex gap-2">
          <Field value={q} onChange={setQ} placeholder={t("left.filter")} icon="search" />
          <Button icon="download" onClick={exportCSV} title={t("left.exportCsvTitle")} />
          {/* The rare and the destructive, one click further away. Showing the
              retired sorties and discarding the season are things a person does
              once a month and once ever; they were sitting in the header at the
              same weight as the search box. The overflow only exists once there
              is a season to act on. */}
          {footages.length>0 && (
            <div className="relative shrink-0" ref={menuRef}>
              <button
                onClick={()=> setMenuOpen(v=>!v)}
                aria-label={t("left.more")}
                aria-expanded={menuOpen}
                aria-controls="left-more"
                title={t("left.more")}
                className={`w-7 h-7 grid place-items-center border transition-colors ${
                  menuOpen ? "border-ink4 text-ink bg-surface2" : "border-line text-ink2 hover:text-ink hover:border-ink4 hover:bg-surface2"
                }`}
              >
                <span aria-hidden="true" className="text-sm leading-none -translate-y-[3px]">···</span>
              </button>
              {menuOpen && (
                /* A flat dark plate: this leaves the page plane, so it keeps a
                   border and a shadow, and nothing else. */
                <div
                  id="left-more"
                  className="plate absolute right-0 top-8 z-30 w-[228px] p-1 shadow-pop"
                >
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
        {/* A count a person made is a survey too. It sits next to the upload
            path rather than buried in a menu, because for most of this
            coastline it is the only way a count has ever been made. */}
        <Button icon="plus" full onClick={()=> setManualOpen(true)}>
          {t("rec.manual.open")}
        </Button>
        {footages.length===0 && (
          /* Disabled while the archive is being read: seeding synthetic sorties
             into a store that hydrate() is about to fill is a race whose loser
             is the real data. */
          <Button variant="primary" full onClick={seedTestData} disabled={hydrating}>
            {hydrating ? `${t("est.restoring")}…` : t("left.loadTest")}
          </Button>
        )}
      </div>

      <div ref={setListEl} onScroll={onScroll} className="flex-1 overflow-auto">
        <SectionHead
          title={`${t("nav.footage")} · ${filtered.length}`}
          className="px-4 h-8 sticky top-0 bg-bg border-b border-line z-10"
        />

        {padTop>0 && <div aria-hidden="true" style={{ height: padTop }} />}
        {visible.map((f, rowIdx)=>{
          const sealCount = countOf(f);
          const active = f.id===selectedId;
          const open = ()=>{ select(f.id); flyTo(f.center.lat, f.center.lng); };
          const isManual = f.engine === "manual";
          const review = reviewStats(f);
          /* Three sorties over one beach rendered as three identical
             filenames; the site name is the only thing that told them apart
             and it was never shown. A ground count has no filename at all. */
          const title = isManual ? t("rec.manual.title") : f.filename;
          /* The row's markers, as quiet words joined by middots — the pill
             capsules are gone. Collected into an array rather than emitted
             inline so the separator can sit BETWEEN them: with three of the
             five conditions false, a `gap` alone left a run of unrelated words
             with nothing saying they were a list. */
          const marks: React.ReactNode[] = [];
          if(f.source==="test") marks.push(<Pill key="test">{t("pill.test")}</Pill>);
          /* One frame of a clip, not a photograph. It survives a reload
             because the archive stores the clip and the second, so the label
             is a fact about the row rather than a leftover from the session
             that made it. */
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
             this sortie is in the list and on no map. */
          if(!isPlaced(f)) marks.push(<Pill key="unplaced">{t("misc.notPlaced")}</Pill>);
          return (
            /* The app's primary navigation was a bare <div onClick>: no tab
               stop, no role, no key handler. */
            <div
              key={f.id}
              ref={rowIdx===0 ? firstRowRef : undefined}
              role="button"
              tabIndex={0}
              aria-current={active || undefined}
              onClick={open}
              onKeyDown={(e)=>{
                if(e.key==="Enter" || e.key===" "){ e.preventDefault(); open(); }
              }}
              /* `hover:bg-surface2/60` emitted no CSS at all — Tailwind cannot
                 apply an opacity modifier to a colour declared as a bare
                 `var()`, so the list's only hover feedback has never rendered.
                 Full surface-2, which is what the reference's rows use. The
                 selected row is marked in ink, not in the signal colour: green
                 is the standing estimate, not "you clicked this". */
              className={`group relative px-4 py-2 cursor-pointer border-b border-hair transition-colors outline-none focus-visible:bg-surface2 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ink2 ${active?"bg-surface2":"hover:bg-surface2"}`}
            >
              {active && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-ink" />}
              {/* One line per sortie. The coordinates, the clip length and the
                  track-point count used to fill a second storey with facts the
                  inspector prints in full the instant this row is clicked — a
                  list is for finding a sortie, not for reading one. What stays
                  is what a person scans by: the name, what it is, how far the
                  review got, when it landed, and the count. */}
              <div className="flex items-baseline gap-1.5 overflow-hidden">
                {/* A filename is not a hash. It used to be set in a typewriter
                    face, which made every row shout its least interesting
                    fact; it is Inter now, and the id hash is the one string in
                    this product that still gets a monospace. */}
                <span
                  className={`text-sm truncate min-w-0 text-ink ${f.retiredAt ? "line-through opacity-60" : ""}`}
                  title={title}
                >
                  {title}
                </span>
                {/* The place, by name once somebody has named it — three
                    sorties over one beach are three identical filenames and
                    this is the only thing that tells them apart. */}
                {f.siteName && (
                  <span className="text-2xs text-ink2 truncate min-w-0 max-w-[88px]" title={f.siteName}>
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
                <span className="flex-1 min-w-[2px]" />
                {/* How far the review has got. Rulings, not confirmations: a
                    reviewer who rejected every animal of this sortie has
                    finished it. Printed only where there is something to
                    review — "0/0" on a sortie with no reviewable row reads as
                    neglect rather than as a fact about this build. */}
                {review.reviewable>0 && (
                  <span
                    className="tnum text-2xs text-ink3 shrink-0"
                    title={t("rec.review.short", { v: review.ruled, r: review.reviewable })}
                  >
                    {review.ruled}/{review.reviewable}
                  </span>
                )}
                {/* Day and month at list density, the full date on hover —
                    same formatter, same locale as every other date in the app. */}
                <span
                  className="tnum text-2xs text-ink3 shrink-0"
                  title={t("left.rowDate", { when: formatDate(f.uploadedAt, lang) })}
                >
                  {formatDate(f.uploadedAt, lang, { day: "2-digit", month: "2-digit" })}
                </span>
                {/* A sortie still being counted has no band and no detections,
                    so countOf() is 0 — and "0 seals" reads as a finished survey
                    that found nothing. State, not a number, until there is one. */}
                {f.status==="processing" ? (
                  /* Counting right now — one of the two things the signal
                     colour is for. A capsule is not needed to say it. */
                  <span className="text-xs text-accent shrink-0">{t("left.processing")}…</span>
                ) : f.status==="error" ? (
                  <span className="text-xs text-bad shrink-0">{t("left.failed")}</span>
                ) : (
                  <>
                    {/* The row's figure, a step up from the text around it, and
                        right-aligned in a column of its own: tabular digits
                        only line up if the cell they sit in does too, and a
                        ragged 0 / 137 / 1282 down a scanning list is the one
                        thing an instrument may not do. A zero stays muted —
                        "this sortie found nothing" should not read at the same
                        volume as six hundred. */}
                    <span className={`tnum text-lead font-medium shrink-0 min-w-[34px] text-right ${sealCount>0 ? "text-ink" : "text-ink3"}`}>{sealCount}</span>
                    <span className="text-2xs text-ink3 shrink-0">{tp(sealCount, "unit.seals")}</span>
                  </>
                )}
                {/* Retire, not remove. The × used to filter the sortie out of
                    two arrays under a prompt that said "Remove this sortie?" —
                    a durable-sounding promise over an act the app could not
                    perform: the survey and its contribution to the estimate
                    were both back on the next hydrate. Revealed on focus and
                    on touch, and it asks for a reason. */}
                {pendingRetire!==f.id && !f.retiredAt && (
                  <button
                    onClick={(e)=>{e.stopPropagation(); setPendingRetire(f.id); setRetireReason(""); setRetireError(null);}}
                    onKeyDown={(e)=> e.stopPropagation()}
                    className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 text-ink3 hover:text-bad transition-opacity"
                    aria-label={t("rec.retire.action")}
                    title={t("rec.retire.action")}
                  >
                    <Icon name="close" size={12} />
                  </button>
                )}
              </div>

              {pendingRetire===f.id && (
                /* A nested action, held by the rule down its left edge rather
                   than by a box inside a row that is already a box. */
                <div
                  className="mt-2 pl-3 border-l border-line space-y-1"
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
          <div className="p-6 text-center text-sm text-ink3">{t("left.noMatch", { q })}</div>
        )}
        {footages.length===0 && (
          <div className="p-5 text-sm text-ink3 leading-relaxed">
            {hydrating ? t("est.restoringBody") : (
              /* An empty product should teach the loop, not just point at a
                 button. The three steps are the three things this platform
                 does, in the order they happen; the drop instructions stay
                 underneath because that is the first step's detail. */
              <div className="space-y-2.5">
                <p className="text-ink2">{t("rec.left.emptyTitle")}</p>
                <p>{t("rec.left.emptyUpload")}</p>
                <p>{t("rec.left.emptyReview")}</p>
                <p>{t("rec.left.emptyReport")}</p>
                <p className="text-2xs pt-2 mt-1 border-t border-hair">{t("rec.left.emptyManual")}</p>
                <p className="text-2xs">{t("left.emptyHint")}</p>
              </div>
            )}
          </div>
        )}
      </div>

      <ManualCount open={manualOpen} onOpenChange={setManualOpen} />
    </div>
  );
}
