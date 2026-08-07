"use client";
import { useMemo, useRef, useState } from "react";
import { useFootageStore } from "@/store/useFootageStore";

export default function Timeline({ minimal }: { minimal?: boolean }){
  const footages = useFootageStore(s=>s.footages);
  const timeRange = useFootageStore(s=>s.timeRange);
  const setTimeRange = useFootageStore(s=>s.setTimeRange);
  const [dragging, setDragging] = useState<"left"|"right"|null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const { bins, labels } = useMemo(()=>{
    const N = 56;
    if (footages.length===0) return { bins: Array(N).fill(0), labels: ["",""] as string[] };
    const times = footages.map(f=> new Date(f.uploadedAt).getTime());
    const min = Math.min(...times), max = Math.max(...times);
    const span = max - min || 1;
    const b = Array(N).fill(0);
    for(const f of footages){
      const idx = Math.min(N-1, Math.max(0, Math.floor((new Date(f.uploadedAt).getTime()-min)/span*N)));
      b[idx] += f.detections.reduce((s,d)=>s+d.count,0) || 1;
    }
    const fmt = (t:number)=> new Date(t).toLocaleDateString("en-CA");
    return { bins: b, labels: [fmt(min), fmt(max)] };
  },[footages]);

  const maxV = Math.max(...bins, 1);

  const onPointerDown = (e: React.PointerEvent, which:"left"|"right")=>{
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(which);
  };
  const onPointerMove = (e: React.PointerEvent)=>{
    if(!dragging || !barRef.current) return;
    const rect = barRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(100, ((e.clientX - rect.left)/rect.width)*100));
    if(dragging==="left") setTimeRange([Math.min(pct, timeRange[1]-4), timeRange[1]]);
    else setTimeRange([timeRange[0], Math.max(pct, timeRange[0]+4)]);
  };
  const onPointerUp = ()=> setDragging(null);

  const [left, right] = timeRange;
  const filteredOut = left > 0 || right < 100;
  const h = minimal ? 34 : 60;

  return (
    <div
      className="shrink-0 flex items-center gap-3 px-3 bg-bg border-t border-line select-none"
      style={{ height: h }}
    >
      <span className="label shrink-0 whitespace-nowrap">{filteredOut ? "Filtered" : "All time"}</span>

      <div
        ref={barRef}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        className="flex-1 relative h-full flex items-end gap-px py-2"
      >
        {bins.map((v,i)=>{
          const pct = (i/(bins.length-1))*100;
          const inRange = pct >= left && pct <= right;
          return (
            <div
              key={i}
              className="flex-1 rounded-[1px] transition-colors"
              style={{
                height: `${Math.max(2, (v/maxV)*100)}%`,
                background: v===0 ? "var(--line-soft)" : inRange ? "var(--ink-2)" : "var(--line)",
              }}
            />
          );
        })}

        {/* brush: dim what's excluded rather than tint what's included */}
        {left > 0 && <div className="absolute inset-y-0 left-0 bg-bg/70 pointer-events-none" style={{ width:`${left}%` }} />}
        {right < 100 && <div className="absolute inset-y-0 right-0 bg-bg/70 pointer-events-none" style={{ width:`${100-right}%` }} />}

        <Handle pct={left} onDown={e=>onPointerDown(e,"left")} />
        <Handle pct={right} onDown={e=>onPointerDown(e,"right")} />
      </div>

      <div className="hidden sm:flex items-center gap-3 shrink-0 text-2xs text-ink3">
        <span className="tnum">{labels[0] || "—"} → {labels[1] || "—"}</span>
        {filteredOut && (
          <button onClick={()=> setTimeRange([0,100])} className="text-ink2 hover:text-ink transition-colors">
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

function Handle({ pct, onDown }: { pct:number; onDown:(e:React.PointerEvent)=>void }){
  return (
    <div
      onPointerDown={onDown}
      className="absolute inset-y-0 w-3 -ml-1.5 cursor-ew-resize group"
      style={{ left: `${pct}%` }}
    >
      <div className="absolute inset-y-0 left-1/2 w-px bg-accent" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1.5 h-4 rounded-sm bg-accent opacity-70 group-hover:opacity-100 transition-opacity" />
    </div>
  );
}
