"use client";
import { useMemo } from "react";
import { useFootageStore } from "@/store/useFootageStore";
import ForecastChart from "./ForecastChart";
import { Button, IconButton, SectionHead, Stat } from "@/components/ui/primitives";

export default function Dashboard({ onClose }: { onClose?: ()=>void }){
  const footages = useFootageStore(s=>s.footages);
  const detections = useFootageStore(s=>s.detections);
  const timeRange = useFootageStore(s=>s.timeRange);

  const filtered = useMemo(()=>{
    if (footages.length===0) return { f: [], d: [] as typeof detections };
    const dates = footages.map(f=> new Date(f.uploadedAt).getTime()).sort((a,b)=>a-b);
    const min = Math.min(...dates), max = Math.max(...dates);
    const span = max - min || 1;
    const lo = min + span * (timeRange[0]/100);
    const hi = min + span * (timeRange[1]/100);
    const f = footages.filter(ff=>{ const t = new Date(ff.uploadedAt).getTime(); return t>=lo && t<=hi; });
    const ids = new Set(f.map(x=>x.id));
    return { f, d: detections.filter(dd=> ids.has(dd.footageId)) };
  },[footages,detections,timeRange]);

  const totalSeals = filtered.d.reduce((s,d)=>s+d.count,0);
  const avg = filtered.d.length ? (totalSeals/filtered.d.length).toFixed(1) : "—";
  const density = filtered.f.length ? (totalSeals / (filtered.f.length * 8)).toFixed(2) : "—";

  const trend = useMemo(()=>{
    const buckets: Record<string, number> = {};
    const labels: string[] = [];
    const now = new Date();
    for(let i=5;i>=0;i--){
      const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
      const key = d.toLocaleString("en",{month:"short"});
      buckets[key]=0; labels.push(key);
    }
    for(const f of filtered.f){
      const m = new Date(f.uploadedAt).toLocaleString("en",{month:"short"});
      if (buckets[m]!==undefined) buckets[m]+= f.detections.reduce((s,dd)=>s+dd.count,0);
    }
    return labels.map(l=> ({ label:l, value: buckets[l] }));
  },[filtered.f]);

  const byRegion = useMemo(()=>{
    const m: Record<string, number> = {};
    for(const f of filtered.f) m[f.region] = (m[f.region]||0) + f.detections.reduce((s,d)=>s+d.count,0);
    return Object.entries(m).sort((a,b)=>b[1]-a[1]);
  },[filtered.f]);

  const hist = useMemo(()=>{
    const bins: Record<string, number> = { "1":0, "2–3":0, "4–6":0, "7+":0 };
    for(const d of filtered.d){
      if(d.count===1) bins["1"]++;
      else if(d.count<=3) bins["2–3"]++;
      else if(d.count<=6) bins["4–6"]++;
      else bins["7+"]++;
    }
    return Object.entries(bins);
  },[filtered.d]);

  const maxTrend = Math.max(...trend.map(t=>t.value), 1);
  const maxHist = Math.max(...hist.map(([,v])=>v), 1);
  const largest = filtered.d.length ? Math.max(...filtered.d.map(d=>d.count)) : null;

  const onExportPDF = async ()=>{
    const { exportPDF } = await import("@/lib/export/pdf");
    await exportPDF(filtered.f);
  };

  return (
    <div className="w-[380px] shrink-0 bg-surface border-l border-line flex flex-col overflow-hidden">
      <div className="h-9 shrink-0 pl-4 pr-1.5 flex items-center justify-between border-b border-line">
        <span className="label">Analytics</span>
        <div className="flex items-center gap-1">
          <Button onClick={onExportPDF} icon="download" className="h-6 text-2xs">PDF</Button>
          {onClose && <IconButton name="close" onClick={onClose} title="Close analytics" />}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {/* Headline figures */}
        <div className="px-4 py-4 grid grid-cols-3 gap-4 border-b border-line">
          <Stat label="Seals" value={totalSeals} sub={`${density}/km²`} />
          <Stat label="Sorties" value={filtered.f.length} />
          <Stat label="Avg / video" value={avg} />
        </div>

        {/* Trend */}
        <div className="px-4 py-4 border-b border-line">
          <SectionHead title="Seals per month" right={<span className="text-2xs text-ink3">6 mo</span>} />
          <div className="flex items-end gap-1.5 h-20 mt-3">
            {trend.map(t=>(
              <div key={t.label} className="flex-1 flex flex-col items-center gap-1.5 h-full justify-end" title={`${t.label}: ${t.value}`}>
                <span className="text-2xs tnum text-ink3">{t.value || ""}</span>
                <div
                  className="w-full rounded-[2px] bg-ink2"
                  style={{ height: `${Math.max(2, (t.value/maxTrend)*56)}px` }}
                />
                <span className="text-2xs text-ink3">{t.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Region */}
        <div className="px-4 py-4 border-b border-line">
          <SectionHead title="By region" />
          <div className="mt-3 space-y-2.5">
            {byRegion.length===0 && <p className="text-sm text-ink3">No sorties in the selected window.</p>}
            {byRegion.map(([region, seals])=>{
              const pct = totalSeals ? Math.round(seals/totalSeals*100) : 0;
              return (
                <div key={region}>
                  <div className="flex items-baseline justify-between text-xs mb-1">
                    <span className="text-ink2">{region}</span>
                    <span className="tnum text-ink">{seals} <span className="text-ink3">{pct}%</span></span>
                  </div>
                  <div className="h-1 bg-line-soft rounded-full overflow-hidden">
                    <div className="h-full bg-ink2 rounded-full" style={{ width:`${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Group size */}
        <div className="px-4 py-4 border-b border-line">
          <SectionHead title="Group size" right={<span className="text-2xs text-ink3">videos</span>} />
          <div className="mt-3 grid grid-cols-4 gap-2">
            {hist.map(([bin, cnt])=>(
              <div key={bin} className="flex flex-col items-center gap-1.5">
                <div className="h-12 w-full flex items-end">
                  <div
                    className={`w-full rounded-[2px] ${cnt ? "bg-ink2" : "bg-line-soft"}`}
                    style={{ height: `${Math.max(2, (cnt/maxHist)*48)}px` }}
                  />
                </div>
                <span className="text-2xs tnum text-ink">{cnt}</span>
                <span className="text-2xs text-ink3">{bin}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="px-4 py-4 border-b border-line">
          <ForecastChart />
        </div>

        {/* Notes — plain sentences, not bulleted "insight" filler */}
        <div className="px-4 py-4">
          <SectionHead title="Notes" />
          <p className="text-sm text-ink2 mt-2.5 leading-relaxed">
            {filtered.f.length === 0
              ? "Widen the timeline or ingest footage to populate analytics."
              : <>Average density is <span className="text-ink tnum">{density}</span> seals/km² across {filtered.f.length} sorties.
                 {largest !== null && <> The largest single count was <span className="text-ink tnum">{largest}</span>{byRegion[0] && <> in {byRegion[0][0]}</>}.</>}
              </>}
          </p>
        </div>
      </div>
    </div>
  );
}
