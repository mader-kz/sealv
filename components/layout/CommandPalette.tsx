"use client";
import { useEffect, useState } from "react";
import { useFootageStore } from "@/store/useFootageStore";
import Icon from "@/components/ui/Icon";

const SITES = [
  { id:"AKTAU", name:"Aktau offshore", lat:43.65, lng:51.18 },
  { id:"TYU-01", name:"Tyuleniy west", lat:44.85, lng:50.35 },
  { id:"KEN", name:"Kendirli bay", lat:43.2, lng:51.8 },
];

export default function CommandPalette({ open, onClose }: { open:boolean; onClose:()=>void }){
  const [q,setQ]=useState("");
  const footages = useFootageStore(s=>s.footages);
  const select = useFootageStore(s=>s.select);

  useEffect(()=>{
    const h=(e:KeyboardEvent)=>{
      if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="k"){ e.preventDefault(); if(open) onClose(); else document.getElementById("cmdk-trigger")?.click(); }
      if(e.key==="Escape") onClose();
    };
    window.addEventListener("keydown",h); return ()=>window.removeEventListener("keydown",h);
  },[open,onClose]);

  if(!open) return null;

  const t = q.toLowerCase();
  const filtered = footages.filter(f=> !t || f.filename.toLowerCase().includes(t) || f.region.toLowerCase().includes(t)).slice(0,8);
  const sites = SITES.filter(s=> !t || s.name.toLowerCase().includes(t));

  return (
    <div className="fixed inset-0 z-50 grid place-items-start pt-[16vh] bg-black/50 backdrop-blur-[2px]" onClick={onClose}>
      <div
        onClick={e=>e.stopPropagation()}
        className="w-[min(560px,92vw)] mx-auto bg-surface border border-line rounded-lg shadow-pop overflow-hidden"
      >
        <div className="flex items-center gap-2.5 px-3.5 h-11 border-b border-line">
          <Icon name="search" size={14} className="text-ink3" />
          <input
            autoFocus
            value={q}
            onChange={e=>setQ(e.target.value)}
            placeholder="Jump to a site or sortie"
            className="flex-1 bg-transparent outline-none text-base placeholder:text-ink3"
          />
          <kbd className="text-2xs text-ink3 border border-line rounded px-1 py-0.5 leading-none">esc</kbd>
        </div>

        <div className="max-h-[320px] overflow-auto py-1.5">
          {sites.length>0 && <div className="label px-3.5 py-1.5">Sites</div>}
          {sites.map(s=>(
            <button
              key={s.id}
              onClick={()=>{ document.dispatchEvent(new CustomEvent("flyto",{detail:{lat:s.lat,lng:s.lng}})); onClose(); }}
              className="w-full text-left px-3.5 py-2 hover:bg-surface2 flex items-center gap-2.5 transition-colors"
            >
              <Icon name="target" size={13} className="text-ink3" />
              <span className="text-base text-ink">{s.name}</span>
              <span className="ml-auto text-xs text-ink3 font-mono tnum">{s.lat.toFixed(2)}, {s.lng.toFixed(2)}</span>
            </button>
          ))}

          {filtered.length>0 && <div className="label px-3.5 py-1.5 mt-1">Footage</div>}
          {filtered.map(f=>(
            <button
              key={f.id}
              onClick={()=>{ select(f.id); onClose(); }}
              className="w-full text-left px-3.5 py-2 hover:bg-surface2 flex items-center gap-2.5 transition-colors"
            >
              <Icon name="map" size={13} className="text-ink3" />
              <span className="text-base font-mono text-ink truncate">{f.filename}</span>
              <span className="text-xs text-ink3">{f.region}</span>
              <span className="ml-auto text-xs text-ink2 tnum">
                {f.detections.reduce((s,d)=>s+d.count,0)} seals
              </span>
            </button>
          ))}

          {sites.length===0 && filtered.length===0 && (
            <div className="px-3.5 py-6 text-center text-sm text-ink3">No matches.</div>
          )}
        </div>
      </div>
    </div>
  );
}
