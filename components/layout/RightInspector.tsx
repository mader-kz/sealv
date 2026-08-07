"use client";
import { useFootageStore } from "@/store/useFootageStore";
import { useMemo } from "react";
import { Button, Row, SectionHead, Pill } from "@/components/ui/primitives";
import Icon from "@/components/ui/Icon";

export default function RightInspector({ compact }: { compact?: boolean }){
  const footages = useFootageStore(s=>s.footages);
  const selectedId = useFootageStore(s=>s.selectedId);
  const select = useFootageStore(s=>s.select);
  const f = useMemo(()=> footages.find(x=>x.id===selectedId) || null, [footages, selectedId]);

  const shell = `w-[340px] ${compact ? "flex-1" : "shrink-0 border-l border-line"} bg-surface flex flex-col overflow-hidden`;

  if (!f) {
    return (
      <div className={shell}>
        <div className="flex-1 grid place-items-center p-8 text-center">
          <div className="max-w-[220px]">
            <Icon name="target" size={20} className="text-ink3 mx-auto" />
            <p className="text-sm text-ink2 mt-3 leading-relaxed">
              Select a sortie on the map or in the footage list to inspect its count and track.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const det = f.detections[0] || null;
  const totalSeals = det?.count ?? 0;

  return (
    <div className={shell}>
      {/* The count is the answer this product exists to give — so it leads. */}
      <div className="px-4 pt-4 pb-3.5 border-b border-line">
        <div className="flex items-baseline gap-2">
          <span className="text-hero tnum font-medium leading-none">{totalSeals}</span>
          <span className="text-sm text-ink2">seals counted</span>
        </div>
        <div className="flex items-center gap-2 mt-2.5">
          {f.source==="test" && <Pill tone="accent">test data</Pill>}
          {det && <Pill tone="neutral">{(det.confidence*100).toFixed(0)}% confidence</Pill>}
          {det?.status === "validated" && <Pill tone="good">Validated</Pill>}
          {det?.status === "false_positive" && <Pill tone="bad">False positive</Pill>}
          <span className="text-2xs text-ink3">whole video</span>
        </div>
      </div>

      {/* frame preview */}
      <div className="aspect-video bg-bg border-b border-line relative shrink-0">
        {f.videoUrl ? (
          <video src={f.videoUrl} controls className="w-full h-full object-contain" />
        ) : (
          <FramePreview filename={f.filename} count={totalSeals} det={det} />
        )}
      </div>

      <div className="flex-1 overflow-auto">
        <div className="px-4 py-3">
          <SectionHead title="Sortie" className="mb-1" />
          <Row label="File" value={f.filename} mono />
          <Row label="Region" value={f.region} />
          <Row label="Duration" value={`${f.duration}s`} mono />
          <Row label="Source" value={f.source} />
          <Row label="Track" value={`${f.track.length} points`} mono />
          <Row
            label="Location"
            value={`${f.center.lat.toFixed(4)}, ${f.center.lng.toFixed(4)}`}
            mono
          />
        </div>

        <div className="px-4 pb-4 flex gap-1.5">
          <Button
            icon="download"
            full
            onClick={()=>{
              const blob = new Blob([JSON.stringify(f,null,2)], {type:"application/json"});
              const url = URL.createObjectURL(blob);
              const a=document.createElement("a"); a.href=url; a.download=`${f.id}.json`; a.click();
              URL.revokeObjectURL(url);
            }}
          >
            Export JSON
          </Button>
          <Button
            icon="copy"
            title="Copy coordinates"
            onClick={()=> navigator.clipboard.writeText(`${f.center.lat},${f.center.lng}`)}
          />
        </div>
      </div>
    </div>
  );
}

function FramePreview({ filename, count, det }: { filename:string; count:number; det:any }){
  return (
    <div className="w-full h-full relative bg-[#0d0f11] overflow-hidden grid place-items-center">
      <div
        className="absolute inset-0 opacity-60"
        style={{ background:"radial-gradient(ellipse at 35% 40%, #14202a 0%, transparent 65%)" }}
      />
      {det && (
        <div
          className="absolute border border-accent rounded-[2px]"
          style={{ left: `${det.bbox[0]*100}%`, top: `${det.bbox[1]*100}%`, width: `${det.bbox[2]*100}%`, height: `${det.bbox[3]*100}%` }}
        >
          <span className="absolute -top-[15px] left-0 bg-accent text-accent-ink text-2xs font-medium px-1 rounded-sm leading-[14px] tnum">
            {count}
          </span>
        </div>
      )}
      <span className="absolute bottom-2 left-2.5 text-2xs font-mono text-ink3 truncate max-w-[80%]">{filename}</span>
    </div>
  );
}
