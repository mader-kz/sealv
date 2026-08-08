"use client";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useFootageStore } from "@/store/useFootageStore";
import { Button, IconButton, SectionHead, Stat } from "@/components/ui/primitives";
import SiteDynamics from "@/components/dashboard/SiteDynamics";
import TrustPanel from "@/components/dashboard/TrustPanel";
import { totalAreaM2, formatArea } from "@/lib/analytics/area";
import { countOf } from "@/lib/analytics/count";
import { detectionsFor, footagesInRange, formatDate, timeExtent } from "@/lib/analytics/brush";
import { seasonEstimate } from "@/lib/analytics/estimate";
import { groupSizes, histogram } from "@/lib/analytics/groups";
import { seasonReviewStats } from "@/lib/analytics/review";
import { groupIntoSites, hasResult, siteSeries, SITE_RADIUS_M } from "@/lib/analytics/surveys";
import { useOperator } from "@/lib/identity";
import { useT } from "@/lib/i18n";
import type { Footage } from "@/lib/types";

/* Every figure on this panel traces back to something measured: a band the
   engine produced, a point someone can see on a frame, or a footprint whose
   ground sample distance is known. Nothing is modelled, forecast, or averaged
   into existence — if the data cannot answer, the panel says so. */

const GROUP_RADIUS_M = 5; // animals closer together than this are one group
const BARS = 20;          // a 380px column cannot draw more bars honestly
const H = 64;             // chart height, px

/* Withdrawn from the estimate: still evidence, never a figure. Nothing is
   deleted — the sortie keeps its points and its edits, it just stops being
   counted, and the trust panel reports how many were withdrawn and why. */
const isRetired = (f: Footage): boolean => (f.retiredAt ?? "").trim() !== "";

export default function Dashboard({ onClose }: { onClose?: ()=>void }){
  const { t, tp, lang } = useT();
  const footages = useFootageStore(s=>s.footages);
  const detections = useFootageStore(s=>s.detections);
  const timeRange = useFootageStore(s=>s.timeRange);
  const selectedId = useFootageStore(s=>s.selectedId);
  const select = useFootageStore(s=>s.select);
  const loadedRuns = useFootageStore(s=>s.loadedRuns);
  const totalRuns = useFootageStore(s=>s.totalRuns);
  /* Who is at the keyboard, when anyone has said. Nobody having said is the
     default and a truthful record: the report prints "not recorded" rather
     than putting a name on a document that nobody signed. */
  const [operator] = useOperator();
  const [exporting, setExporting] = useState(false);
  /* Which site's history is open. Keyed on the site's own identity, not on
     `site.id` — that is the group's index in the current grouping, so moving
     the timeline brush would have left the panel open on whatever site had
     slid into that slot. */
  const [openSite, setOpenSite] = useState<string | null>(null);

  /* The shared brush — the same window the footage list and the map read, from
     one implementation instead of four near-copies.

     Three sets come out of it, and keeping them apart is the point. A FAILED
     ingest is a Footage with a filename and nothing else: counted as a sortie
     it inflated "N animals observed across M sorties" and then appeared in the
     "without GSD" tally as a survey that had neglected to record its scale.
     A WITHDRAWN sortie is real evidence that has been retracted, and belongs
     in no figure either — but it is not the same claim as a failure, so it is
     counted separately and reported as its own line. */
  const filtered = useMemo(()=>{
    const inWindow = footagesInRange(footages, timeRange);
    const retired = inWindow.filter(isRetired);
    const live = inWindow.filter(f=> !isRetired(f));
    const f = live.filter(hasResult);
    return {
      f,
      retired,
      withoutResult: live.length - f.length,
      d: detectionsFor(f, detections),
    };
  },[footages,detections,timeRange]);

  /* A rejected detection is not an animal: false_positive is out of every
     total, every share and every histogram below. */
  const shown = useMemo(()=> filtered.d.filter(d=>d.status!=="false_positive"), [filtered.d]);
  /* The standing estimate leads; the sum over sorties is a statement about
     effort and is demoted to the line under it. See lib/analytics/estimate.ts. */
  const est = useMemo(()=> seasonEstimate(filtered.f), [filtered.f]);

  /* Surveyed ground. Sorties without a GSD have an unknown area, not a zero
     one: they are counted aside and the total is printed as "—" when none of
     them could be measured at all. */
  const area = useMemo(()=> totalAreaM2(filtered.f), [filtered.f]);
  const areaText = area.known ? formatArea(area.m2, lang) : null;
  /* Both qualifications, when both apply: sorties with no scale at all are
     missing from the total, and sorties whose scale the service ASSUMED (a
     guessed sensor width or lens) put a guess inside it. */
  const areaCaveat = [
    area.unknown ? t("dash.noGsd", { n: area.unknown }) : null,
    area.assumed ? t("dash.assumedGsd", { n: area.assumed }) : null,
  ].filter(Boolean).join(" · ") || undefined;

  /* Chronological, one bar per sortie — the latest BARS of them. */
  const bars = useMemo(()=>{
    const list = [...filtered.f].sort((a,b)=> +new Date(a.uploadedAt) - +new Date(b.uploadedAt));
    return list.slice(-BARS).map(f=>({
      f,
      best: countOf(f),
      low: f.band?.low ?? null,
      high: f.band?.high ?? null,
    }));
  },[filtered.f]);
  const maxBar = Math.max(...bars.map(b=> Math.max(b.high ?? 0, b.best)), 1);
  const day = (iso: string) => formatDate(iso, lang, { day:"numeric", month:"short" });

  /* The honest replacement for a forecast: the same place flown twice tells
     you something, one flight tells you nothing. */
  const repeats = useMemo(()=>
    groupIntoSites(filtered.f)
      .map(site=> ({ site, series: siteSeries(site) }))
      .filter(r=> r.series.length>=2)
      .sort((a,b)=> b.series.length - a.series.length),
  [filtered.f]);

  /* Group size is spatial, not a field on a detection: the engine counts one
     animal per point, so grouping has to come from the coordinates. Only
     placed points can take part — an animal with no lat/lng has no neighbours.

     count !== 1 is the aggregate marker a sortie gets when the engine counted
     but geo did not resolve: ONE synthetic point at the sortie centre carrying
     the whole band. Feeding it in made a haul-out of 562 animals render as a
     single group of size 1. It is not expanded into 562 fabricated
     coordinates either — it is excluded, and the panel says how many sorties
     could only contribute one. */
  const placed = useMemo(
    ()=> shown.filter(d=> d.count===1 && Number.isFinite(d.lat) && Number.isFinite(d.lng)),
    [shown],
  );
  const aggregateOnly = useMemo(
    ()=> filtered.f.filter(f=> f.detections.some(d=> d.status!=="false_positive" && d.count>1)).length,
    [filtered.f],
  );
  const bins = useMemo(()=> histogram(groupSizes(placed, GROUP_RADIUS_M)), [placed]);
  const maxBin = Math.max(...bins.map(b=> b.count), 1);

  /* Review, from the one helper that knows the difference between work not
     done and work this build cannot offer. The old arithmetic here was
     `validated / shown` over the detection rows in the window, which put a
     single aggregate marker standing for 562 animals in the denominator as
     one point — and left those 562 animals out of the panel entirely. */
  const review = useMemo(()=> seasonReviewStats(filtered.f), [filtered.f]);
  const reviewPct = Math.round(review.pct ?? 0);

  const largest = useMemo(()=>{
    let top: Footage | null = null;
    for(const f of filtered.f) if(!top || countOf(f)>countOf(top)) top = f;
    return top;
  },[filtered.f]);

  /** Select a sortie and take the camera to it — the one camera channel. */
  const goTo = (f: Footage) => {
    select(f.id);
    const { lat, lng } = f.center ?? ({} as { lat?: number; lng?: number });
    if (Number.isFinite(lat) && Number.isFinite(lng))
      document.dispatchEvent(new CustomEvent("flyto", { detail: { lat, lng, zoom: 10 } }));
  };

  /* The report pulls jsPDF plus an embedded font — hundreds of kilobytes over
     the network before a single page is drawn. Silence for that long reads as
     a dead button, and the promise's rejection used to go nowhere at all: an
     offline export failed invisibly. Pending, then said out loud either way. */
  const onExportPDF = async ()=>{
    if (exporting) return;
    setExporting(true);
    try {
      const { exportReport } = await import("@/lib/export/pdf");
      /* What the sorties cannot say about themselves: which slice of the
         archive this document is. The timeline brush and the hydrate's own
         "N of M" are the two ways a report can silently be a fragment. */
      const ext = timeExtent(footages);
      const brushWindow = ext && timeRange
        ? {
            from: new Date(ext.min + ext.span * (timeRange[0] / 100)).toISOString(),
            to: new Date(ext.min + ext.span * (timeRange[1] / 100)).toISOString(),
          }
        : null;
      await exportReport(filtered.f, lang, { operator, window: brushWindow, loadedRuns, totalRuns });
      toast.success(t("dash.exportOk"));
    } catch (e) {
      console.error("report export failed:", e);
      toast.error(t("dash.exportFail"));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="w-[380px] shrink-0 bg-surface border-l border-line flex flex-col overflow-hidden">
      <div className="h-9 shrink-0 pl-4 pr-1.5 flex items-center justify-between border-b border-line">
        <span className="label">{t("nav.analytics")}</span>
        <div className="flex items-center gap-1">
          <Button
            onClick={onExportPDF}
            icon="download"
            disabled={exporting}
            className="h-6 text-2xs"
          >
            {exporting ? `${t("dash.exporting")}…` : "PDF"}
          </Button>
          {onClose && <IconButton name="close" onClick={onClose} title={t("dash.closeAnalytics")} />}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {/* Headline figures — standing estimate, flown, covered.
            The lead number is no longer the sum over sorties: that sum counts
            the same haul-out once per visit. It is still printed, one line
            down, as what it honestly is. */}
        <div className="px-4 py-4 border-b border-line">
          {/* The two counts keep their intrinsic width; only the area column
              absorbs the squeeze. Three even thirds of 380px clipped a
              five-figure hectare total mid-number. */}
          <div className="flex gap-4">
            <div className="shrink-0"><Stat label={t("est.current")} value={est.current} /></div>
            <div className="shrink-0"><Stat label={t("stat.sorties")} value={filtered.f.length} /></div>
            {/* A measured scale and a guessed one must not print identically:
                the sub-line names whichever caveat applies to this total. */}
            <div className="min-w-0 flex-1">
              <Stat
                label={t("stat.area")}
                value={areaText ? t("dash.areaHa", { v: areaText }) : "—"}
                sub={areaCaveat}
              />
            </div>
          </div>
          {filtered.f.length>0 && (
            <div className="mt-3 space-y-1">
              <p className="text-2xs text-ink3">
                {t("est.observedSub", { n: est.observed, m: filtered.f.length })}
              </p>
              <p className="text-2xs text-ink3 leading-relaxed">
                {t("est.basis", { km: SITE_RADIUS_M/1000 })}
              </p>
            </div>
          )}
        </div>

        {/* One bar per sortie, with the band's low–high as a whisker */}
        <div className="px-4 py-4 border-b border-line">
          <SectionHead
            title={t("dash.perSortie")}
            right={filtered.f.length>BARS
              ? <span className="text-2xs text-ink3">{t("dash.lastN", { n: BARS })}</span>
              : undefined}
          />
          {bars.length===0
            ? <p className="text-sm text-ink3 mt-2.5">{t("dash.noSorties")}</p>
            : (
              <>
                <div className="flex items-end gap-1 mt-3" style={{ height: H }}>
                  {bars.map(b=>{
                    const hasRange = b.low!=null && b.high!=null && b.high>b.low;
                    return (
                      <button
                        key={b.f.id}
                        onClick={()=> goTo(b.f)}
                        title={`${b.f.filename} · ${b.best}${hasRange ? ` (${b.low}–${b.high})` : ""}`}
                        className="flex-1 relative h-full flex items-end min-w-[3px]"
                      >
                        <div
                          className={`w-full rounded-[2px] ${selectedId===b.f.id ? "bg-ink" : "bg-ink2"}`}
                          style={{ height: Math.max(2, (b.best/maxBar)*H) }}
                        />
                        {hasRange && (
                          <div
                            className="absolute left-1/2 -translate-x-1/2 w-px bg-ink3"
                            style={{
                              bottom: ((b.low as number)/maxBar)*H,
                              height: Math.max(1, (((b.high as number)-(b.low as number))/maxBar)*H),
                            }}
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-baseline justify-between text-2xs text-ink3 mt-1.5">
                  <span>{day(bars[0].f.uploadedAt)}</span>
                  <span>{day(bars[bars.length-1].f.uploadedAt)}</span>
                </div>
              </>
            )}
        </div>

        {/* Repeat surveys — the only comparison this data can support, and now
            a way in to the whole series rather than only its last step. */}
        <div className="px-4 py-4 border-b border-line">
          <SectionHead title={t("dash.repeatSurveys")} />
          {/* Both halves of "the same site, again": the time comparison AND the
              radius that decides what counts as the same site. Two sorties
              1.9 km apart are one haul-out here, and a reader who is shown a
              Δ has to be told that. */}
          {repeats.length>0 && (
            <p className="text-2xs text-ink3 mt-1">
              {t("dash.repeatBasis", { km: SITE_RADIUS_M/1000 })}
            </p>
          )}
          <div className="mt-2.5 space-y-2">
            {filtered.f.length===0 && <p className="text-sm text-ink3">{t("dash.noSorties")}</p>}
            {filtered.f.length>0 && repeats.length===0 && (
              <p className="text-sm text-ink3">{t("dash.repeatNone")}</p>
            )}
            {repeats.map(({ site, series })=>{
              const d = series[series.length-1].delta;
              const key = site.siteId
                ?? `${site.centroid.lat.toFixed(4)},${site.centroid.lng.toFixed(4)}`;
              const open = openSite===key;
              return (
                <div key={key}>
                  {/* A real button, not a div with a click handler: the row
                      opens the site's whole history, and something that opens
                      a panel has to be reachable from the keyboard. */}
                  <button
                    type="button"
                    onClick={()=> setOpenSite(open ? null : key)}
                    aria-expanded={open}
                    title={open ? t("dash.collapseSite") : t("dash.expandSite")}
                    className="w-full flex items-baseline justify-between gap-3 text-xs text-left rounded px-1 -mx-1 py-0.5 hover:bg-surface2"
                  >
                    {/* A person's name for the place when there is one, the
                        measured centroid when there is not — never a region
                        invented from a latitude. */}
                    <span className={`text-ink2 truncate ${site.name ? "" : "font-mono tnum"}`}>
                      {site.name ?? `${site.centroid.lat.toFixed(2)}, ${site.centroid.lng.toFixed(2)}`}
                    </span>
                    <span className="tnum text-ink3 shrink-0">
                      {series.length} {tp(series.length, "unit.sorties")}
                      {/* No delta when either sortie has no count — a gap is not a zero. */}
                      {d
                        ? <span className="text-ink ml-2">
                            Δ {d.abs>=0 ? "+" : ""}{d.abs}
                            {d.pct!=null && ` (${d.pct>=0 ? "+" : ""}${Math.round(d.pct)}%)`}
                          </span>
                        : <span className="ml-2">—</span>}
                    </span>
                  </button>
                  {open && <SiteDynamics site={site} series={series} onPick={goTo} />}
                </div>
              );
            })}
          </div>
        </div>

        {/* No "By region" section. It charted `center.lat > 44.5 ? "KZ-East" …`
            — a latitude bucket with a toponym printed on it — as if the survey
            had been broken down by place. A real place now has a NAME because
            someone typed one; where nobody has, the centroid still stands. */}

        {/* Group size — measured off the coordinates, not off a count field */}
        <div className="px-4 py-4 border-b border-line">
          <SectionHead
            title={t("dash.groupSize")}
            right={<span className="text-2xs text-ink3">{t("dash.groupSizeHint", { r: GROUP_RADIUS_M })}</span>}
          />
          {placed.length===0
            ? (
              <p className="text-sm text-ink3 mt-2.5">
                {t("dash.noPlaced")}
                {aggregateOnly>0 && <> {t("dash.aggregateOnly", { n: aggregateOnly })}</>}
              </p>
            )
            : (
              <div className="mt-3 flex gap-2">
                {bins.map(b=>(
                  <div key={b.label} className="flex-1 flex flex-col items-center gap-1.5">
                    <div className="h-12 w-full flex items-end">
                      <div
                        className={`w-full rounded-[2px] ${b.count ? "bg-ink2" : "bg-line-soft"}`}
                        style={{ height: Math.max(2, (b.count/maxBin)*48) }}
                      />
                    </div>
                    <span className="text-2xs tnum text-ink">{b.count}</span>
                    <span className="text-2xs text-ink3">{b.label}</span>
                  </div>
                ))}
              </div>
            )}
        </div>

        {/* Verification. 0% over points that exist is a fact worth printing, not
            a gap to hide. 0% over NO points is a different claim — it reads as
            "someone reviewed these and signed off on none" when the truth is
            that there is nothing to review — and animals with no reviewable row
            at all are a third claim again, so all three are said separately. */}
        <div className="px-4 py-4 border-b border-line">
          <SectionHead title={t("dash.verification")} />
          {review.total===0
            ? <p className="text-sm text-ink3 mt-2.5">{t("dash.nothingToVerify")}</p>
            : review.reviewable===0
              ? <p className="text-sm text-ink3 mt-2.5">{t("dash.onlyUnreviewable", { n: review.unreviewable })}</p>
              : <>
                  {/* The bar is progress through the work, so its numerator is
                      rulings of either kind. The split underneath is what the
                      rulings were — a season where every animal was rejected is
                      fully reviewed and found nothing, and those are two facts
                      that must not be collapsed into one share. */}
                  <p className="text-sm text-ink2 mt-2.5">
                    {t("dash.verifiedOf", { n: review.ruled, r: review.reviewable, pct: reviewPct })}
                  </p>
                  <div className="h-1 bg-line-soft rounded-full overflow-hidden mt-2">
                    <div className="h-full bg-ink2 rounded-full" style={{ width:`${reviewPct}%` }} />
                  </div>
                  <p className="text-2xs text-ink3 mt-1.5 leading-relaxed">
                    {t("dash.ruledSplit", { v: review.verified, x: review.rejected })}
                  </p>
                  {review.unreviewable>0 && (
                    <p className="text-2xs text-ink3 mt-1.5 leading-relaxed">
                      {t("dash.plusUnreviewable", { n: review.unreviewable })}
                    </p>
                  )}
                </>}
        </div>

        {/* How far any of the above can be trusted, in measured terms only. */}
        <TrustPanel
          footages={filtered.f}
          retired={filtered.retired}
          withoutResult={filtered.withoutResult}
        />

        {/* Derived summary — sentences the app assembled out of the figures
            above. It is NOT "Notes": a field note is a person's observation,
            it lives on the sortie that person flew, and putting a generated
            sentence under the same heading is exactly the machine/human
            confusion this product exists to prevent. */}
        <div className="px-4 py-4">
          <SectionHead title={t("dash.derivedTitle")} />
          <p className="text-sm text-ink2 mt-2.5 leading-relaxed">
            {filtered.f.length===0
              ? t("dash.notesEmpty")
              : <>
                  {areaText ? t("dash.notesArea", { a: areaText }) : t("dash.notesNoArea")}
                  {review.reviewable>0 && <> {t("dash.notesVerifiedPct", { n: review.ruled, total: review.reviewable, pct: reviewPct })}</>}
                  {review.unreviewable>0 && <> {t("dash.notesUnreviewable", { n: review.unreviewable })}</>}
                  {/* Named by its file, not by an invented region. */}
                  {largest && <> {t("dash.notesLargestSortie", { x: countOf(largest), sortie: largest.filename })}</>}
                </>}
          </p>
        </div>
      </div>
    </div>
  );
}
