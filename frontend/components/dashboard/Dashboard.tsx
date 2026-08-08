"use client";
import { useMemo } from "react";
import { useFootageStore } from "@/store/useFootageStore";
import { Button, IconButton, SectionHead, Stat } from "@/components/ui/primitives";
import { totalAreaM2, formatArea } from "@/lib/analytics/area";
import { countOf } from "@/lib/analytics/count";
import { groupSizes, histogram } from "@/lib/analytics/groups";
import { groupIntoSites, siteSeries, SITE_RADIUS_M } from "@/lib/analytics/surveys";
import { localeFor, useT } from "@/lib/i18n";
import type { Footage } from "@/lib/types";

/* Every figure on this panel traces back to something measured: a band the
   engine produced, a point someone can see on a frame, or a footprint whose
   ground sample distance is known. Nothing is modelled, forecast, or averaged
   into existence — if the data cannot answer, the panel says so. */

const GROUP_RADIUS_M = 5; // animals closer together than this are one group
const BARS = 20;          // a 380px column cannot draw more bars honestly
const H = 64;             // chart height, px

export default function Dashboard({ onClose }: { onClose?: ()=>void }){
  const { t, tp, lang } = useT();
  const locale = localeFor(lang);
  const footages = useFootageStore(s=>s.footages);
  const detections = useFootageStore(s=>s.detections);
  const timeRange = useFootageStore(s=>s.timeRange);
  const selectedId = useFootageStore(s=>s.selectedId);
  const select = useFootageStore(s=>s.select);

  const filtered = useMemo(()=>{
    if (footages.length===0) return { f: [] as Footage[], d: [] as typeof detections };
    const dates = footages.map(f=> new Date(f.uploadedAt).getTime()).sort((a,b)=>a-b);
    const min = Math.min(...dates), max = Math.max(...dates);
    const span = max - min || 1;
    const lo = min + span * (timeRange[0]/100);
    const hi = min + span * (timeRange[1]/100);
    const f = footages.filter(ff=>{ const t = new Date(ff.uploadedAt).getTime(); return t>=lo && t<=hi; });
    const ids = new Set(f.map(x=>x.id));
    return { f, d: detections.filter(dd=> ids.has(dd.footageId)) };
  },[footages,detections,timeRange]);

  /* A rejected detection is not an animal: false_positive is out of every
     total, every share and every histogram below. */
  const shown = useMemo(()=> filtered.d.filter(d=>d.status!=="false_positive"), [filtered.d]);
  const totalSeals = useMemo(()=> filtered.f.reduce((s,f)=> s+countOf(f), 0), [filtered.f]);

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
  const day = (iso: string) => new Date(iso).toLocaleDateString(locale, { day:"numeric", month:"short" });

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

  const validated = shown.filter(d=>d.status==="validated").length;
  const verifiedPct = shown.length ? Math.round(validated/shown.length*100) : 0;

  const largest = useMemo(()=>{
    let top: Footage | null = null;
    for(const f of filtered.f) if(!top || countOf(f)>countOf(top)) top = f;
    return top;
  },[filtered.f]);

  const onExportPDF = async ()=>{
    const { exportReport } = await import("@/lib/export/pdf");
    await exportReport(filtered.f, lang);
  };

  return (
    <div className="w-[380px] shrink-0 bg-surface border-l border-line flex flex-col overflow-hidden">
      <div className="h-9 shrink-0 pl-4 pr-1.5 flex items-center justify-between border-b border-line">
        <span className="label">{t("nav.analytics")}</span>
        <div className="flex items-center gap-1">
          <Button onClick={onExportPDF} icon="download" className="h-6 text-2xs">PDF</Button>
          {onClose && <IconButton name="close" onClick={onClose} title={t("dash.closeAnalytics")} />}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {/* Headline figures — counted, flown, covered */}
        <div className="px-4 py-4 grid grid-cols-3 gap-4 border-b border-line">
          <Stat label={t("stat.seals")} value={totalSeals} />
          <Stat label={t("stat.sorties")} value={filtered.f.length} />
          {/* A measured scale and a guessed one must not print identically:
              the sub-line names whichever caveat applies to this total. */}
          <Stat
            label={t("stat.area")}
            value={areaText ? t("dash.areaHa", { v: areaText }) : "—"}
            sub={areaCaveat}
          />
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
                        onClick={()=>select(b.f.id)}
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

        {/* Repeat surveys — the only comparison this data can support */}
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
              return (
                <div key={site.id} className="flex items-baseline justify-between gap-3 text-xs">
                  {/* The site's measured centroid, not a made-up region name:
                      these sorties are grouped BY that centroid, so it is the
                      one label that is actually true of all of them. */}
                  <span className="text-ink2 truncate font-mono tnum">
                    {site.centroid.lat.toFixed(2)}, {site.centroid.lng.toFixed(2)}
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
                </div>
              );
            })}
          </div>
        </div>

        {/* No "By region" section. It charted `center.lat > 44.5 ? "KZ-East" …`
            — a latitude bucket with a toponym printed on it — as if the survey
            had been broken down by place. Sorties are identified by their
            measured centroid; a real regional breakdown needs the service's
            site table, and until it is wired through, nothing goes here. */}

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
            that there is nothing to review — so the empty set says so instead,
            the same absent-vs-empty distinction the caveats section makes. */}
        <div className="px-4 py-4 border-b border-line">
          <SectionHead title={t("dash.verification")} />
          {shown.length===0
            ? <p className="text-sm text-ink3 mt-2.5">{t("dash.nothingToVerify")}</p>
            : <>
                <p className="text-sm text-ink2 mt-2.5">
                  {t("dash.verifiedShare", { n: validated, pct: verifiedPct })}
                </p>
                <div className="h-1 bg-line-soft rounded-full overflow-hidden mt-2">
                  <div className="h-full bg-ink2 rounded-full" style={{ width:`${verifiedPct}%` }} />
                </div>
              </>}
        </div>

        {/* Notes — measured facts in sentences, no interpretation */}
        <div className="px-4 py-4">
          <SectionHead title={t("dash.notesTitle")} />
          <p className="text-sm text-ink2 mt-2.5 leading-relaxed">
            {filtered.f.length===0
              ? t("dash.notesEmpty")
              : <>
                  {areaText ? t("dash.notesArea", { a: areaText }) : t("dash.notesNoArea")}
                  {shown.length>0 && <> {t("dash.notesVerifiedPct", { n: validated, total: shown.length, pct: verifiedPct })}</>}
                  {/* Named by its file, not by an invented region. */}
                  {largest && <> {t("dash.notesLargestSortie", { x: countOf(largest), sortie: largest.filename })}</>}
                </>}
          </p>
        </div>
      </div>
    </div>
  );
}
