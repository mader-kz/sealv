"use client";
import { useMemo } from "react";
import { useFootageStore } from "@/store/useFootageStore";
import { mockForecast } from "@/lib/forecast/mockForecast";
import { detectAnomalies } from "@/lib/insights/anomaly";
import { SectionHead, Pill } from "@/components/ui/primitives";
import Icon from "@/components/ui/Icon";

export default function ForecastChart(){
  const footages = useFootageStore(s=>s.footages);
  const detections = useFootageStore(s=>s.detections);
  const timeRange = useFootageStore(s=>s.timeRange);

  const filteredFootages = useMemo(()=>{
    if(footages.length===0) return [];
    const dates=footages.map(f=> new Date(f.uploadedAt).getTime()).sort((a,b)=>a-b);
    const min=Math.min(...dates), max=Math.max(...dates), span=max-min||1;
    const lo=min+span*(timeRange[0]/100), hi=min+span*(timeRange[1]/100);
    return footages.filter(f=>{ const t=new Date(f.uploadedAt).getTime(); return t>=lo && t<=hi; });
  },[footages,timeRange]);

  const forecast = useMemo(()=> mockForecast(filteredFootages), [filteredFootages]);
  const anomalies = useMemo(()=> detectAnomalies(filteredFootages, detections), [filteredFootages, detections]);

  const maxV = Math.max(...forecast.points.map(p=>p.high), 1);
  const H = 64;

  return (
    <div>
      <SectionHead title="Forecast" right={<Pill>modelled</Pill>} />

      <div className="flex items-end gap-1.5 mt-3" style={{ height: H }}>
        {forecast.points.map(p=>{
          const h = Math.max(2, (p.value/maxV)*H);
          const bandH = Math.max(2, ((p.high - p.low)/maxV)*H);
          const bandBottom = (p.low/maxV)*H;
          return (
            <div key={p.date} className="flex-1 relative h-full flex items-end" title={`${p.date}: ${p.value}${p.isForecast ? ` (${p.low}–${p.high} forecast)` : ""}`}>
              {p.isForecast && (
                <div
                  className="absolute w-full rounded-[2px] bg-accent/12 pointer-events-none"
                  style={{ height: bandH, bottom: bandBottom }}
                />
              )}
              <div
                className={`relative w-full rounded-[2px] ${p.isForecast ? "bg-accent/70" : "bg-ink2"}`}
                style={{ height: h }}
              />
            </div>
          );
        })}
      </div>

      <div className="flex gap-1.5 mt-1.5">
        {forecast.points.map(p=>(
          <span key={p.date} className={`flex-1 text-2xs text-center ${p.isForecast ? "text-accent" : "text-ink3"}`}>
            {p.date}
          </span>
        ))}
      </div>

      {forecast.summary && (
        <p className="text-sm text-ink2 mt-3 leading-relaxed">{forecast.summary}</p>
      )}

      {anomalies.length>0 && (
        <div className="mt-3 space-y-1.5">
          {anomalies.map(a=>(
            <div key={a.region} className="flex items-start gap-2 text-xs text-ink2">
              <Icon name="alert" size={12} className="text-accent mt-0.5" />
              <span>
                <span className="text-ink">{a.region}</span> counted <span className="tnum">{a.current}</span> against{" "}
                <span className="tnum">{a.expected}</span> expected ({a.deltaPct}%) — {a.footageIds.length} sorties to review.
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
