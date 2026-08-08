"use client";
import { useCallback, useRef, useState } from "react";
import { useFootageStore } from "@/store/useFootageStore";
import { parseSRT, validateTrackInCaspian } from "@/lib/parsers/srt";
import { parseJSONSidecar } from "@/lib/parsers/json";
import { parseMP4Metadata } from "@/lib/parsers/mp4";
import { uploadMedia, createJob, watchJob, pointsToDetections } from "@/lib/api";
import { toast } from "sonner";
import { snapToWater, isWater } from "@/lib/caspian";
import type { Footage, TrackPoint } from "@/lib/types";
import Icon from "@/components/ui/Icon";
import { Button } from "@/components/ui/primitives";

/** Sample footage bundled with the app so the ingest flow can be tried
 *  without sourcing a drone file. Real video, real GPS in its metadata. */
const SAMPLE_CLIP = { url: "/samples/FIELD_0001.MP4", name: "FIELD_0001.MP4" };

function genId(){ return Math.random().toString(36).slice(2,9); }

/** Read the real playback duration out of the file. Resolves null if the
 *  browser can't decode it (unsupported codec, or a placeholder file). */
function readVideoDuration(file: File): Promise<number | null> {
  return new Promise(resolve => {
    if (file.size === 0) return resolve(null);
    const url = URL.createObjectURL(file);
    const el = document.createElement("video");
    const done = (v: number | null) => { URL.revokeObjectURL(url); resolve(v); };
    const timer = setTimeout(()=> done(null), 5000);
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      clearTimeout(timer);
      done(Number.isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration) : null);
    };
    el.onerror = () => { clearTimeout(timer); done(null); };
    el.src = url;
  });
}

export default function Dropzone(){
  const [drag, setDrag] = useState(false);
  const [log, setLog] = useState<string>("");
  const addFootage = useFootageStore(s=>s.addFootage);
  const completeFootage = useFootageStore(s=>s.completeFootage);
  const pinMode = useFootageStore(s=>s.pinMode);
  const setPinMode = useFootageStore(s=>s.setPinMode);
  const pinPoints = useFootageStore(s=>s.pinPoints);
  const setPinPoints = useFootageStore(s=>s.setPinPoints);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pendingVideo, setPendingVideo] = useState<{ file: File, url: string, name: string }|null>(null);
  const [loadingSample, setLoadingSample] = useState(false);

  /* The real count. Upload -> queue -> follow to completion -> swap the
     engine's result into the store. Runs detached from processFiles so a
     4-frame video counting for 40s never blocks the next drop. */
  const countForReal = useCallback(async (
    id: string, media: File, sidecar: File | null, footage: Footage,
  ) => {
    try {
      /* The service georeferences from the track IT holds, not the one the
         browser parsed. Embedded MP4 GPS and pinned paths exist only client-
         side, so hand the parsed track over as a JSON sidecar the backend's
         parser already accepts - that is what turns "562 seals somewhere"
         into per-animal points, and what lets hydrate() restore the sortie
         after a reload instead of skipping a record with no geography. */
      let sc = sidecar;
      if (!sc && footage.track.length > 0) {
        sc = new File(
          [JSON.stringify({ track: footage.track })],
          "track.json",
          { type: "application/json" },
        );
      }
      const up = await uploadMedia(media, sc);
      const jobId = await createJob(up.id);
      const result = await watchJob(jobId, p => {
        const t = p.frames_total ?? 0;
        setLog(`${footage.filename} · ${p.stage ?? "working"}${t ? ` · frame ${p.frames_done ?? 0}/${t}` : ""}`);
      });
      const { placed, unplaced } = pointsToDetections(id, result.points ?? []);
      const best = result.count?.best ?? null;
      let detections = placed;
      if (placed.length === 0 && best != null && best > 0) {
        // Engine counted, geo did not resolve (a still, or a track the
        // service could not use): one aggregate marker at the sortie centre
        // carries the whole count, the way the platform always drew it.
        detections = [{
          id: `${id}-agg`, footageId: id, t: 0,
          lat: footage.center.lat, lng: footage.center.lng,
          count: best, confidence: 1, status: "auto" as const,
        }];
      }
      completeFootage(id, { status: "ready", detections, band: result.count, unplaced, runId: result.run_id });
      const bandTxt = result.count && result.count.low !== result.count.high
        ? ` (range ${result.count.low}–${result.count.high})` : "";
      toast.success(`${footage.filename}: ${best ?? "?"} seals${bandTxt}`);
      setLog(`${footage.filename} · ${best ?? "?"} seals counted${unplaced ? ` · ${unplaced} without coordinates` : ""}`);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      completeFootage(id, { status: "error", error: msg });
      toast.error(`${footage.filename}: ${msg}`);
      setLog(`${footage.filename} · count failed: ${msg}`);
    }
  }, [completeFootage]);

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
      const image = group.find(f=> /\.(jpe?g|png|tiff?|webp)$/i.test(f.name));
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
      } else if (image && pinPoints.length >= 1) {
        // A still has no flight track. One pinned point is its location; the
        // whole count aggregates onto that marker, exactly as honest as the
        // engine result allows without per-animal coordinates.
        const p0 = pinPoints[0];
        track = [{ t: 0, lat: p0.lat, lng: p0.lng, alt: 75 }];
        source = "manual";
        parseInfo = "photo · location pinned on the map";
        setPinPoints([]); setPinMode(false);
      } else if (image) {
        // Hold the file and arm pin mode ourselves. The old message told the
        // user to enable pinning and DROP THE FILE AGAIN - a flow nobody
        // completes. Same pending mechanism the GPS-less video path uses;
        // confirm re-runs processFiles with the held file, and the branch
        // above accepts it off the pinned point.
        setPendingVideo({ file: image, url: URL.createObjectURL(image), name: image.name });
        setPinMode(true); setPinPoints([]);
        setLog(`${image.name}: a photo carries no location — click the map where it was taken, then press Confirm.`);
        continue;
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
          const res = await parseMP4Metadata(video);
          if(res.track && res.track.length>0){
            track = res.track;
            source="injected";
            const at = res.found ? ` at ${res.found.lat.toFixed(4)}, ${res.found.lng.toFixed(4)}` : "";
            parseInfo = `location read from video${at} · ${track.length} track points`;
          } else if(res.outsideSurveyArea && res.found){
            // The video plainly has GPS — say where, rather than claiming none.
            setPendingVideo({ file: video, url: URL.createObjectURL(video), name: video.name });
            setLog(`${video.name}: GPS found at ${res.found.lat.toFixed(4)}, ${res.found.lng.toFixed(4)} — outside the Caspian survey area, so it can't be plotted. Pin the path on the map to place it manually.`);
            continue;
          } else {
            setPendingVideo({ file: video, url: URL.createObjectURL(video), name: video.name });
            setPinMode(true); setPinPoints([]);
            setLog(`No GPS found in ${video.name}. Pin the flight path on the map, then confirm.`);
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

      // Prefer the video's own duration. Falling back to the track's time span
      // reports a synthesized number (the mock track is always ~90s), which is
      // wrong for any real file.
      const realDuration = video ? await readVideoDuration(video) : null;
      const duration = image ? 0 : (realDuration ?? Math.max(60, Math.ceil(track[track.length-1].t + 5)));

      // Re-scale the track onto the real timeline so t values stay meaningful.
      if (realDuration && track.length > 1) {
        const span = track[track.length-1].t || 1;
        track = track.map(p=> ({ ...p, t: (p.t/span) * realDuration }));
      }

      const id = `up-${genId()}`;
      const center = track[Math.floor(track.length/2)];
      const media = video ?? image ?? null;
      const footage: Footage = {
        id,
        filename: media ? media.name : `${base}.MP4`,
        size: media ? media.size : 0,
        duration,
        uploadedAt: new Date().toISOString(),
        track,
        detections: [],
        center: { lat: center.lat, lng: center.lng },
        region: center.lat > 44.5 ? "KZ-East" : center.lat > 43.4 ? "KZ-South" : "KZ-North",
        status: "processing",
        source,
        videoUrl: video ? URL.createObjectURL(video) : undefined,
      };
      addFootage(footage);
      setPendingVideo(null);

      if (!media) {
        // A sidecar with no media: the track can be drawn, but there is
        // nothing to count. Say so instead of inventing numbers for it.
        completeFootage(id, { status: "error", error: "no video or photo in this drop — the track was drawn but nothing could be counted" });
        setLog(`${base}: track only, nothing to count.`);
        continue;
      }

      setLog(`${footage.filename} · ${parseInfo} · counting…`);
      countForReal(id, media, srt ?? json ?? null, footage);
    }
  },[addFootage, completeFootage, countForReal, pinMode, pinPoints, setPinMode, setPinPoints]);

  const onDrop = useCallback((e:React.DragEvent)=>{
    e.preventDefault(); setDrag(false);
    if(e.dataTransfer.files) processFiles(e.dataTransfer.files);
  },[processFiles]);

  /** Pull the bundled sample clip and run it through the normal ingest path —
   *  same code as a dropped file, so this exercises the real parser rather
   *  than a shortcut. */
  const loadSampleClip = useCallback(async ()=>{
    setLoadingSample(true);
    setLog("Loading the sample clip…");
    try {
      const res = await fetch(SAMPLE_CLIP.url);
      if(!res.ok) throw new Error(`${res.status}`);
      const blob = await res.blob();
      await processFiles([new File([blob], SAMPLE_CLIP.name, { type: "video/mp4" })]);
    } catch(e:any){
      setLog(`Could not load the sample clip (${e.message}). It ships at public${SAMPLE_CLIP.url} — check it wasn't removed.`);
    } finally {
      setLoadingSample(false);
    }
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
        <input ref={fileRef} type="file" multiple accept=".mp4,.mov,.avi,.mkv,.webm,.jpg,.jpeg,.png,.tif,.tiff,.webp,.srt,.json" onChange={onInput} className="hidden" />
      </div>

      {/* Nothing to source, nothing to install — a real GPS-tagged clip shipped
          with the app, so the ingest path can be tried on a bare machine. */}
      <button
        onClick={loadSampleClip}
        disabled={loadingSample}
        aria-label="Use the sample clip — 38 second drone video with GPS in its metadata"
        className="w-full flex items-center gap-2 px-2.5 py-2 rounded border border-line bg-surface2 text-left hover:border-ink3 transition-colors disabled:opacity-60 disabled:pointer-events-none"
      >
        <Icon name={loadingSample ? "download" : "map"} size={13} className="text-ink3" />
        <span className="flex-1 min-w-0">
          <span className="block text-xs text-ink">
            {loadingSample ? "Loading sample…" : "Use the sample clip"}
          </span>
          <span className="block text-2xs text-ink3 truncate">
            38s drone video, GPS in metadata · Tyuleniy West
          </span>
        </span>
      </button>

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
              disabled={!pendingVideo || pinPoints.length < (/\.(jpe?g|png|tiff?|webp)$/i.test(pendingVideo.name) ? 1 : 2)}
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
            <div className="text-2xs text-ink3 mt-0.5">
              {/\.(jpe?g|png|tiff?|webp)$/i.test(pendingVideo.name)
                ? "No location — click the map where this photo was taken, then confirm."
                : "No GPS found — pin the flight path on the map (2+ points), then confirm."}
            </div>
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
