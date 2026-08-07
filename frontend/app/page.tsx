"use client";
import { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import TopBar from "@/components/layout/TopBar";
import Rail from "@/components/layout/Rail";
import LeftPanel from "@/components/layout/LeftPanel";
import RightInspector from "@/components/layout/RightInspector";
import Dropzone from "@/components/upload/Dropzone";
import CommandPalette from "@/components/layout/CommandPalette";
import Dashboard from "@/components/dashboard/Dashboard";
import Timeline from "@/components/layout/Timeline";
import Workbench from "@/components/workbench/Workbench";
import { useFootageStore } from "@/store/useFootageStore";
import { Button, IconButton } from "@/components/ui/primitives";
import Icon from "@/components/ui/Icon";

const CaspianMap = dynamic(()=> import("@/components/map/CaspianMap"), {
  ssr: false,
  loading: ()=> <div className="h-full bg-bg grid place-items-center text-sm text-ink3">Loading chart…</div>,
});

export default function Page(){
  const [cmdOpen, setCmdOpen] = useState(false);
  const [showLeft, setShowLeft] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [rightPane, setRightPane] = useState<"inspector"|"analytics"|null>(null);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const mapRef = useState<{ m: any | null }>({ m:null })[0];

  useEffect(()=>{
    const h = (e:any)=> {
      const { lat, lng } = e.detail;
      if(mapRef.m){ try{ mapRef.m.stop(); }catch{} mapRef.m.easeTo({ center:[lng,lat], zoom: 8.5, duration: 260 }); }
    };
    document.addEventListener("flyto", h as any);
    return ()=> document.removeEventListener("flyto", h as any);
  },[mapRef]);

  const footages = useFootageStore(s=>s.footages);
  const selectedId = useFootageStore(s=>s.selectedId);
  const detections = useFootageStore(s=>s.detections);
  const seedTestData = useFootageStore(s=>s.seedTestData);
  const hydrate = useFootageStore(s=>s.hydrate);

  // Reload the season's counts from the service on boot. hydrate() itself
  // refuses to run over a non-empty store, which also makes React 18's
  // strict-mode double-invoke of this effect harmless.
  useEffect(()=>{ hydrate(); },[hydrate]);

  useEffect(()=>{ if(selectedId) setRightPane("inspector"); },[selectedId]);
  // Open the footage list once there's something in it — while empty, the
  // centred call-to-action is the only thing worth showing.
  useEffect(()=>{ if(footages.length>0) setShowLeft(true); },[footages.length>0]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalSeals = detections.reduce((s,d)=> s + (d.status!=="false_positive" ? d.count : 0), 0);
  const empty = footages.length===0;

  return (
    <div className="h-screen w-screen flex flex-col bg-bg">
      <TopBar onCmdK={()=> setCmdOpen(v=>!v)} />
      <button id="cmdk-trigger" className="hidden" onClick={()=> setCmdOpen(true)} />
      <Workbench open={workbenchOpen} onClose={()=> setWorkbenchOpen(false)} />

      <div className="flex flex-1 min-h-0">
        <Rail
          onWorkbench={()=> setWorkbenchOpen(v=>!v)}
          onToggleLeft={()=> setShowLeft(v=>!v)}
          onToggleAnalytics={()=> setRightPane(p=> p==="analytics" ? null : "analytics")}
          leftOpen={showLeft}
          rightAnalytics={rightPane==="analytics"}
        />

        <div className={`shrink-0 border-r border-line overflow-hidden transition-[width] duration-200 ${showLeft ? "w-[340px]" : "w-0 border-0"}`}>
          <div className="w-[340px] h-full">
            <LeftPanel />
          </div>
        </div>

        <div className="flex-1 min-w-0 flex flex-col relative">
          <div className="flex-1 min-h-0 relative">
            <CaspianMap onMapReady={m=>{ mapRef.m=m; }} />

            {/* Running total — one line, top-right, out of the map's way */}
            <div className="absolute top-3 right-3 z-30 flex items-center gap-2">
              {!empty && (
                <div className="flex items-baseline gap-1.5 bg-surface/95 backdrop-blur border border-line rounded h-7 px-2.5">
                  <span className="text-sm tnum text-ink">{totalSeals}</span>
                  <span className="text-2xs text-ink3">seals</span>
                  <span className="text-line px-0.5">·</span>
                  <span className="text-sm tnum text-ink">{footages.length}</span>
                  <span className="text-2xs text-ink3">sorties</span>
                </div>
              )}
              <Button
                icon="plus"
                variant={showUpload ? "primary" : "default"}
                onClick={()=> setShowUpload(v=>!v)}
              >
                Ingest
              </Button>
            </div>

            {/* Ingest panel */}
            {showUpload && (
              <div className="absolute top-[52px] right-3 z-30 w-[320px] bg-surface border border-line rounded-lg shadow-pop overflow-hidden">
                <div className="h-9 px-3 pr-1.5 flex items-center justify-between border-b border-line">
                  <span className="label">Ingest footage</span>
                  <IconButton name="close" onClick={()=> setShowUpload(false)} title="Close" />
                </div>
                <div className="p-3">
                  <Dropzone />
                </div>
              </div>
            )}

            {/* Empty state — the one thing to do, centered on the map */}
            {empty && !showUpload && (
              <div className="absolute inset-0 z-20 grid place-items-center bg-bg">
                <div className="text-center max-w-[320px] px-6">
                  <Icon name="upload" size={22} className="text-ink3 mx-auto" />
                  <h2 className="text-lead text-ink mt-3">Ingest drone footage</h2>
                  <p className="text-sm text-ink2 mt-1.5 leading-relaxed">
                    SEALv reads the flight track from the video, counts seals, and plots the count
                    where the footage was shot.
                  </p>
                  <div className="flex items-center justify-center gap-1.5 mt-4">
                    <Button variant="primary" icon="upload" onClick={()=> setShowUpload(true)}>
                      Upload footage
                    </Button>
                    <Button onClick={seedTestData}>Load test data</Button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {footages.length>1 && <Timeline minimal />}
        </div>

        {rightPane==="analytics" && <Dashboard onClose={()=> setRightPane(null)} />}
        {rightPane==="inspector" && (
          <div className="shrink-0 flex flex-col border-l border-line">
            <div className="h-9 shrink-0 flex items-center justify-between pl-4 pr-1.5 border-b border-line bg-surface">
              <span className="label">Sortie</span>
              <IconButton name="close" onClick={()=> setRightPane(null)} title="Close" />
            </div>
            <RightInspector compact />
          </div>
        )}
      </div>

      <CommandPalette open={cmdOpen} onClose={()=> setCmdOpen(false)} />
    </div>
  );
}
