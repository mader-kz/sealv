"use client";
import { useState, useEffect, useMemo, useRef } from "react";
import dynamic from "next/dynamic";
import TopBar from "@/components/layout/TopBar";
import Rail from "@/components/layout/Rail";
import LeftPanel from "@/components/layout/LeftPanel";
import RightInspector from "@/components/layout/RightInspector";
import Dropzone from "@/components/upload/Dropzone";
import { FailedIngests } from "@/components/upload/IngestQueue";
import Dashboard from "@/components/dashboard/Dashboard";
import Timeline from "@/components/layout/Timeline";
import Workbench from "@/components/workbench/Workbench";
import { useFootageStore } from "@/store/useFootageStore";
import { useIngestStore, isRunning } from "@/store/useIngestStore";
import { seasonEstimate } from "@/lib/analytics/estimate";
import { footagesInRange } from "@/lib/analytics/brush";
import { Button, IconButton } from "@/components/ui/primitives";
import Icon from "@/components/ui/Icon";
import { useT } from "@/lib/i18n";

function MapLoading(){
  const { t } = useT();
  return <div className="h-full bg-bg grid place-items-center text-sm text-ink3">{t("map.loading")}</div>;
}

const CaspianMap = dynamic(()=> import("@/components/map/CaspianMap"), {
  ssr: false,
  loading: ()=> <MapLoading />,
});

/* Below this the map column cannot carry a 340px list AND a 340–380px pane and
   still be a map: at 1024px it was left with 296px, while the chip and Ingest
   pinned to its top-right need ~250px of min-content — and body{overflow:hidden}
   means what spills is simply gone. */
const WIDE_MIN = 1100;

export default function Page(){
  const { t, tp } = useT();
  const [showLeft, setShowLeft] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  /* Two independent booleans, not one "which pane" enum. Selection used to
     force the pane to "inspector", which meant clicking a bar in the analytics
     panel destroyed the panel it was clicked in — and made that panel's own
     selected-bar highlight unreachable by construction. */
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const mapRef = useState<{ m: any | null }>({ m:null })[0];

  /* Server-rendered HTML is the wide layout, so the first client render must
     be too or hydration tears; the media query corrects it immediately after. */
  const [wide, setWide] = useState(true);
  const wideRef = useRef(true);
  useEffect(()=>{
    if(typeof window==="undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(`(min-width: ${WIDE_MIN}px)`);
    const apply = ()=> { wideRef.current = mq.matches; setWide(mq.matches); };
    apply();
    mq.addEventListener?.("change", apply);
    return ()=> mq.removeEventListener?.("change", apply);
  },[]);

  /* The one camera channel. LeftPanel rows, Workbench "show on map" and the
     analytics bars all dispatch `flyto`; nothing reaches into the map through
     a global any more. */
  useEffect(()=>{
    const h = (e:any)=> {
      const d = e?.detail ?? {};
      const lat = Number(d.lat), lng = Number(d.lng);
      if(!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const zoom = Number.isFinite(Number(d.zoom)) ? Number(d.zoom) : 8.5;
      if(mapRef.m){ try{ mapRef.m.stop(); }catch{} mapRef.m.easeTo({ center:[lng,lat], zoom, duration: 260 }); }
    };
    document.addEventListener("flyto", h as any);
    return ()=> document.removeEventListener("flyto", h as any);
  },[mapRef]);

  const footages = useFootageStore(s=>s.footages);
  const timeRange = useFootageStore(s=>s.timeRange);
  const selectedId = useFootageStore(s=>s.selectedId);
  const select = useFootageStore(s=>s.select);
  const seedTestData = useFootageStore(s=>s.seedTestData);
  const hydrate = useFootageStore(s=>s.hydrate);
  /* Restore progress, read defensively: these fields arrive with the store's
     own loading work and this page must render correctly with or without them. */
  const hydrating = useFootageStore(s=> ((s as any).hydrating ?? false) as boolean);
  const hydrateError = useFootageStore(s=> ((s as any).hydrateError ?? null) as unknown);
  const hydrateSkipped = useFootageStore(s=> Number((s as any).hydrateSkipped ?? 0));
  const loadedRuns = useFootageStore(s=> Number((s as any).loadedRuns ?? 0));
  const totalRuns = useFootageStore(s=> Number((s as any).totalRuns ?? 0));

  // Reload the season's counts from the service on boot. hydrate() holds a
  // module-scope promise for the run in flight and hands the same one back to
  // a second caller, so React 18's strict-mode double-invoke of this effect
  // joins the first hydrate instead of starting a rival one.
  useEffect(()=>{ hydrate(); },[hydrate]);

  /* What the SERVICE remembers going wrong. A job-stage failure writes no run
     row, so hydrate() cannot rebuild it: without this call an F5 after seven
     failed ingests shows a clean map and seven counts that never happened. */
  const ingestItems = useIngestStore(s=>s.items);
  const refreshFailed = useIngestStore(s=>s.refreshFailed);
  useEffect(()=>{ void refreshFailed(); },[refreshFailed]);
  const ingestBusy = useMemo(
    ()=> ingestItems.filter(i=> isRunning(i.phase) || i.phase==="queued").length,
    [ingestItems],
  );
  const ingestNeedsYou = useMemo(
    ()=> ingestItems.filter(i=> ["duplicate_choice","needs_location","frame_choice"].includes(i.phase)).length,
    [ingestItems],
  );

  /* Selection opens the inspector without closing analytics. Closing the
     inspector clears the selection, which is also what makes re-clicking the
     SAME sortie work: an effect keyed on selectedId cannot see id → id. */
  useEffect(()=>{
    if(!selectedId) return;
    setInspectorOpen(true);
    if(!wideRef.current) setShowLeft(false);
  },[selectedId]);
  const closeInspector = ()=>{ setInspectorOpen(false); select(null); };

  // Open the footage list once there's something in it — while empty, the
  // centred call-to-action is the only thing worth showing. Not below the
  // breakpoint: there the map has no width to give away.
  useEffect(()=>{ if(wideRef.current && footages.length>0) setShowLeft(true); },[footages.length>0]); // eslint-disable-line react-hooks/exhaustive-deps
  // Narrowing the window with both sides open: the list yields, not the map.
  useEffect(()=>{ if(!wide && (analyticsOpen || inspectorOpen)) setShowLeft(false); },[wide]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleLeft = ()=>{
    const next = !showLeft;
    setShowLeft(next);
    if(next && !wide){ setAnalyticsOpen(false); setInspectorOpen(false); }
  };
  const toggleAnalytics = ()=>{
    const next = !analyticsOpen;
    setAnalyticsOpen(next);
    if(next && !wide){ setShowLeft(false); setInspectorOpen(false); }
  };

  /* The standing estimate — the latest sortie at each site — from the one
     shared helper the panel, the analytics view and the report also use. This
     chip used to print the sum over every sortie, which counts a re-flown
     haul-out once per visit: 1475 where 1175 animals were standing. The raw
     sum is still here, one line down, named for what it measures.
     Over the BRUSHED list, not the whole store: the chip is pinned to a map
     that draws only the brushed sorties, and the panel and the report beside
     it are brushed too. An unbrushed chip on a brushed map says "1175 seals ·
     5 sorties" over two drawn sorties — the same one-screen-two-totals
     failure the shared helper exists to prevent. */
  const brushed = useMemo(()=> footagesInRange(footages, timeRange), [footages, timeRange]);
  const est = useMemo(()=> seasonEstimate(brushed), [brushed]);
  const empty = footages.length===0;
  const restoring = empty && hydrating;
  const unreachable = empty && !hydrating && !!hydrateError;
  /* Analytics wins the right column while it is open — a bar click must not
     destroy the panel it was clicked in. The inspector waits behind it. */
  const showInspector = !analyticsOpen && inspectorOpen && !!selectedId;
  /* Both panels next to the map leave it as narrow as a small laptop does;
     the chip drops its words rather than its numbers. */
  const mapNarrow = !wide || (showLeft && (analyticsOpen || showInspector));
  const partial = totalRuns > 0 && loadedRuns > 0 && loadedRuns < totalRuns;

  /* A sortie still being counted lives only in this tab. Reloading throws the
     work away, so the browser gets to ask first. */
  const processing = useMemo(()=> footages.some(f=> f.status==="processing"), [footages]);
  useEffect(()=>{
    if(!processing) return;
    const h = (e: BeforeUnloadEvent)=>{ e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return ()=> window.removeEventListener("beforeunload", h);
  },[processing]);

  // The timeline is a date brush; with everything flown on one day there is
  // nothing to brush. It earns its strip only once a season has history.
  const multiDay = useMemo(
    ()=> new Set(footages.map(f=> new Date(f.uploadedAt).toDateString())).size > 1,
    [footages],
  );

  return (
    <div className="h-screen w-screen flex flex-col bg-bg">
      <TopBar />
      <Workbench open={workbenchOpen} onClose={()=> setWorkbenchOpen(false)} />

      <div className="flex flex-1 min-h-0">
        <Rail
          onWorkbench={()=> setWorkbenchOpen(v=>!v)}
          onToggleLeft={toggleLeft}
          onToggleAnalytics={toggleAnalytics}
          leftOpen={showLeft}
          rightAnalytics={analyticsOpen}
        />

        <div className={`shrink-0 border-r border-line overflow-hidden transition-[width] duration-200 ${showLeft ? "w-[340px]" : "w-0 border-0"}`}>
          <div className="w-[340px] h-full">
            <LeftPanel />
          </div>
        </div>

        <div className="flex-1 min-w-0 flex flex-col relative">
          <div className="flex-1 min-h-0 relative">
            <CaspianMap onMapReady={m=>{ mapRef.m=m; }} />

            {/* Running total — top-right, out of the map's way */}
            <div className="absolute top-3 right-3 z-30 flex flex-col items-end gap-1.5">
              <div className="flex items-center gap-2">
                {/* symmetric padding, not h-7: items-baseline packs a fixed-height
                    line to the top, so the text sat above centre */}
                {!empty && (
                  <div
                    className="bg-surface border border-line rounded px-2.5 py-[3px] shadow-pop"
                    title={t("est.observedSub", { n: est.observed, m: brushed.length })}
                  >
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-sm tnum text-ink">{est.current}</span>
                      {!mapNarrow && <span className="text-2xs text-ink3">{tp(est.current, "unit.seals")}</span>}
                      <span className="text-line px-0.5">·</span>
                      <span className="text-sm tnum text-ink">{brushed.length}</span>
                      {!mapNarrow && <span className="text-2xs text-ink3">{tp(brushed.length, "unit.sorties")}</span>}
                    </div>
                    {/* The demoted raw total, kept visible rather than deleted:
                        it is the season's observation count, not a population. */}
                    {est.observed !== est.current && (
                      <div className="text-2xs text-ink3 leading-tight tnum">
                        {t("est.observedShort", { n: est.observed })}
                      </div>
                    )}
                  </div>
                )}
                {/* No `disabled={hydrating}`. Ingest writes new rows and
                    hydrate() upserts by id, skipping anything already there,
                    so the two cannot collide — and locking the only way INTO
                    the product for the length of an archive fetch is the worst
                    moment to do it. `seedTestData` keeps its gate: synthetic
                    sorties really do race the archive. */}
                <Button
                  icon="plus"
                  variant={showUpload ? "primary" : "default"}
                  onClick={()=> setShowUpload(v=>!v)}
                  title={ingestNeedsYou ? t("ingest.needsYou", { n: ingestNeedsYou }) : undefined}
                >
                  {t("page.ingest")}
                  {(ingestBusy>0 || ingestNeedsYou>0) && (
                    <span className={`tnum text-2xs ${ingestNeedsYou>0 ? "text-accent" : "text-ink3"}`}>
                      {ingestNeedsYou>0 ? `· ${ingestNeedsYou}!` : `· ${ingestBusy}`}
                    </span>
                  )}
                </Button>
              </div>

              {/* What the archive did not give us. A season shown short is a
                  season shown wrong unless it says by how much. */}
              {(partial || hydrateSkipped>0) && (
                <div className="bg-surface border border-line rounded px-2 py-1 text-2xs text-ink3 shadow-pop max-w-[260px] text-right">
                  {partial && <div>{t("est.showingOf", { n: loadedRuns, m: totalRuns })}</div>}
                  {hydrateSkipped>0 && <div>{t("est.loadFailedN", { n: hydrateSkipped })}</div>}
                </div>
              )}

              {/* Ingests the service recorded as failed, reachable WITHOUT
                  opening the Ingest panel — a failure nobody can find is a
                  failure the archive is quietly missing a count for. */}
              <div className="w-[300px] max-w-[80vw] text-left empty:hidden bg-surface border border-line rounded p-2 shadow-pop">
                <FailedIngests compact />
              </div>
            </div>

            {/* Ingest panel */}
            {showUpload && (
              <div className="absolute top-[52px] right-3 z-30 w-[320px] bg-surface border border-line rounded-lg shadow-pop overflow-hidden">
                <div className="h-9 px-3 pr-1.5 flex items-center justify-between border-b border-line">
                  <span className="label">{t("page.ingestFootage")}</span>
                  <IconButton name="close" onClick={()=> setShowUpload(false)} title={t("btn.close")} />
                </div>
                <div className="p-3">
                  <Dropzone />
                </div>
              </div>
            )}

            {/* An empty store is three different situations. Asserting "you
                have no footage" over a live fetch of the archive — or over a
                service that could not be reached — is the app inventing a fact
                about the user's data that it does not have. */}
            {empty && !showUpload && (
              <div className="absolute inset-0 z-20 grid place-items-center bg-bg overflow-y-auto py-6">
                <div className={`text-center px-6 ${restoring || unreachable ? "max-w-[320px]" : "max-w-[440px]"}`}>
                  {restoring ? (
                    <>
                      <Icon name="download" size={22} className="text-ink3 mx-auto" />
                      <h2 className="text-lead text-ink mt-3">{t("est.restoring")}…</h2>
                      <p className="text-sm text-ink2 mt-1.5 leading-relaxed">{t("est.restoringBody")}</p>
                    </>
                  ) : unreachable ? (
                    <>
                      <Icon name="alert" size={22} className="text-bad mx-auto" />
                      <h2 className="text-lead text-ink mt-3">{t("est.unreachable")}</h2>
                      <p className="text-sm text-ink2 mt-1.5 leading-relaxed">{t("est.unreachableBody")}</p>
                      <div className="flex items-center justify-center gap-1.5 mt-4">
                        <Button variant="primary" onClick={()=> { void hydrate(); }}>{t("btn.retry")}</Button>
                        <Button icon="upload" onClick={()=> setShowUpload(true)}>{t("page.upload")}</Button>
                      </div>
                    </>
                  ) : (
                    /* First run. A bare "upload something" button tells a new
                       ecologist what to click and nothing about what this
                       platform then does with it — so the empty screen teaches
                       the three flows that make up a working day, and names
                       the file types it can actually read. */
                    <>
                      <Icon name="upload" size={22} className="text-ink3 mx-auto" />
                      <h2 className="text-lead text-ink mt-3">{t("page.emptyTitle")}</h2>
                      <p className="text-sm text-ink2 mt-1.5 leading-relaxed">
                        {t("page.emptyBody")}
                      </p>
                      <ol className="mt-4 space-y-2 text-left">
                        {([
                          { n: 1, icon: "upload" as const, title: t("first.uploadTitle"), body: t("first.uploadBody") },
                          { n: 2, icon: "check" as const, title: t("first.reviewTitle"), body: t("first.reviewBody") },
                          { n: 3, icon: "download" as const, title: t("first.reportTitle"), body: t("first.reportBody") },
                        ]).map(step=>(
                          <li key={step.n} className="flex items-start gap-2.5 rounded border border-line-soft bg-surface px-2.5 py-2">
                            <span className="w-5 h-5 shrink-0 grid place-items-center rounded-full border border-line text-2xs text-ink3 tnum mt-0.5">
                              {step.n}
                            </span>
                            <span className="min-w-0">
                              <span className="flex items-center gap-1.5 text-xs text-ink">
                                <Icon name={step.icon} size={12} className="text-ink3" />
                                {step.title}
                              </span>
                              <span className="block text-2xs text-ink3 mt-0.5 leading-relaxed">{step.body}</span>
                            </span>
                          </li>
                        ))}
                      </ol>
                      <p className="text-2xs text-ink3 mt-2.5 leading-relaxed">{t("ingest.acceptedTypes")}</p>
                      <div className="flex items-center justify-center gap-1.5 mt-4">
                        <Button variant="primary" icon="upload" onClick={()=> setShowUpload(true)}>
                          {t("page.upload")}
                        </Button>
                        {/* Only reachable once the restore has settled —
                            seeding synthetic sorties into a store hydrate() is
                            still filling is the boot race that loses real data. */}
                        <Button onClick={seedTestData} disabled={hydrating}>{t("left.loadTest")}</Button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          {multiDay && <Timeline minimal />}
        </div>

        {analyticsOpen && <Dashboard onClose={()=> setAnalyticsOpen(false)} />}
        {showInspector && (
          <div className="shrink-0 flex flex-col border-l border-line">
            <div className="h-9 shrink-0 flex items-center justify-between pl-4 pr-1.5 border-b border-line bg-surface">
              <span className="label">{t("sec.sortie")}</span>
              <IconButton name="close" onClick={closeInspector} title={t("btn.close")} />
            </div>
            <RightInspector compact />
          </div>
        )}
      </div>
    </div>
  );
}
