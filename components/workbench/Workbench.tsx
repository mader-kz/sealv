"use client";
import { useMemo, useState } from "react";
import { useFootageStore } from "@/store/useFootageStore";
import { Button, IconButton, Field, Pill } from "@/components/ui/primitives";
import Icon from "@/components/ui/Icon";

type SortKey = "date" | "count" | "conf" | "region";
type StatusFilter = "all" | "auto" | "validated" | "false_positive";

export default function Workbench({ open, onClose }: { open: boolean; onClose: ()=>void }){
  const footages = useFootageStore(s=>s.footages);
  const detections = useFootageStore(s=>s.detections);
  const updateDetection = useFootageStore(s=>s.updateDetection);
  const bulkUpdate = useFootageStore(s=>s.bulkUpdateDetections);
  const select = useFootageStore(s=>s.select);

  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<SortKey>("date");
  const [minCount, setMinCount] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editId, setEditId] = useState<string|null>(null);
  const [editCount, setEditCount] = useState<string>("");

  const footageById = useMemo(()=> new Map(footages.map(f=>[f.id,f])),[footages]);

  const filtered = useMemo(()=>{
    let rows = detections.filter(d=>{
      if (status!=="all" && d.status!==status) return false;
      if (d.count < minCount) return false;
      if (!q) return true;
      const t=q.toLowerCase();
      const f=footageById.get(d.footageId);
      return d.id.toLowerCase().includes(t) || d.footageId.toLowerCase().includes(t) || String(d.count).includes(t) || (f && (f.filename.toLowerCase().includes(t) || f.region.toLowerCase().includes(t)));
    });
    rows.sort((a,b)=>{
      if(sort==="count") return b.count - a.count;
      if(sort==="conf") return b.confidence - a.confidence;
      if(sort==="region"){
        const fa=footageById.get(a.footageId)?.region||""; const fb=footageById.get(b.footageId)?.region||"";
        return fa.localeCompare(fb);
      }
      // date: by footage uploadedAt
      const fa=footageById.get(a.footageId)?.uploadedAt||""; const fb=footageById.get(b.footageId)?.uploadedAt||"";
      return fb.localeCompare(fa);
    });
    return rows;
  },[detections, footageById, q, status, sort, minCount]);

  const toggle = (id:string)=>{
    const s=new Set(selected);
    if(s.has(id)) s.delete(id); else s.add(id);
    setSelected(s);
  };
  const allIds = filtered.map(r=>r.id);
  const allSelected = selected.size>0 && allIds.every(id=>selected.has(id));

  if(!open) return null;

  const exportCSV = ()=>{
    const rows=["id,footageId,filename,region,t,lat,lng,count,confidence,status"];
    for(const d of filtered){
      const f=footageById.get(d.footageId);
      rows.push(`${d.id},${d.footageId},${f?.filename||""},${f?.region||""},${d.t},${d.lat},${d.lng},${d.count},${d.confidence},${d.status}`);
    }
    const blob=new Blob([rows.join("\n")],{type:"text/csv"}); const url=URL.createObjectURL(blob);
    const a=document.createElement("a"); a.href=url; a.download=`sealv-detections-${new Date().toISOString().slice(0,10)}.csv`; a.click(); URL.revokeObjectURL(url);
  };

  const th = "px-3 py-2 label font-normal";

  return (
    <div className="fixed inset-0 z-40 flex">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative ml-auto w-[min(940px,94vw)] h-full bg-surface border-l border-line flex flex-col shadow-pop">
        <div className="h-11 shrink-0 border-b border-line flex items-center px-4 gap-3">
          <span className="text-base font-medium">Detections</span>
          <span className="text-xs text-ink3 tnum">
            {filtered.length} of {detections.length}{selected.size>0 && ` · ${selected.size} selected`}
          </span>
          <div className="flex-1" />
          <Button icon="download" onClick={exportCSV}>Export CSV</Button>
          <IconButton name="close" onClick={onClose} title="Close" />
        </div>

        <div className="px-4 py-2.5 border-b border-line flex flex-wrap items-center gap-2">
          <div className="w-56"><Field value={q} onChange={setQ} placeholder="Filter detections" icon="search" /></div>
          <select value={status} onChange={e=>setStatus(e.target.value as any)} className="h-7 bg-surface2 border border-line rounded px-2 text-xs text-ink2">
            <option value="all">All status</option>
            <option value="auto">Auto</option>
            <option value="validated">Validated</option>
            <option value="false_positive">False positive</option>
          </select>
          <select value={sort} onChange={e=>setSort(e.target.value as any)} className="h-7 bg-surface2 border border-line rounded px-2 text-xs text-ink2">
            <option value="date">Sort by date</option>
            <option value="count">Sort by count</option>
            <option value="conf">Sort by confidence</option>
            <option value="region">Sort by region</option>
          </select>
          <div className="flex items-center gap-2 pl-1">
            <span className="text-xs text-ink3">Min count</span>
            <input type="range" min={0} max={12} value={minCount} onChange={e=>setMinCount(parseInt(e.target.value))} className="w-20 accent-[color:var(--accent)]" />
            <span className="text-xs text-ink tnum w-3">{minCount}</span>
          </div>
          <div className="flex-1" />
          {selected.size>0 && (
            <div className="flex items-center gap-1.5">
              <Button icon="check" onClick={()=>{ bulkUpdate(Array.from(selected), {status:"validated"}); setSelected(new Set()); }}>Validate</Button>
              <Button onClick={()=>{ bulkUpdate(Array.from(selected), {status:"false_positive"}); setSelected(new Set()); }}>Mark false</Button>
              <Button variant="ghost" onClick={()=> setSelected(new Set())}>Clear</Button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface border-b border-line z-10 text-left">
              <tr>
                <th className="pl-4 pr-2 py-2 w-8">
                  <input type="checkbox" className="accent-[color:var(--accent)]" checked={allSelected} onChange={e=>{ setSelected(e.target.checked ? new Set(allIds) : new Set()); }} />
                </th>
                <th className={th}>Footage</th>
                <th className={th}>Region</th>
                <th className={`${th} text-right`}>Count</th>
                <th className={`${th} text-right`}>Conf.</th>
                <th className={th}>Status</th>
                <th className={th}>Coordinates</th>
                <th className={th}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(d=>{
                const f=footageById.get(d.footageId);
                const isSel = selected.has(d.id);
                const isEditing = editId===d.id;
                return (
                  <tr
                    key={d.id}
                    className={`border-b border-line-soft transition-colors ${isSel ? "bg-surface2" : "hover:bg-surface2/60"} ${d.status==="false_positive" ? "opacity-45" : ""}`}
                  >
                    <td className="pl-4 pr-2 py-2">
                      <input type="checkbox" className="accent-[color:var(--accent)]" checked={isSel} onChange={()=> toggle(d.id)} />
                    </td>
                    <td className="px-3 py-2 font-mono text-ink truncate max-w-[180px]">{f?.filename || d.footageId}</td>
                    <td className="px-3 py-2 text-ink2">{f?.region || "—"}</td>
                    <td className="px-3 py-2 text-right">
                      {isEditing ? (
                        <span className="inline-flex items-center gap-1">
                          <input
                            value={editCount}
                            onChange={e=> setEditCount(e.target.value)}
                            className="w-12 h-6 bg-bg border border-line rounded px-1 text-center tnum"
                            autoFocus
                            onKeyDown={e=>{ if(e.key==="Enter"){ const n=parseInt(editCount); if(!isNaN(n)&&n>=0&&n<=50) updateDetection(d.id,{count:n}); setEditId(null);} if(e.key==="Escape") setEditId(null); }}
                          />
                          <button
                            onClick={()=>{ const n=parseInt(editCount); if(!isNaN(n)&&n>=0&&n<=50) updateDetection(d.id,{count:n}); setEditId(null); }}
                            className="text-ink3 hover:text-ink"
                            aria-label="Save"
                          >
                            <Icon name="check" size={13} />
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={()=> { setEditId(d.id); setEditCount(String(d.count)); }}
                          className="tnum text-ink px-1.5 py-0.5 rounded hover:bg-surface2 border border-transparent hover:border-line transition-colors"
                          title="Click to correct the count"
                        >
                          {d.count}
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-ink2 tnum">{(d.confidence*100).toFixed(0)}%</td>
                    <td className="px-3 py-2">
                      <Pill tone={d.status==="validated" ? "good" : d.status==="false_positive" ? "neutral" : "neutral"}>
                        {d.status==="false_positive" ? "false" : d.status}
                      </Pill>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-ink3 tnum">{d.lat.toFixed(3)}, {d.lng.toFixed(3)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1 justify-end">
                        <Button variant="ghost" onClick={()=> { select(d.footageId); onClose(); }}>Show on map</Button>
                        <Button
                          variant="ghost"
                          onClick={()=> updateDetection(d.id, {status: d.status==="false_positive" ? "auto" : "false_positive"})}
                        >
                          {d.status==="false_positive" ? "Restore" : "Mark false"}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filtered.length===0 && (
                <tr><td colSpan={8} className="px-4 py-16 text-center text-sm text-ink3">No detections match these filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
