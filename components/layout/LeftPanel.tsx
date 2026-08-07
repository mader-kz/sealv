"use client";
import { useMemo, useState } from "react";
import { useFootageStore } from "@/store/useFootageStore";
import { Button, Field, Stat, SectionHead, Pill } from "@/components/ui/primitives";
import Icon from "@/components/ui/Icon";

export default function LeftPanel(){
  const footages = useFootageStore(s=>s.footages);
  const detections = useFootageStore(s=>s.detections);
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
    const t=q.toLowerCase();
    return filteredByTime.filter(f=> !t || f.filename.toLowerCase().includes(t) || f.region.toLowerCase().includes(t) || f.id.toLowerCase().includes(t));
  },[filteredByTime,q]);

  const totalSeals = detections.filter(d=> filteredByTime.some(f=>f.id===d.footageId)).reduce((s,d)=>s+d.count,0);
  const coverage = filteredByTime.length ? Math.min(100, Math.round(filteredByTime.length*6.2)) : 0;

  const exportCSV = ()=>{
    const rows = ["id,filename,region,uploadedAt,centerLat,centerLng,trackPts,detections,seals,source"];
    for(const f of filtered){ const seals=f.detections.reduce((s,d)=>s+d.count,0); rows.push(`${f.id},${f.filename},${f.region},${f.uploadedAt},${f.center.lat},${f.center.lng},${f.track.length},${f.detections.length},${seals},${f.source}`); }
    const blob=new Blob([rows.join("\n")],{type:"text/csv"}); const url=URL.createObjectURL(blob);
    const a=document.createElement("a"); a.href=url; a.download=`tulen-footage-${new Date().toISOString().slice(0,10)}.csv`; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div className="w-[340px] shrink-0 bg-surface flex flex-col overflow-hidden h-full">
      {/* Headline numbers — figures first, no boxed KPI grid */}
      <div className="px-4 pt-4 pb-3.5 flex gap-6">
        <Stat label="Seals" value={totalSeals} />
        <Stat label="Sorties" value={filteredByTime.length} />
        <Stat label="Coverage" value={`${coverage}%`} />
      </div>

      <div className="px-3 pb-3 space-y-2 border-b border-line">
        <div className="flex gap-1.5">
          <Field value={q} onChange={setQ} placeholder="Filter footage" icon="search" />
          <Button icon="download" onClick={exportCSV} title="Export filtered as CSV" />
        </div>
        {footages.length===0 ? (
          <Button variant="primary" full onClick={seedTestData}>Load test data</Button>
        ) : (
          <button onClick={clearAll} className="text-2xs text-ink3 hover:text-ink transition-colors">
            Clear all footage
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        <SectionHead
          title={`Footage · ${filtered.length}`}
          className="px-3 h-8 sticky top-0 bg-surface border-b border-line-soft z-10"
        />

        {filtered.map(f=>{
          const sealCount = f.detections.reduce((s,d)=>s+d.count,0);
          const active = f.id===selectedId;
          return (
            <div
              key={f.id}
              onClick={()=>{
                select(f.id);
                const m=(window as any).__tulenMap;
                if(m){ try{ m.stop(); }catch{} m.easeTo({ center:[f.center.lng, f.center.lat], zoom: 10, duration: 300 }); }
              }}
              className={`group relative px-3 py-2.5 cursor-pointer border-b border-line-soft transition-colors ${active?"bg-surface2":"hover:bg-surface2/60"}`}
            >
              {active && <span className="absolute left-0 top-0 bottom-0 w-px bg-accent" />}
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-mono truncate text-ink">{f.filename}</span>
                {f.source==="test" && <Pill>test</Pill>}
                <span className="flex-1" />
                <span className="tnum text-sm text-ink">{sealCount}</span>
                <span className="text-2xs text-ink3">seals</span>
                <button
                  onClick={(e)=>{e.stopPropagation(); remove(f.id);}}
                  className="opacity-0 group-hover:opacity-100 text-ink3 hover:text-bad transition-opacity"
                  aria-label="Remove"
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
              <div className="text-xs text-ink3 mt-1 flex items-center gap-1.5">
                <span>{f.region}</span>
                <span className="text-line">·</span>
                <span className="tnum">{f.duration}s</span>
                <span className="text-line">·</span>
                <span className="tnum">{f.track.length} pts</span>
                <span className="text-line">·</span>
                <span className="tnum">{new Date(f.uploadedAt).toLocaleDateString("en-CA")}</span>
              </div>
            </div>
          );
        })}

        {filtered.length===0 && footages.length>0 && (
          <div className="p-6 text-center text-sm text-ink3">No footage matches “{q}”.</div>
        )}
        {footages.length===0 && (
          <div className="p-6 text-sm text-ink3 leading-relaxed">
            Drop an MP4 with a matching .SRT or .JSON track to ingest a sortie. Without GPS, pin the
            flight path on the map instead.
          </div>
        )}
      </div>
    </div>
  );
}
