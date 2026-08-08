"use client";
import { useMemo, useState } from "react";
import { useFootageStore } from "@/store/useFootageStore";
import { Button, IconButton, Field, Pill } from "@/components/ui/primitives";
import { useT } from "@/lib/i18n";

type SortKey = "date" | "conf";
type StatusFilter = "all" | "auto" | "validated" | "false_positive";

export default function Workbench({ open, onClose }: { open: boolean; onClose: ()=>void }){
  const { t } = useT();
  const footages = useFootageStore(s=>s.footages);
  const detections = useFootageStore(s=>s.detections);
  const updateDetection = useFootageStore(s=>s.updateDetection);
  const bulkUpdate = useFootageStore(s=>s.bulkUpdateDetections);
  const select = useFootageStore(s=>s.select);

  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<SortKey>("date");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const footageById = useMemo(()=> new Map(footages.map(f=>[f.id,f])),[footages]);

  const filtered = useMemo(()=>{
    let rows = detections.filter(d=>{
      if (status!=="all" && d.status!==status) return false;
      if (!q) return true;
      const needle=q.toLowerCase();
      const f=footageById.get(d.footageId);
      return d.id.toLowerCase().includes(needle) || d.footageId.toLowerCase().includes(needle) || (f ? f.filename.toLowerCase().includes(needle) : false);
    });
    rows.sort((a,b)=>{
      if(sort==="conf") return b.confidence - a.confidence;
      // date: by footage uploadedAt
      const fa=footageById.get(a.footageId)?.uploadedAt||""; const fb=footageById.get(b.footageId)?.uploadedAt||"";
      return fb.localeCompare(fa);
    });
    return rows;
  },[detections, footageById, q, status, sort]);

  const toggle = (id:string)=>{
    const s=new Set(selected);
    if(s.has(id)) s.delete(id); else s.add(id);
    setSelected(s);
  };
  const allIds = filtered.map(r=>r.id);
  const allSelected = selected.size>0 && allIds.every(id=>selected.has(id));

  if(!open) return null;

  const exportCSV = ()=>{
    const rows=["id,footageId,filename,t,lat,lng,score,status"];
    for(const d of filtered){
      const f=footageById.get(d.footageId);
      rows.push(`${d.id},${d.footageId},${f?.filename||""},${d.t},${d.lat},${d.lng},${d.confidence},${d.status}`);
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
          <span className="text-base font-medium">{t("nav.detections")}</span>
          <span className="text-xs text-ink3 tnum">
            {t("wb.ofTotal", { a: filtered.length, b: detections.length })}{selected.size>0 && ` · ${t("wb.selected", { n: selected.size })}`}
          </span>
          <div className="flex-1" />
          <Button icon="download" onClick={exportCSV}>{t("btn.exportCsv")}</Button>
          <IconButton name="close" onClick={onClose} title={t("btn.close")} />
        </div>

        <div className="px-4 py-2.5 border-b border-line flex flex-wrap items-center gap-2">
          <div className="w-56"><Field value={q} onChange={setQ} placeholder={t("wb.filter")} icon="search" /></div>
          <select value={status} onChange={e=>setStatus(e.target.value as any)} className="h-7 bg-surface2 border border-line rounded px-2 text-xs text-ink2">
            <option value="all">{t("wb.allStatus")}</option>
            <option value="auto">{t("status.auto")}</option>
            <option value="validated">{t("status.validated")}</option>
            <option value="false_positive">{t("status.falsePositive")}</option>
          </select>
          <select value={sort} onChange={e=>setSort(e.target.value as any)} className="h-7 bg-surface2 border border-line rounded px-2 text-xs text-ink2">
            <option value="date">{t("wb.sortDate")}</option>
            <option value="conf">{t("wb.sortConf")}</option>
          </select>
          <div className="flex-1" />
          {selected.size>0 && (
            <div className="flex items-center gap-1.5">
              <Button icon="check" onClick={()=>{ bulkUpdate(Array.from(selected), {status:"validated"}); setSelected(new Set()); }}>{t("wb.validate")}</Button>
              <Button onClick={()=>{ bulkUpdate(Array.from(selected), {status:"false_positive"}); setSelected(new Set()); }}>{t("wb.markFalse")}</Button>
              <Button variant="ghost" onClick={()=> setSelected(new Set())}>{t("btn.clear")}</Button>
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
                <th className={th}>{t("nav.footage")}</th>
                <th className={`${th} text-right`}>{t("wb.score")}</th>
                <th className={th}>{t("wb.status")}</th>
                <th className={th}>{t("wb.coords")}</th>
                <th className={th}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(d=>{
                const f=footageById.get(d.footageId);
                const isSel = selected.has(d.id);
                return (
                  <tr
                    key={d.id}
                    className={`border-b border-line-soft transition-colors ${isSel ? "bg-surface2" : "hover:bg-surface2/60"} ${d.status==="false_positive" ? "opacity-45" : ""}`}
                  >
                    <td className="pl-4 pr-2 py-2">
                      <input type="checkbox" className="accent-[color:var(--accent)]" checked={isSel} onChange={()=> toggle(d.id)} />
                    </td>
                    <td className="px-3 py-2 font-mono text-ink truncate max-w-[180px]">{f?.filename || d.footageId}</td>
                    {/* raw model score, not a percentage: it is not a calibrated probability */}
                    <td className="px-3 py-2 text-right text-ink2 tnum">{d.confidence.toFixed(2)}</td>
                    <td className="px-3 py-2">
                      <Pill tone={d.status==="validated" ? "good" : d.status==="false_positive" ? "neutral" : "neutral"}>
                        {d.status==="false_positive" ? t("status.falseShort") : d.status==="validated" ? t("status.validatedL") : t("status.autoL")}
                      </Pill>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-ink3 tnum">{d.lat.toFixed(3)}, {d.lng.toFixed(3)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1 justify-end">
                        <Button variant="ghost" onClick={()=> { select(d.footageId); onClose(); }}>{t("wb.showOnMap")}</Button>
                        <Button
                          variant="ghost"
                          onClick={()=> updateDetection(d.id, {status: d.status==="false_positive" ? "auto" : "false_positive"})}
                        >
                          {d.status==="false_positive" ? t("wb.restore") : t("wb.markFalse")}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filtered.length===0 && (
                <tr><td colSpan={6} className="px-4 py-16 text-center text-sm text-ink3">{t("wb.noMatch")}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
