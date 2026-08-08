"use client";
import { useMemo, useState } from "react";
import { useFootageStore } from "@/store/useFootageStore";
import { Button, Field, Stat, SectionHead, Pill } from "@/components/ui/primitives";
import Icon from "@/components/ui/Icon";
import { useT } from "@/lib/i18n";
import { formatArea, totalAreaM2 } from "@/lib/analytics/area";
import { countOf } from "@/lib/analytics/count";
import { footagesInRange, formatDate } from "@/lib/analytics/brush";
import { seasonEstimate } from "@/lib/analytics/estimate";
import { csvCell, downloadText } from "@/lib/export/animals";

export default function LeftPanel(){
  const { t, tp, lang } = useT();
  const footages = useFootageStore(s=>s.footages);
  const selectedId = useFootageStore(s=>s.selectedId);
  const select = useFootageStore(s=>s.select);
  const remove = useFootageStore(s=>s.removeFootage);
  const seedTestData = useFootageStore(s=>s.seedTestData);
  const clearAll = useFootageStore(s=>s.clearAll);
  const [q, setQ] = useState("");
  const [pendingRemove, setPendingRemove] = useState<string|null>(null);
  const [pendingClear, setPendingClear] = useState(false);
  const timeRange = useFootageStore(s=>s.timeRange);
  /* Read defensively: the store gains these while the archive is being
     restored, and this panel must compile and behave whether or not that
     landing has happened yet. */
  const hydrating = useFootageStore(s=> ((s as any).hydrating ?? false) as boolean);

  const filteredByTime = useMemo(()=> footagesInRange(footages, timeRange), [footages,timeRange]);

  const filtered = useMemo(()=>{
    const needle=q.toLowerCase();
    return filteredByTime.filter(f=> !needle || f.filename.toLowerCase().includes(needle) || f.id.toLowerCase().includes(needle));
  },[filteredByTime,q]);

  /* The standing estimate, from the shared helper — the latest sortie at each
     site, not a sum over every sortie flown. The sum is still printed below it
     as what it actually measures: effort, not animals. One helper, so this
     headline, the map chip, the analytics panel and the report cannot print
     four different numbers for one season. */
  const est = useMemo(()=> seasonEstimate(filteredByTime), [filteredByTime]);

  /* Surveyed area — what the sorties actually photographed — replaces the old
     "coverage" stat, which was sorties × 6.2%, i.e. 17 flights = 100% of the
     Caspian. The shared helper, so the number and its precision match the
     analytics panel and the report exactly; sorties with no GSD are unknown,
     not zero, and the count of them is printed rather than swallowed. */
  const area = useMemo(()=> totalAreaM2(filteredByTime), [filteredByTime]);
  const areaText = area.known ? `${formatArea(area.m2, lang)} ${t("unit.ha")}` : "—";
  const areaSub = [
    area.unknown ? t("dash.noGsd", { n: area.unknown }) : null,
    area.assumed ? t("dash.assumedGsd", { n: area.assumed }) : null,
  ].filter(Boolean).join(" · ") || undefined;

  /* Per-sortie summary. Every column is measured: the band with its basis, the
     reviewed share, the photographed area. Filenames go through csvCell —
     a comma in a filename used to split a row into nonsense. */
  const exportCSV = ()=>{
    const rows = ["id,filename,uploadedAt,centerLat,centerLng,trackPts,detections,seals,low,best,high,basis,validated,auto,unplaced,areaM2,gsdSource,source"];
    for(const f of filtered){
      const area = f.areaM2;
      rows.push([
        f.id, csvCell(f.filename), f.uploadedAt, f.center.lat, f.center.lng,
        f.track.length,
        // Rejected rows live in this list too. The header says "detections",
        // which in every other figure this app prints means "animals the
        // review kept" — so a false positive is not one of them here either.
        f.detections.filter(d=>d.status!=="false_positive").length,
        countOf(f),
        f.band?.low ?? "", f.band?.best ?? "", f.band?.high ?? "", csvCell(f.band?.basis ?? ""),
        f.detections.filter(d=>d.status==="validated").length,
        f.detections.filter(d=>d.status==="auto").length,
        f.unplaced ?? 0,
        typeof area==="number" && Number.isFinite(area) ? area : "",
        // An assumed scale next to the area it produced: a reader outside this
        // app has no other way to tell a measured hectare from a guessed one.
        csvCell(f.gsdSource ?? ""),
        f.source,
      ].join(","));
    }
    downloadText(`sealv-footage-${new Date().toISOString().slice(0,10)}.csv`, "text/csv", rows.join("\n"));
  };

  /* One camera channel for the whole app. This reached through
     `window.__sealvMap`, a global the map happens to set — a second, private
     path to the same camera that nothing else could see or replace. */
  const flyTo = (lat:number, lng:number)=>{
    if(!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    document.dispatchEvent(new CustomEvent("flyto", { detail:{ lat, lng, zoom: 10 } }));
  };

  return (
    <div className="w-[340px] shrink-0 bg-surface flex flex-col overflow-hidden h-full">
      {/* Headline numbers — figures first, no boxed KPI grid.
          The sortie count lost its own column: it is in the line underneath
          and in the section header below, and the estimate's label needs the
          width in Kazakh. */}
      <div className="px-4 pt-4 pb-3.5">
        <div className="flex gap-5">
          <div className="shrink-0"><Stat label={t("est.current")} value={est.current} /></div>
          {/* stat.surveyed, not the analytics panel's longer stat.area: the
              sub-line is not optional — a sum over the sorties that HAVE a
              scale, printed bare, reads as the whole survey. */}
          <div className="min-w-0 flex-1"><Stat label={t("stat.surveyed")} value={areaText} sub={areaSub} /></div>
        </div>
        {/* The demoted total. Summing every sortie counts one haul-out once per
            visit, so it is effort, not a population — said in those words. */}
        {filteredByTime.length>0 && (
          <p className="text-2xs text-ink3 mt-2.5 leading-relaxed">
            {t("est.observedSub", { n: est.observed, m: filteredByTime.length })}
          </p>
        )}
      </div>

      <div className="px-3 pb-3 space-y-2 border-b border-line">
        <div className="flex gap-1.5">
          <Field value={q} onChange={setQ} placeholder={t("left.filter")} icon="search" />
          <Button icon="download" onClick={exportCSV} title={t("left.exportCsvTitle")} />
        </div>
        {footages.length===0 ? (
          /* Disabled while the archive is being read: seeding synthetic sorties
             into a store that hydrate() is about to fill is a race whose loser
             is the real data. */
          <Button variant="primary" full onClick={seedTestData} disabled={hydrating}>
            {hydrating ? `${t("est.restoring")}…` : t("left.loadTest")}
          </Button>
        ) : pendingClear ? (
          <div className="flex items-center gap-2 text-2xs">
            <span className="text-ink2">{t("left.confirmClear")}</span>
            <button
              onClick={()=>{ clearAll(); setPendingClear(false); }}
              className="text-bad hover:underline"
            >
              {t("btn.confirm")}
            </button>
            <button onClick={()=> setPendingClear(false)} className="text-ink3 hover:text-ink transition-colors">
              {t("btn.cancel")}
            </button>
          </div>
        ) : (
          /* Discarding the season's work took one click on a 10px link. */
          <button onClick={()=> setPendingClear(true)} className="text-2xs text-ink3 hover:text-ink transition-colors">
            {t("left.clearAll")}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        <SectionHead
          title={`${t("nav.footage")} · ${filtered.length}`}
          className="px-3 h-8 sticky top-0 bg-surface border-b border-line-soft z-10"
        />

        {filtered.map(f=>{
          const sealCount = countOf(f);
          const active = f.id===selectedId;
          const open = ()=>{ select(f.id); flyTo(f.center.lat, f.center.lng); };
          return (
            /* The app's primary navigation was a bare <div onClick>: no tab
               stop, no role, no key handler. */
            <div
              key={f.id}
              role="button"
              tabIndex={0}
              aria-current={active || undefined}
              onClick={open}
              onKeyDown={(e)=>{
                if(e.key==="Enter" || e.key===" "){ e.preventDefault(); open(); }
              }}
              className={`group relative px-3 py-2.5 cursor-pointer border-b border-line-soft transition-colors outline-none focus-visible:bg-surface2 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${active?"bg-surface2":"hover:bg-surface2/60"}`}
            >
              {active && <span className="absolute left-0 top-0 bottom-0 w-px bg-accent" />}
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-mono truncate text-ink" title={f.filename}>{f.filename}</span>
                {f.source==="test" && <Pill>{t("pill.test")}</Pill>}
                <span className="flex-1" />
                {/* A sortie still being counted has no band and no detections,
                    so countOf() is 0 — and "0 seals" reads as a finished survey
                    that found nothing. State, not a number, until there is one. */}
                {f.status==="processing" ? (
                  <Pill tone="accent">{t("left.processing")}…</Pill>
                ) : f.status==="error" ? (
                  <Pill tone="bad">{t("left.failed")}</Pill>
                ) : (
                  <>
                    <span className="tnum text-sm text-ink">{sealCount}</span>
                    <span className="text-2xs text-ink3">{tp(sealCount, "unit.seals")}</span>
                  </>
                )}
                {/* Removing a sortie is destructive and was one click on a
                    control that only existed on hover — invisible to keyboard
                    focus and absent on touch. Revealed on focus too, and it
                    asks first. */}
                {pendingRemove===f.id ? (
                  <span className="flex items-center gap-1.5 text-2xs" onClick={e=>e.stopPropagation()}>
                    <button
                      onClick={(e)=>{ e.stopPropagation(); setPendingRemove(null); remove(f.id); }}
                      className="text-bad hover:underline"
                      title={t("left.confirmRemove")}
                    >
                      {t("btn.confirm")}
                    </button>
                    <button
                      onClick={(e)=>{ e.stopPropagation(); setPendingRemove(null); }}
                      className="text-ink3 hover:text-ink transition-colors"
                    >
                      {t("btn.cancel")}
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={(e)=>{e.stopPropagation(); setPendingRemove(f.id);}}
                    onKeyDown={(e)=> e.stopPropagation()}
                    className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 text-ink3 hover:text-bad transition-opacity"
                    aria-label={t("a11y.remove")}
                    title={t("a11y.remove")}
                  >
                    <Icon name="close" size={12} />
                  </button>
                )}
              </div>
              <div className="text-xs text-ink3 mt-1 flex items-center gap-1.5">
                {/* The centre, not a latitude bucket named after a region. */}
                <span className="tnum">{f.center.lat.toFixed(2)}, {f.center.lng.toFixed(2)}</span>
                {f.duration>0 && <>
                  <span className="text-line">·</span>
                  <span className="tnum">{f.duration}{t("unit.s")}</span>
                </>}
                <span className="text-line">·</span>
                <span className="tnum">{f.track.length} {tp(f.track.length, "unit.points")}</span>
                <span className="text-line">·</span>
                {/* The reader's language, like every other date in the app —
                    this one was pinned to en-CA next to a localised one. */}
                <span className="tnum">{formatDate(f.uploadedAt, lang)}</span>
              </div>
            </div>
          );
        })}

        {filtered.length===0 && footages.length>0 && (
          <div className="p-6 text-center text-sm text-ink3">{t("left.noMatch", { q })}</div>
        )}
        {footages.length===0 && (
          <div className="p-6 text-sm text-ink3 leading-relaxed">
            {hydrating ? t("est.restoringBody") : t("left.emptyHint")}
          </div>
        )}
      </div>
    </div>
  );
}
