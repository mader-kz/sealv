"use client";
import { useMemo } from "react";
import { useFootageStore } from "@/store/useFootageStore";
import { mockForecast } from "@/lib/forecast/mockForecast";
import { detectAnomalies } from "@/lib/insights/anomaly";
import { SectionHead, Pill } from "@/components/ui/primitives";
import Icon from "@/components/ui/Icon";
import { localeFor, useT } from "@/lib/i18n";

export default function ForecastChart(){
  const { t, lang } = useT();
  const locale = localeFor(lang);
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

  /* The lib labels months in English; the window is deterministic (now-5 …
     now+3), so re-derive each label in the UI language by index instead of
     translating strings back. */
  const labels = useMemo(()=>{
    const now = new Date();
    return forecast.points.map((_,i)=>
      new Date(now.getFullYear(), now.getMonth()-5+i, 1).toLocaleString(locale,{month:"short"}));
  },[forecast.points, locale]);

  /* The summary sentence is rebuilt here (not taken from the lib) so it
     speaks the UI language; same arithmetic as the lib's own summary. */
  const summary = useMemo(()=>{
    const pts = forecast.points;
    if (pts.length < 9) return t("dash.noData");
    const last = pts[pts.length-1], base = pts[5];
    const pct = base.value ? Math.round(((last.value - base.value)/base.value)*100) : 0;
    return t("dash.forecastSummary", {
      v: last.value,
      m: labels[pts.length-1],
      pct: `${pct>=0?"+":""}${pct}`,
      m0: labels[5],
    });
  },[forecast.points, labels, t]);

  const maxV = Math.max(...forecast.points.map(p=>p.high), 1);
  const H = 64;

  return (
    <div>
      <SectionHead title={t("dash.forecast")} right={<Pill>{t("dash.modelled")}</Pill>} />

      <div className="flex items-end gap-1.5 mt-3" style={{ height: H }}>
        {forecast.points.map((p,i)=>{
          const h = Math.max(2, (p.value/maxV)*H);
          const bandH = Math.max(2, ((p.high - p.low)/maxV)*H);
          const bandBottom = (p.low/maxV)*H;
          return (
            <div key={p.date} className="flex-1 relative h-full flex items-end" title={`${labels[i]}: ${p.value}${p.isForecast ? ` (${t("dash.forecastRange",{low:p.low,high:p.high})})` : ""}`}>
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
        {forecast.points.map((p,i)=>(
          <span key={p.date} className={`flex-1 text-2xs text-center ${p.isForecast ? "text-accent" : "text-ink3"}`}>
            {labels[i]}
          </span>
        ))}
      </div>

      {summary && (
        <p className="text-sm text-ink2 mt-3 leading-relaxed">{summary}</p>
      )}

      {anomalies.length>0 && (
        <div className="mt-3 space-y-1.5">
          {anomalies.map(a=>(
            <div key={a.region} className="flex items-start gap-2 text-xs text-ink2">
              <Icon name="alert" size={12} className="text-accent mt-0.5" />
              <span>
                {t("dash.anomaly", {
                  region: a.region,
                  cur: a.current,
                  exp: a.expected,
                  delta: a.deltaPct,
                  n: a.footageIds.length,
                })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
