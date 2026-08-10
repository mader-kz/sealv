"use client";
import { useMemo, useRef, useState } from "react";
import { useFootageStore } from "@/store/useFootageStore";
import { countOf } from "@/lib/analytics/count";
import { formatDate, timeExtent } from "@/lib/analytics/brush";
import { useT } from "@/lib/i18n";

/** Minimum window width, percent — the two handles may not cross. */
const GAP = 4;
/** Percent per arrow key, and per arrow key with shift / PageUp-Down. */
const STEP = 1;
const BIG = 10;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export default function Timeline({ minimal }: { minimal?: boolean }){
  const { t, lang } = useT();
  const footages = useFootageStore(s=>s.footages);
  const timeRange = useFootageStore(s=>s.timeRange);
  const setTimeRange = useFootageStore(s=>s.setTimeRange);
  const [dragging, setDragging] = useState<"left"|"right"|null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const { bins, extent } = useMemo(()=>{
    const N = 56;
    const ext = timeExtent(footages);
    if (!ext) return { bins: Array(N).fill(0) as number[], extent: null };
    const b: number[] = Array(N).fill(0);
    for(const f of footages){
      const t = Date.parse(f.uploadedAt);
      const at = Number.isFinite(t) ? t : ext.min;
      const idx = Math.min(N-1, Math.max(0, Math.floor((at-ext.min)/ext.span*N)));
      /* countOf(), the one definition of what a sortie counted. This used to be
         `f.detections.reduce((s,d)=>s+d.count,0) || 1` — a fifth private one
         that ignored the engine's band, ignored the animals it could not place,
         counted the detections a reviewer had REJECTED, and then drew a bar of
         height 1 for a sortie that honestly found nothing. A zero is a zero. */
      b[idx] += countOf(f);
    }
    return { bins: b, extent: ext };
  },[footages]);

  const maxV = Math.max(...bins, 1);
  /* The date a brush position stands for — the handle's accessible value, and
     the only way a screen-reader user can tell where they have dragged to. */
  const dateAt = (pct: number) =>
    extent ? formatDate(new Date(extent.min + extent.span * (clamp(pct,0,100)/100)).toISOString(), lang) : "—";
  const labels: [string, string] = extent
    ? [formatDate(new Date(extent.min).toISOString(), lang), formatDate(new Date(extent.max).toISOString(), lang)]
    : ["—", "—"];

  const onPointerDown = (e: React.PointerEvent, which:"left"|"right")=>{
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(which);
  };
  const onPointerMove = (e: React.PointerEvent)=>{
    if(!dragging || !barRef.current) return;
    const rect = barRef.current.getBoundingClientRect();
    const pct = clamp(((e.clientX - rect.left)/rect.width)*100, 0, 100);
    if(dragging==="left") setTimeRange([Math.min(pct, timeRange[1]-GAP), timeRange[1]]);
    else setTimeRange([timeRange[0], Math.max(pct, timeRange[0]+GAP)]);
  };
  const onPointerUp = ()=> setDragging(null);

  const [left, right] = timeRange;
  const filteredOut = left > 0 || right < 100;
  const h = minimal ? 34 : 60;

  /* Keyboard is not a nicety here: the brush decides which sorties every
     other panel counts, and it was reachable by pointer only. */
  const nudge = (which:"left"|"right", to:number|"start"|"end")=>{
    if(which==="left"){
      const hi = right - GAP;
      const next = to==="start" ? 0 : to==="end" ? hi : left + to;
      setTimeRange([clamp(next, 0, Math.max(0, hi)), right]);
    } else {
      const lo = left + GAP;
      const next = to==="start" ? lo : to==="end" ? 100 : right + to;
      setTimeRange([left, clamp(next, Math.min(100, lo), 100)]);
    }
  };
  const onKey = (which:"left"|"right") => (e: React.KeyboardEvent)=>{
    const step = e.shiftKey ? BIG : STEP;
    let handled = true;
    switch(e.key){
      case "ArrowLeft": case "ArrowDown": nudge(which, -step); break;
      case "ArrowRight": case "ArrowUp": nudge(which, step); break;
      case "PageDown": nudge(which, -BIG); break;
      case "PageUp": nudge(which, BIG); break;
      case "Home": nudge(which, "start"); break;
      case "End": nudge(which, "end"); break;
      default: handled = false;
    }
    if(handled){ e.preventDefault(); e.stopPropagation(); }
  };

  return (
    <div
      className="shrink-0 flex items-center gap-4 px-5 bg-bg border-t border-line select-none"
      style={{ height: h }}
    >
      <span className="label shrink-0 whitespace-nowrap">{filteredOut ? t("time.filtered") : t("time.all")}</span>

      <div
        ref={barRef}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        className="flex-1 relative h-full flex items-end gap-px py-2"
      >
        {/* Square bars. The window is stated by the bars themselves — inside it
            they stand in ink, outside they drop to the rule colour — and by the
            two handles. There used to be a translucent scrim over the excluded
            ends as well, `bg-bg/70`: Tailwind cannot apply an opacity modifier
            to a colour declared as a bare `var()`, so it emitted no rule at all
            and the scrim has never once rendered. Two invisible boxes are not
            worth hardcoding the background colour to revive — the bar step is
            the honest signal, and it is the one the reader has actually been
            using. */}
        {bins.map((v,i)=>{
          const pct = (i/(bins.length-1))*100;
          const inRange = pct >= left && pct <= right;
          return (
            <div
              key={i}
              className="flex-1 transition-colors"
              style={{
                height: `${Math.max(2, (v/maxV)*100)}%`,
                background: v===0 ? "var(--hair)" : inRange ? "var(--ink-2)" : "var(--line)",
              }}
            />
          );
        })}

        <Handle
          pct={left}
          label={t("a11y.brushStart")}
          valueText={dateAt(left)}
          min={0}
          max={Math.max(0, right - GAP)}
          onDown={e=>onPointerDown(e,"left")}
          onKeyDown={onKey("left")}
        />
        <Handle
          pct={right}
          label={t("a11y.brushEnd")}
          valueText={dateAt(right)}
          min={Math.min(100, left + GAP)}
          max={100}
          onDown={e=>onPointerDown(e,"right")}
          onKeyDown={onKey("right")}
        />
      </div>

      {/* The reset lives outside the `hidden sm:flex` group that carries the
          date range: under 640px the whole cluster disappeared, taking the only
          way out of an active filter with it. The dates may hide; the escape
          hatch may not. */}
      <div className="flex items-center gap-3 shrink-0 text-2xs text-ink3">
        <span className="tnum hidden sm:inline">{labels[0]} → {labels[1]}</span>
        {filteredOut && (
          <button onClick={()=> setTimeRange([0,100])} className="text-ink2 hover:text-ink transition-colors">
            {t("btn.reset")}
          </button>
        )}
      </div>
    </div>
  );
}

/* 24px of transparent grab area around a 1px line: the visual stays hairline,
   the target clears the minimum a finger (or an unsteady hand) needs. */
function Handle({
  pct, label, valueText, min, max, onDown, onKeyDown,
}: {
  pct: number;
  label: string;
  valueText: string;
  min: number;
  max: number;
  onDown: (e: React.PointerEvent)=>void;
  onKeyDown: (e: React.KeyboardEvent)=>void;
}){
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(pct)}
      aria-valuetext={valueText}
      aria-orientation="horizontal"
      onPointerDown={onDown}
      onKeyDown={onKeyDown}
      className="absolute inset-y-0 w-6 -ml-3 cursor-ew-resize group outline-none touch-none"
      style={{ left: `${pct}%` }}
    >
      {/* Ink, not the signal colour. The brush is a position a person parked
          the instrument at — a selection marker, the same object as the rail's
          active rule and the list's selected row — and the green is spent on
          the standing estimate. Square: this is a sight, not a knob. */}
      <div className="absolute inset-y-0 left-1/2 w-px bg-ink2 group-hover:bg-ink transition-colors" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-3.5 bg-ink2 group-hover:bg-ink group-focus-visible:bg-ink group-focus-visible:ring-1 group-focus-visible:ring-ink2 group-focus-visible:ring-offset-1 group-focus-visible:ring-offset-bg transition-colors" />
    </div>
  );
}
