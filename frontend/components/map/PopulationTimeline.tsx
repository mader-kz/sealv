"use client";

import { useEffect, useMemo, useState } from "react";
import { bucketCheckpointSeries, type CheckpointCadence, type PopulationCheckpoint } from "@/lib/analytics/checkpoints";
import { localeForLang } from "@/lib/analytics/brush";
import { useT } from "@/lib/i18n";

type SeriesKey = "global" | "north" | "central" | "south";

const SERIES: SeriesKey[] = ["global", "north", "central", "south"];

const signed = (value: number) => value === 0 ? "0" : `${value > 0 ? "+" : ""}${value}`;

export default function PopulationTimeline({
  checkpoints,
  selectedId,
  onSelect,
  onOpen,
  onClose,
}: {
  checkpoints: PopulationCheckpoint[];
  selectedId: string | null;
  onSelect: (checkpoint: PopulationCheckpoint)=>void;
  onOpen: (footageId: string)=>void;
  onClose: ()=>void;
}) {
  const {t,lang}=useT();
  const [cadence,setCadence]=useState<CheckpointCadence>("day");
  const selected=checkpoints.find(checkpoint=>checkpoint.id===selectedId) ?? checkpoints[checkpoints.length-1] ?? null;
  const series=useMemo(()=>bucketCheckpointSeries(checkpoints,cadence),[checkpoints,cadence]);
  const locale=localeForLang(lang);
  const dateTime=(iso:string)=>{
    const date=new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(locale,{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"});
  };
  const shortDate=(iso:string)=>{
    const date=new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(locale,{day:"2-digit",month:"2-digit",year:"2-digit"});
  };
  const shortTime=(iso:string)=>{
    const date=new Date(iso);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(locale,{hour:"2-digit",minute:"2-digit"});
  };
  const graphTimestamp=(iso:string)=>{
    const date=new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(locale,{day:"2-digit",month:"2-digit",year:"2-digit",hour:"2-digit",minute:"2-digit"});
  };
  useEffect(()=>{
    const close=(event:KeyboardEvent)=>{ if(event.key==="Escape") onClose(); };
    document.addEventListener("keydown",close);
    return ()=>document.removeEventListener("keydown",close);
  },[onClose]);
  if(!selected || checkpoints.length===0) return null;

  return (
    <section
      data-population-timeline
      role="dialog"
      aria-labelledby="population-timeline-title"
      className="overflow-hidden border border-line bg-bg shadow-[0_18px_60px_rgba(0,0,0,0.58)]"
    >
      <header className="flex items-start justify-between gap-6 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 id="population-timeline-title" className="text-sm font-medium text-ink">{t("checkpoint.historyTitle")}</h2>
          <p className="mt-1 max-w-[820px] text-2xs leading-relaxed text-ink3">{t("checkpoint.explain")}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("btn.close")}
          title={t("btn.close")}
          className="grid h-7 w-7 shrink-0 place-items-center border border-line text-ink3 hover:border-ink4 hover:bg-surface2 hover:text-ink"
        >
          ×
        </button>
      </header>

      <div className="grid min-h-[106px] grid-cols-[270px_minmax(0,1fr)] divide-x divide-line-soft">
        <div className="px-4 py-3 min-w-0">
          <div className="flex items-baseline justify-between gap-3">
            <span className="hd">{t("checkpoint.selected")}</span>
            <span className="text-2xs text-ink4 tnum">{selected.index+1}/{checkpoints.length}</span>
          </div>
          <button
            type="button"
            onClick={()=>onOpen(selected.footageId)}
            className="mt-2 block w-full text-left group"
            title={t("site.openSortie")}
          >
            <span className="block truncate text-xs text-ink2 group-hover:text-ink">{selected.filename || t("report.noFile")}</span>
            <span className="mt-1 block text-2xs text-ink3 tnum">{t("checkpoint.ingested")}: {dateTime(selected.ingestedAt)}</span>
            {selected.observedAt!==selected.ingestedAt && (
              <span className="mt-0.5 block text-2xs text-ink4 tnum">{t("checkpoint.observed")}: {dateTime(selected.observedAt)}</span>
            )}
          </button>
          <div className="mt-2 flex items-end gap-2">
            <span className="text-2xl leading-none text-accent tnum">{selected.snapshot.global}</span>
            <span className={`pb-0.5 text-xs tnum ${selected.delta.global>0 ? "text-good" : selected.delta.global<0 ? "text-bad" : "text-ink3"}`}>
              {signed(selected.delta.global)}
            </span>
          </div>
          <p className="mt-1 text-[10px] text-ink4">{t("checkpoint.deltaHelp")}</p>
        </div>

        <div className="min-w-0 px-4 py-2.5">
          <div className="flex items-center justify-between gap-4">
            <span className="text-2xs text-ink3">{t("checkpoint.trend")}</span>
            <div className="plate flex p-0.5" aria-label={t("checkpoint.cadence")}>
              {(["day","week"] as const).map(value=>(
                <button
                  key={value}
                  type="button"
                  aria-pressed={cadence===value}
                  onClick={()=>setCadence(value)}
                  className={`px-2 py-1 text-2xs ${cadence===value ? "bg-surface2 text-ink" : "text-ink3 hover:text-ink2"}`}
                >
                  {t(`checkpoint.${value}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-1.5 grid grid-cols-4 gap-3">
            {SERIES.map(key=><MiniTrend key={key} name={key} points={series} selectedId={selected.id} selectedValue={selected.snapshot[key]} onSelect={onSelect} label={t(`region.${key}`)} formatTimestamp={graphTimestamp} />)}
          </div>
        </div>
      </div>

      <div className="border-t border-line-soft px-4 pt-2 text-[10px] text-ink4">{t("checkpoint.timelineHint")}</div>
      <div className="flex h-[62px] items-stretch px-3 overflow-x-auto" aria-label={t("checkpoint.timeline")}>
        {checkpoints.map((checkpoint,index)=>{
          const active=checkpoint.id===selected.id;
          return (
            <button
              key={checkpoint.id}
              type="button"
              data-checkpoint-id={checkpoint.id}
              data-timestamp-id={checkpoint.id}
              aria-pressed={active}
              aria-label={`${checkpoint.filename || t("report.noFile")} · ${dateTime(checkpoint.ingestedAt)} · ${checkpoint.snapshot.global}`}
              title={`${checkpoint.filename || t("report.noFile")} · ${dateTime(checkpoint.ingestedAt)} · ${checkpoint.snapshot.global}`}
              onClick={()=>onSelect(checkpoint)}
              onKeyDown={event=>{
                if(event.key!=="ArrowLeft" && event.key!=="ArrowRight") return;
                event.preventDefault();
                const next=Math.max(0,Math.min(checkpoints.length-1,index+(event.key==="ArrowLeft"?-1:1)));
                onSelect(checkpoints[next]);
                (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
              }}
              className={`group relative min-w-[62px] flex-1 px-1 pt-1.5 text-center outline-none ${active ? "text-accent" : "text-ink4 hover:text-ink2"}`}
            >
              <span className={`absolute left-1/2 top-0 h-4 w-px ${active ? "bg-accent" : "bg-line group-hover:bg-ink3"}`} />
              <span className={`absolute left-1/2 top-[13px] h-1.5 w-1.5 -translate-x-1/2 border ${active ? "border-accent bg-accent" : "border-ink4 bg-bg group-hover:border-ink2"}`} />
              <span className="mt-5 block truncate text-[9px] leading-none tnum">{shortDate(checkpoint.ingestedAt)}</span>
              <span className="mt-1 block truncate text-[8px] leading-none text-ink4 tnum">{shortTime(checkpoint.ingestedAt)}</span>
              <span className={`mt-1 block text-[10px] leading-none tnum ${active ? "text-accent" : "text-ink3"}`}>{checkpoint.snapshot.global}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function MiniTrend({
  name,points,selectedId,selectedValue,onSelect,label,formatTimestamp,
}: {
  name:SeriesKey;
  points:PopulationCheckpoint[];
  selectedId:string;
  selectedValue:number;
  onSelect:(checkpoint:PopulationCheckpoint)=>void;
  label:string;
  formatTimestamp:(iso:string)=>string;
}) {
  const [hoveredId,setHoveredId]=useState<string|null>(null);
  const width=210,height=54,pad={l:3,r:3,t:7,b:4};
  const values=points.map(point=>point.snapshot[name]);
  const min=Math.min(...values,0),max=Math.max(...values,1);
  const span=max-min || 1;
  const x=(index:number)=>points.length<=1 ? width/2 : pad.l+(index/(points.length-1))*(width-pad.l-pad.r);
  const y=(value:number)=>pad.t+(1-(value-min)/span)*(height-pad.t-pad.b);
  const path=points.map((point,index)=>`${index===0?"M":"L"}${x(index)},${y(point.snapshot[name])}`).join(" ");
  const hoveredIndex=points.findIndex(point=>point.id===hoveredId);
  const hovered=hoveredIndex>=0 ? points[hoveredIndex] : null;
  const hoverX=hovered ? Math.max(55,Math.min(width-55,x(hoveredIndex))) : 0;
  const hoverPointY=hovered ? y(hovered.snapshot[name]) : 0;
  const hoverY=hovered ? (hoverPointY<34 ? hoverPointY+7 : hoverPointY-37) : 0;
  return (
    <div data-regional-trend data-series={name} className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[10px] text-ink3">{label}</span>
        <span className="text-xs text-ink tnum">{selectedValue}</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="mt-0.5 block h-[48px] w-full overflow-visible" role="img" aria-label={label}>
        <line x1={pad.l} x2={width-pad.r} y1={height-pad.b} y2={height-pad.b} stroke="var(--hair)" />
        <path d={path} fill="none" stroke={name==="global"?"var(--accent)":"var(--ink-3)"} strokeWidth={name==="global"?1.5:1} />
        {points.map((point,index)=>{
          const active=point.id===selectedId;
          const hoverLabel=`${label}: ${point.snapshot[name]} · ${formatTimestamp(point.ingestedAt)}`;
          return (
            <g
              key={point.id}
              data-trend-timestamp-id={point.id}
              role="button"
              tabIndex={0}
              aria-label={hoverLabel}
              onMouseEnter={()=>setHoveredId(point.id)}
              onMouseLeave={()=>setHoveredId(current=>current===point.id ? null : current)}
              onFocus={()=>setHoveredId(point.id)}
              onBlur={()=>setHoveredId(current=>current===point.id ? null : current)}
              onClick={()=>onSelect(point)}
              onKeyDown={event=>{
                if(event.key!=="Enter" && event.key!==" ") return;
                event.preventDefault();
                onSelect(point);
              }}
              style={{cursor:"pointer",outline:"none"}}
            >
              <title>{hoverLabel}</title>
              <circle cx={x(index)} cy={y(point.snapshot[name])} r={7} fill="transparent" />
              <circle cx={x(index)} cy={y(point.snapshot[name])} r={active?3.2:1.8} fill={active?"var(--accent)":name==="global"?"var(--accent)":"var(--ink-3)"} />
            </g>
          );
        })}
        {hovered && (
          <g data-graph-tooltip pointerEvents="none">
            <rect x={hoverX-53} y={hoverY} width={106} height={31} fill="var(--bg)" stroke="var(--ink-3)" strokeWidth={0.7} />
            <text x={hoverX} y={hoverY+12} textAnchor="middle" fill="var(--ink)" fontSize={10.5} fontWeight={600}>{hovered.snapshot[name]}</text>
            <text x={hoverX} y={hoverY+24} textAnchor="middle" fill="var(--ink-3)" fontSize={7.5}>{formatTimestamp(hovered.ingestedAt)}</text>
          </g>
        )}
      </svg>
    </div>
  );
}
