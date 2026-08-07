"use client";
import { useCallback, useRef, useState } from "react";
import { useFootageStore } from "@/store/useFootageStore";
import { parseSRT, validateTrackInCaspian } from "@/lib/parsers/srt";
import { parseJSONSidecar } from "@/lib/parsers/json";
import { parseMP4Metadata } from "@/lib/parsers/mp4";
import { mockDetections } from "@/lib/mock/detections";
import { snapToWater, isWater } from "@/lib/caspian";
import type { Footage, TrackPoint } from "@/lib/types";
import Icon from "@/components/ui/Icon";
import { Button } from "@/components/ui/primitives";

function genId(){ return Math.random().toString(36).slice(2,9); }

export default function Dropzone(){
  const [drag, setDrag] = useState(false);
  const [log, setLog] = useState<string>("");
  const addFootage = useFootageStore(s=>s.addFootage);
  const pinMode = useFootageStore(s=>s.pinMode);
  const setPinMode = useFootageStore(s=>s.setPinMode);
  const pinPoints = useFootageStore(s=>s.pinPoints);
  const setPinPoints = useFootageStore(s=>s.setPinPoints);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pendingVideo, setPendingVideo] = useState<{ file: File, url: string, name: string }|null>(null);

  const processFiles = useCallback(async (files: FileList | File[])=>{
    const arr = Array.from(files as FileList);
    // group by basename: video + sidecars
    const byBase = new Map<string, File[]>();
    for(const f of arr){
      const base = f.name.replace(/\.[^.]+$/,"").toLowerCase();
      if(!byBase.has(base)) byBase.set(base,[]);
      byBase.get(base)!.push(f);
    }

    for(const [base, group] of byBase){
      const video = group.find(f=> /\.(mp4|mov|avi|mkv|webm)$/i.test(f.name));
      const srt = group.find(f=> /\.srt$/i.test(f.name));
      const json = group.find(f=> /\.json$/i.test(f.name));
      const sidecarText = srt ? await srt.text() : json ? await json.text() : null;

      let track: TrackPoint[] | null = null;
      let source: Footage["source"] = "manual";
      let parseInfo = "";

      if (srt && sidecarText) {
        try { track = parseSRT(sidecarText); source="srt"; parseInfo=`${track.length} track points`; const v=validateTrackInCaspian(track); if(!v.valid) parseInfo+=` · ${v.reason}`; }
        catch(e:any){ setLog(`Could not read the SRT for ${base}: ${e.message}`); continue; }
      } else if (json && sidecarText) {
        try { track = parseJSONSidecar(sidecarText); source="json"; parseInfo=`${track.length} track points`; }
        catch(e:any){ setLog(`Could not read the JSON sidecar: ${e.message}`); continue; }
      } else if (pinMode && pinPoints.length >=2) {
        // use pin track: distribute proportionally across duration
        const duration = 90;
        track = pinPoints.map((p,i)=> ({ t: (i/(pinPoints.length-1))*duration, lat:p.lat, lng:p.lng, alt: 75 }));
        source="manual";
        parseInfo=`${track.length} pinned points`;
        setPinPoints([]); setPinMode(false);
      } else if (video) {
        // try MP4 internal metadata first (location from video)
        setLog(`Scanning ${video.name} for embedded GPS…`);
        try{
          const mp4Track = await parseMP4Metadata(video);
          if(mp4Track && mp4Track.length>0){
            track = mp4Track;
            source="injected";
            parseInfo = `${track.length} points from embedded GPS`;
          } else {
            setPendingVideo({ file: video, url: URL.createObjectURL(video), name: video.name });
            setLog(`No GPS in ${video.name}. Pin the flight path on the map, then confirm.`);
            continue;
          }
        }catch(e:any){
          setPendingVideo({ file: video, url: URL.createObjectURL(video), name: video.name });
          setLog(`Could not read ${video.name}: ${e.message}. Pin the path manually instead.`);
          continue;
        }
      } else {
        setLog(`Skipped ${base} — needs a video plus .srt/.json, or a pinned path.`);
        continue;
      }

      if (!track || track.length===0) { setLog(`No usable GPS track in ${base}.`); continue; }

      // sanitize: ensure track is on water — snap any land points west into Caspian (real coords must match map)
      let offWater = track.filter(p=> !isWater(p.lat, p.lng)).length;
      if (offWater > 0) {
        track = track.map(p=> isWater(p.lat, p.lng) ? p : { ...snapToWater(p.lat, p.lng), t:p.t, alt:p.alt });
        parseInfo += ` · ${offWater} pts snapped to water`;
      }

      // derive duration: track max t or video duration estimate
      const duration = Math.max(60, Math.ceil(track[track.length-1].t + 5));
      const id = `up-${genId()}`;
      const center = track[Math.floor(track.length/2)];
      const footage: Footage = {
        id,
        filename: video ? video.name : `${base}.MP4`,
        size: video ? video.size : 0,
        duration,
        uploadedAt: new Date().toISOString(),
        track,
        detections: [],
        center: { lat: center.lat, lng: center.lng },
        region: center.lat > 44.5 ? "KZ-East" : center.lat > 43.4 ? "KZ-South" : "KZ-North",
        status: "ready",
        source,
        videoUrl: video ? URL.createObjectURL(video) : undefined,
      };
      footage.detections = mockDetections(track, id);
      addFootage(footage);
      setLog(`${footage.filename} · ${parseInfo} · ${footage.detections.reduce((s,d)=>s+d.count,0)} seals counted`);
      setPendingVideo(null);
    }
  },[addFootage, pinMode, pinPoints, setPinMode, setPinPoints]);

  const onDrop = useCallback((e:React.DragEvent)=>{
    e.preventDefault(); setDrag(false);
    if(e.dataTransfer.files) processFiles(e.dataTransfer.files);
  },[processFiles]);

  const onInput = useCallback((e:React.ChangeEvent<HTMLInputElement>)=>{
    if(e.target.files) processFiles(e.target.files);
  },[processFiles]);

  return (
    <div className="space-y-2">
      <div
        onDragOver={e=>{e.preventDefault(); setDrag(true);}}
        onDragLeave={()=> setDrag(false)}
        onDrop={onDrop}
        onClick={()=> fileRef.current?.click()}
        className={`rounded border border-dashed px-3 py-5 cursor-pointer transition-colors text-center ${drag ? "border-accent bg-accent-soft" : "border-line hover:border-ink3 hover:bg-surface2"}`}
      >
        <Icon name="upload" size={16} className="text-ink3 mx-auto" />
        <div className="text-sm text-ink mt-2">Drop footage, or click to browse</div>
        <div className="text-xs text-ink3 mt-1 leading-relaxed">
          MP4 with a matching .SRT or .JSON track — or a bare MP4 with embedded GPS
        </div>
        <input ref={fileRef} type="file" multiple accept=".mp4,.mov,.avi,.mkv,.webm,.srt,.json" onChange={onInput} className="hidden" />
      </div>

      <div className="flex gap-1.5 items-center">
        <Button
          variant={pinMode ? "primary" : "default"}
          icon="pin"
          full={!pinMode}
          onClick={()=> { const v=!pinMode; setPinMode(v); setLog(v ? "Click the map to draw a flight path (2 points or more), then confirm." : ""); }}
        >
          {pinMode ? "Pinning" : "Pin path manually"}
        </Button>
        {pinMode && (
          <>
            <span className="text-xs text-ink3 tnum px-1">{pinPoints.length} pts</span>
            <Button variant="ghost" onClick={()=> setPinPoints([])}>Clear</Button>
            <Button
              variant="primary"
              disabled={pinPoints.length<2 || !pendingVideo}
              onClick={()=> { if(pendingVideo) processFiles([pendingVideo.file]); }}
            >
              Confirm
            </Button>
          </>
        )}
      </div>

      {pendingVideo && (
        <div className="rounded border border-line bg-surface2 px-2.5 py-2 flex items-start gap-2">
          <Icon name="alert" size={13} className="text-accent mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-xs text-ink truncate">{pendingVideo.name}</div>
            <div className="text-2xs text-ink3 mt-0.5">No GPS found — pin the path on the map, then confirm.</div>
          </div>
          <button onClick={()=> setPendingVideo(null)} className="text-ink3 hover:text-ink" aria-label="Dismiss">
            <Icon name="close" size={12} />
          </button>
        </div>
      )}

      {log && <div className="text-xs text-ink2 leading-relaxed whitespace-pre-wrap px-0.5">{log}</div>}
    </div>
  );
}
