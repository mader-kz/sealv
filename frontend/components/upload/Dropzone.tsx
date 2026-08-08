"use client";
import { useCallback, useRef, useState } from "react";
import { useFootageStore } from "@/store/useFootageStore";
import { parseSRT, validateTrackInCaspian } from "@/lib/parsers/srt";
import { parseJSONSidecar } from "@/lib/parsers/json";
import { parseMP4Metadata } from "@/lib/parsers/mp4";
import { uploadMedia, createJob, watchJob, pointsToDetections, framesUsed } from "@/lib/api";
import { sortieAreaM2 } from "@/lib/analytics/area";
import { toast } from "sonner";
import { snapToWater, isWater } from "@/lib/caspian";
import type { Footage, TrackPoint } from "@/lib/types";
import Icon from "@/components/ui/Icon";
import { Button } from "@/components/ui/primitives";
import { stageText, useT } from "@/lib/i18n";

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
  const { t, tp, lang } = useT();
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
        const total = p.frames_total ?? 0;
        setLog(`${footage.filename} · ${stageText(lang, p.stage)}${total ? ` · ${t("prog.frame", { done: p.frames_done ?? 0, total })}` : ""}`);
      });
      const { placed, unplaced, pixels } = pointsToDetections(id, result.points ?? []);
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
      /* The band and the engine's reasons to doubt it are one result, not a
         number with an optional footnote - so the caveats land in the store on
         the same call, alongside the scale the area is derived from. */
      completeFootage(id, {
        status: "ready", detections, band: result.count, unplaced,
        runId: result.run_id, mediaId: up.id, pixels,
        /* A list the service actually sent, or nothing. `[]` renders as
           "clean run - no caveats", and a run whose completeness was never
           measured must not be certified clean here and then confess after an
           F5, when hydrate() reads the same run and says so. Same rule on both
           paths. */
        caveats: Array.isArray(result.caveats) ? result.caveats : undefined,
        gsdCmPx: up.gsd_cm_px ?? null,
        gsdSource: up.gsd_source ?? null,
        /* Per-FRAME footprint times the frames counted: a video's surveyed
           area is not the ground under one of its frames. */
        areaM2: sortieAreaM2({
          widthPx: up.width, heightPx: up.height, gsdCmPx: up.gsd_cm_px,
          frames: framesUsed(result.quality, up.kind),
        }),
      });
      const bandTxt = result.count && result.count.low != null && result.count.high != null && result.count.low !== result.count.high
        ? ` (${t("misc.range", { low: result.count.low, high: result.count.high })})` : "";
      toast.success(`${footage.filename}: ${best ?? "?"} ${tp(best ?? 0, "unit.seals")}${bandTxt}`);
      setLog(`${footage.filename} · ${best ?? "?"} ${tp(best ?? 0, "insp.sealsCounted")}${unplaced ? ` · ${t("insp.withoutCoords", { n: unplaced })}` : ""}`);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      completeFootage(id, { status: "error", error: msg });
      toast.error(`${footage.filename}: ${msg}`);
      setLog(`${footage.filename} · ${t("insp.countFailed")}: ${msg}`);
    }
  }, [completeFootage, t, tp, lang]);

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
        try { track = parseSRT(sidecarText); source="srt"; parseInfo=`${track.length} ${tp(track.length, "misc.trackPoints")}`; const v=validateTrackInCaspian(track); if(!v.valid) parseInfo+=` · ${v.reason}`; }
        catch(e:any){ setLog(t("drop.srtError", { base, msg: e.message })); continue; }
      } else if (json && sidecarText) {
        try { track = parseJSONSidecar(sidecarText); source="json"; parseInfo=`${track.length} ${tp(track.length, "misc.trackPoints")}`; }
        catch(e:any){ setLog(t("drop.jsonError", { msg: e.message })); continue; }
      } else if (image && pinPoints.length >= 1) {
        // A still has no flight track. One pinned point is its location; the
        // whole count aggregates onto that marker, exactly as honest as the
        // engine result allows without per-animal coordinates.
        const p0 = pinPoints[0];
        track = [{ t: 0, lat: p0.lat, lng: p0.lng, alt: 75 }];
        source = "manual";
        parseInfo = t("drop.photoPinned");
        setPinPoints([]); setPinMode(false);
      } else if (image) {
        // Hold the file and arm pin mode ourselves. The old message told the
        // user to enable pinning and DROP THE FILE AGAIN - a flow nobody
        // completes. Same pending mechanism the GPS-less video path uses;
        // confirm re-runs processFiles with the held file, and the branch
        // above accepts it off the pinned point.
        setPendingVideo({ file: image, url: URL.createObjectURL(image), name: image.name });
        setPinMode(true); setPinPoints([]);
        setLog(t("drop.imageNoLocation", { name: image.name }));
        continue;
      } else if (pinMode && pinPoints.length >= 1) {
        // One point, not a drawn path. A hand-drawn ring pretending to be a
        // flight track gave every frame a different fabricated anchor, and the
        // animals scattered around the ring - "random inside the circle".
        // Consensus already registers all frames into one pixel space, so a
        // single anchor at the shot's centre plus real pixel offsets is the
        // honest picture; track_at clamps a 1-point track to it for every t.
        const p0 = pinPoints[0];
        track = [{ t: 0, lat: p0.lat, lng: p0.lng, alt: 75 }];
        source = "manual";
        parseInfo = t("drop.pinnedCentre");
        setPinPoints([]); setPinMode(false);
      } else if (video) {
        // try MP4 internal metadata first (location from video)
        setLog(t("drop.scanning", { name: video.name }));
        try{
          const res = await parseMP4Metadata(video);
          if(res.track && res.track.length>0){
            track = res.track;
            source="injected";
            const at = res.found ? ` · ${res.found.lat.toFixed(4)}, ${res.found.lng.toFixed(4)}` : "";
            parseInfo = `${t("drop.gpsFromVideo")}${at} · ${track.length} ${tp(track.length, "misc.trackPoints")}`;
          } else if(res.outsideSurveyArea && res.found){
            // The video plainly has GPS — say where, rather than claiming none.
            setPendingVideo({ file: video, url: URL.createObjectURL(video), name: video.name });
            setLog(t("drop.gpsOutside", { name: video.name, lat: res.found.lat.toFixed(4), lng: res.found.lng.toFixed(4) }));
            continue;
          } else {
            setPendingVideo({ file: video, url: URL.createObjectURL(video), name: video.name });
            setPinMode(true); setPinPoints([]);
            setLog(t("drop.noGps", { name: video.name }));
            continue;
          }
        }catch(e:any){
          setPendingVideo({ file: video, url: URL.createObjectURL(video), name: video.name });
          setLog(t("drop.readError", { name: video.name, msg: e.message }));
          continue;
        }
      } else {
        setLog(t("drop.skipped", { base }));
        continue;
      }

      if (!track || track.length===0) { setLog(t("drop.noTrack", { base })); continue; }

      // sanitize: ensure track is on water — snap any land points west into Caspian (real coords must match map)
      let offWater = track.filter(p=> !isWater(p.lat, p.lng)).length;
      if (offWater > 0) {
        track = track.map(p=> isWater(p.lat, p.lng) ? p : { ...snapToWater(p.lat, p.lng), t:p.t, alt:p.alt });
        parseInfo += ` · ${t("drop.snapped", { n: offWater })}`;
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
        status: "processing",
        source,
        videoUrl: video ? URL.createObjectURL(video) : undefined,
      };
      addFootage(footage);
      setPendingVideo(null);

      if (!media) {
        // A sidecar with no media: the track can be drawn, but there is
        // nothing to count. Say so instead of inventing numbers for it.
        completeFootage(id, { status: "error", error: t("drop.trackOnlyError") });
        setLog(t("drop.trackOnly", { base }));
        continue;
      }

      setLog(`${footage.filename} · ${parseInfo} · ${t("drop.counting")}`);
      countForReal(id, media, srt ?? json ?? null, footage);
    }
  },[addFootage, completeFootage, countForReal, pinMode, pinPoints, setPinMode, setPinPoints, t, tp]);

  const onDrop = useCallback((e:React.DragEvent)=>{
    e.preventDefault(); setDrag(false);
    if(e.dataTransfer.files) processFiles(e.dataTransfer.files);
  },[processFiles]);

  /** Pull the bundled sample clip and run it through the normal ingest path —
   *  same code as a dropped file, so this exercises the real parser rather
   *  than a shortcut. */
  const loadSampleClip = useCallback(async ()=>{
    setLoadingSample(true);
    setLog(t("drop.sampleLoading"));
    try {
      const res = await fetch(SAMPLE_CLIP.url);
      if(!res.ok) throw new Error(`${res.status}`);
      const blob = await res.blob();
      await processFiles([new File([blob], SAMPLE_CLIP.name, { type: "video/mp4" })]);
    } catch(e:any){
      setLog(t("drop.sampleError", { msg: e.message, url: SAMPLE_CLIP.url }));
    } finally {
      setLoadingSample(false);
    }
  },[processFiles, t]);

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
        <div className="text-sm text-ink mt-2">{t("drop.title")}</div>
        <div className="text-xs text-ink3 mt-1 leading-relaxed">
          {t("drop.sub")}
        </div>
        <input ref={fileRef} type="file" multiple accept=".mp4,.mov,.avi,.mkv,.webm,.jpg,.jpeg,.png,.tif,.tiff,.webp,.srt,.json" onChange={onInput} className="hidden" />
      </div>

      {/* Nothing to source, nothing to install — a real GPS-tagged clip shipped
          with the app, so the ingest path can be tried on a bare machine. */}
      <button
        onClick={loadSampleClip}
        disabled={loadingSample}
        aria-label={t("drop.sampleAria")}
        className="w-full flex items-center gap-2 px-2.5 py-2 rounded border border-line bg-surface2 text-left hover:border-ink3 transition-colors disabled:opacity-60 disabled:pointer-events-none"
      >
        <Icon name={loadingSample ? "download" : "map"} size={13} className="text-ink3" />
        <span className="flex-1 min-w-0">
          <span className="block text-xs text-ink">
            {loadingSample ? t("drop.sampleLoading") : t("drop.sampleUse")}
          </span>
          <span className="block text-2xs text-ink3 truncate">
            {t("drop.sampleDesc")}
          </span>
        </span>
      </button>

      <div className="flex gap-1.5 items-center">
        <Button
          variant={pinMode ? "primary" : "default"}
          icon="pin"
          full={!pinMode}
          onClick={()=> { const v=!pinMode; setPinMode(v); setLog(v ? t("drop.pinInstruction") : ""); }}
        >
          {pinMode ? t("drop.pinning") : t("drop.pinManually")}
        </Button>
        {pinMode && (
          <>
            <span className="text-xs text-ink3 tnum px-1">{pinPoints.length ? t("drop.anchorSet") : t("drop.noAnchor")}</span>
            <Button variant="ghost" onClick={()=> setPinPoints([])}>{t("btn.clear")}</Button>
            <Button
              variant={pendingVideo && pinPoints.length >= 1 ? "primary" : "default"}
              disabled={!pendingVideo || pinPoints.length < 1}
              onClick={()=> { if(pendingVideo) processFiles([pendingVideo.file]); }}
            >
              {t("btn.confirm")}
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
              {t("drop.pendingHint")}
            </div>
          </div>
          <button onClick={()=> setPendingVideo(null)} className="text-ink3 hover:text-ink" aria-label={t("a11y.dismiss")}>
            <Icon name="close" size={12} />
          </button>
        </div>
      )}

      {log && <div className="text-xs text-ink2 leading-relaxed whitespace-pre-wrap px-0.5">{log}</div>}
    </div>
  );
}
