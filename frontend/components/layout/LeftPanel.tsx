"use client";
import { useMemo, useState } from "react";
import { useFootageStore } from "@/store/useFootageStore";
import { Button, Field, Stat, SectionHead, Pill } from "@/components/ui/primitives";
import Icon from "@/components/ui/Icon";
import { useT } from "@/lib/i18n";
import { formatArea, totalAreaM2 } from "@/lib/analytics/area";
import { countOf } from "@/lib/analytics/count";
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
  const timeRange = useFootageStore(s=>s.timeRange);

  const filteredByTime = useMemo(()=>{
    if (footages.length===0) return footages;
    const dates = footages.map(f=> new Date(f.uploadedAt).getTime()).sort((a,b)=>a-b);
    const min=Math.min(...dates), max=Math.max(...dates); const span=max-min||1;
    const lo=min+span*(timeRange[0]/100), hi=min+span*(timeRange[1]/100);
    return footages.filter(f=>{ const t=new Date(f.uploadedAt).getTime(); return t>=lo && t<=hi; });
  },[footages,timeRange]);

  const filtered = useMemo(()=>{
    const needle=q.toLowerCase();
    return filteredByTime.filter(f=> !needle || f.filename.toLowerCase().includes(needle) || f.id.toLowerCase().includes(needle));
  },[filteredByTime,q]);

  /* countOf(), the one definition of "what did this sortie count" — so this
     headline, the analytics panel, the report and this file's own CSV cannot
     print four different numbers for one survey. It was summing every
     detection including the ones a reviewer had rejected, while the CSV two
     functions below already excluded them. */
  const totalSeals = useMemo(
    ()=> filteredByTime.reduce((s,f)=> s+countOf(f), 0),
    [filteredByTime],
  );

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
        f.track.length, f.detections.length, countOf(f),
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

  return (
    <div className="w-[340px] shrink-0 bg-surface flex flex-col overflow-hidden h-full">
      {/* Headline numbers — figures first, no boxed KPI grid */}
      <div className="px-4 pt-4 pb-3.5 flex gap-6">
        <Stat label={t("stat.seals")} value={totalSeals} />
        <Stat label={t("stat.sorties")} value={filteredByTime.length} />
        {/* stat.surveyed, not the analytics panel's longer stat.area: three
            figures share 340px here and a truncated label helps nobody. The
            sub-line is not optional: a sum over the sorties that HAVE a scale,
            printed bare, reads as the whole survey. */}
        <Stat label={t("stat.surveyed")} value={areaText} sub={areaSub} />
      </div>

      <div className="px-3 pb-3 space-y-2 border-b border-line">
        <div className="flex gap-1.5">
          <Field value={q} onChange={setQ} placeholder={t("left.filter")} icon="search" />
          <Button icon="download" onClick={exportCSV} title={t("left.exportCsvTitle")} />
        </div>
        {footages.length===0 ? (
          <Button variant="primary" full onClick={seedTestData}>{t("left.loadTest")}</Button>
        ) : (
          <button onClick={clearAll} className="text-2xs text-ink3 hover:text-ink transition-colors">
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
          return (
            <div
              key={f.id}
              onClick={()=>{
                select(f.id);
                const m=(window as any).__sealvMap;
                if(m){ try{ m.stop(); }catch{} m.easeTo({ center:[f.center.lng, f.center.lat], zoom: 10, duration: 300 }); }
              }}
              className={`group relative px-3 py-2.5 cursor-pointer border-b border-line-soft transition-colors ${active?"bg-surface2":"hover:bg-surface2/60"}`}
            >
              {active && <span className="absolute left-0 top-0 bottom-0 w-px bg-accent" />}
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-mono truncate text-ink">{f.filename}</span>
                {f.source==="test" && <Pill>{t("pill.test")}</Pill>}
                <span className="flex-1" />
                <span className="tnum text-sm text-ink">{sealCount}</span>
                <span className="text-2xs text-ink3">{tp(sealCount, "unit.seals")}</span>
                <button
                  onClick={(e)=>{e.stopPropagation(); remove(f.id);}}
                  className="opacity-0 group-hover:opacity-100 text-ink3 hover:text-bad transition-opacity"
                  aria-label={t("a11y.remove")}
                >
                  <Icon name="close" size={12} />
                </button>
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
                <span className="tnum">{new Date(f.uploadedAt).toLocaleDateString("en-CA")}</span>
              </div>
            </div>
          );
        })}

        {filtered.length===0 && footages.length>0 && (
          <div className="p-6 text-center text-sm text-ink3">{t("left.noMatch", { q })}</div>
        )}
        {footages.length===0 && (
          <div className="p-6 text-sm text-ink3 leading-relaxed">
            {t("left.emptyHint")}
          </div>
        )}
      </div>
    </div>
  );
}
