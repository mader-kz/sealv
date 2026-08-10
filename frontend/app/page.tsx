"use client";
import { useEffect, useMemo, useRef } from "react";
import TopBar from "@/components/layout/TopBar";
import Rail from "@/components/layout/Rail";
import RightInspector from "@/components/layout/RightInspector";
import SeasonMode from "@/components/modes/SeasonMode";
import ReviewMode from "@/components/modes/ReviewMode";
import IngestMode from "@/components/modes/IngestMode";
import ArchiveMode from "@/components/modes/ArchiveMode";
import ReportMode from "@/components/modes/ReportMode";
import ManageMode from "@/components/modes/ManageMode";
import { useFootageStore } from "@/store/useFootageStore";
import { isRunning, isWaiting, useIngestStore } from "@/store/useIngestStore";
import { IconButton } from "@/components/ui/primitives";
import { currentMode, initMode, setMode, useMode } from "@/lib/modes";
import { useT } from "@/lib/i18n";

/* This file used to be the product. It carried the map, the estimate chip, the
   ingest panel, the empty state, four panel booleans and the arithmetic that
   decided which of them could be on screen at once. All of that moved into the
   five modes; what is left here is the shell: the chrome, the boot, and the
   handful of behaviours that have to outlive whichever mode is showing.
   Everything below is one of those four things and nothing else. */

/* How long a finished ingest queue stays on screen before the shell walks back
   to the map. Long enough to read the last row, short enough that nobody
   wonders whether it is stuck. (Dropzone uses the same interval for its own
   settled signal; it is a constant there, so it is a constant here.) */
const INGEST_RETURN_MS = 1500;

/* A `flyto` raised from a mode that is not the map has nobody listening for it
   — the map is unmounted. The shell switches to the map and re-raises the
   event until the map answers, because the map may still be code-splitting in
   when the switch happens and a single retry would land in the gap. */
const FLYTO_REPLAY_TRIES = 6;
const FLYTO_REPLAY_MS = 200;

export default function Page(){
  const { t } = useT();
  const [mode] = useMode();

  /* The URL is the mode, both ways: adopt the hash we were opened on, and let
     Back walk the modes. After mount, never during render — the exported HTML
     is the default mode and reading `location` while hydrating tears it. */
  useEffect(()=> initMode(), []);

  const footages = useFootageStore(s=>s.footages);
  const selectedId = useFootageStore(s=>s.selectedId);
  const select = useFootageStore(s=>s.select);
  const hydrate = useFootageStore(s=>s.hydrate);

  // Reload the season's counts from the service on boot. hydrate() holds a
  // module-scope promise for the run in flight and hands the same one back to
  // a second caller, so React 18's strict-mode double-invoke of this effect
  // joins the first hydrate instead of starting a rival one.
  useEffect(()=>{
    let cancelled = false;
    void hydrate().then(()=>{
      if(cancelled || new URLSearchParams(window.location.search).get("demo") !== "1") return;
      const state = useFootageStore.getState();
      /* `demo=1` is a safe, shareable showcase link. It never replaces a real
         archive and it never masks a failed restore: synthetic data appears
         only after a successful hydrate proves the service is reachable and
         the archive is genuinely empty. */
      if(!state.hydrating && !state.hydrateError && state.footages.length === 0){
        state.seedTestData();
      }
    });
    return ()=>{ cancelled = true; };
  },[hydrate]);

  /* What the SERVICE remembers going wrong. A job-stage failure writes no run
     row, so hydrate() cannot rebuild it: without this call an F5 after seven
     failed ingests shows a clean map and seven counts that never happened. */
  const ingestItems = useIngestStore(s=>s.items);
  const refreshFailed = useIngestStore(s=>s.refreshFailed);
  useEffect(()=>{ void refreshFailed(); },[refreshFailed]);

  /* ------------------------------------------------- the one camera channel */
  /* Rows, chips and report lines all dispatch `flyto`; nothing reaches into
     the map through a global. The map's own listener does the easeTo — this
     one only makes sure the map is on screen to hear it. A replayed event
     carries `__replay` so this handler ignores its own echo, and the map
     cancels the event once it has moved, which is what stops the retries. */
  useEffect(()=>{
    const replay = (detail: Record<string, unknown>, left: number)=>{
      const ev = new CustomEvent("flyto", { detail: { ...detail, __replay: true }, cancelable: true });
      const unanswered = document.dispatchEvent(ev);
      if(unanswered && left > 0) window.setTimeout(()=> replay(detail, left - 1), FLYTO_REPLAY_MS);
    };
    const h = (e: Event)=>{
      const d = ((e as CustomEvent).detail ?? {}) as Record<string, unknown>;
      if(d.__replay) return;
      if(currentMode()==="map") return; // the map is mounted; it has this
      setMode("map");
      window.setTimeout(()=> replay(d, FLYTO_REPLAY_TRIES), FLYTO_REPLAY_MS);
    };
    document.addEventListener("flyto", h);
    return ()=> document.removeEventListener("flyto", h);
  },[]);

  /* --------------------------------------------------------- drop, anywhere */
  /* Files dropped on any part of the window are an ingest, so the window is
     the drop target and the mode follows the drag: by the time the button is
     released the ingest screen — and its real dropzone — is under the cursor.
     The preventDefault pair is not optional. Without it the browser refuses
     the drop and then NAVIGATES the tab to the dropped file, which throws away
     an entire working session because somebody missed a panel by 40px. */
  useEffect(()=>{
    const carriesFiles = (e: DragEvent)=>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onDragOver = (e: DragEvent)=>{
      if(!carriesFiles(e)) return;
      e.preventDefault();
      if(currentMode()!=="ingest") setMode("ingest");
    };
    /* Bubble phase, after the dropzone's own handler: this is the backstop for
       a drop that missed every target, not a replacement for one. */
    const onDrop = (e: DragEvent)=>{ if(carriesFiles(e)) e.preventDefault(); };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return ()=>{
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  },[]);

  /* ------------------------------------------ and back out again, when done */
  /* The ingest screen shows itself out onto the map once the queue is finished
     with this person — but only a queue this session watched go busy (`armed`),
     so opening Загрузка to look at it does not immediately bounce you away.
     Anything running, anything queued behind it, anything asking a question
     (a duplicate, a missing location, a frame to pick) and anything that
     FAILED keeps the screen up: a failure is the one card nobody should have
     to go looking for. */
  const armed = useRef(false);
  useEffect(()=>{
    const busy = ingestItems.some(i=> isRunning(i.phase) || i.phase==="queued");
    const wantsYou = ingestItems.some(i=> isWaiting(i.phase) || i.phase==="failed");
    if(busy || wantsYou){ armed.current = true; return; }
    if(!armed.current) return;
    // "The last item finished" — a queue of nothing but skipped files never
    // produced a count, and leaving over it would hide the reason it didn't.
    if(!ingestItems.some(i=> i.phase==="done")) return;
    /* Done is a stage now: a finished count with marks REPLAYS itself in the
       row, and yanking the reader to the map mid-replay undoes the whole
       point of showing it. While a replay is on stage the reader leaves when
       they choose to — the map is one keystroke away. */
    if(ingestItems.some(i=> i.phase==="done" && (i.pixels?.length ?? 0) > 0)){
      armed.current = false;
      return;
    }
    const timer = window.setTimeout(()=>{
      armed.current = false;
      if(currentMode()==="ingest") setMode("map");
    }, INGEST_RETURN_MS);
    return ()=> window.clearTimeout(timer);
  },[ingestItems]);

  /* A sortie still being counted lives only in this tab. Reloading throws the
     work away, so the browser gets to ask first. */
  const processing = useMemo(()=> footages.some(f=> f.status==="processing"), [footages]);
  useEffect(()=>{
    if(!processing) return;
    const h = (e: BeforeUnloadEvent)=>{ e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return ()=> window.removeEventListener("beforeunload", h);
  },[processing]);

  /* The sortie inspector is not a mode — it is a detail view of one row, and
     it belongs beside the two screens that list rows. Over Проверка it would
     cover the workspace with a second, worse copy of what that screen already
     shows; over Загрузка and Отчёт it answers a question nobody asked there.
     Selection itself survives the switch, so leaving Карта and coming back
     finds the same sortie open. */
  const inspectorFits = mode==="map" || mode==="archive";
  const showInspector = inspectorFits && !!selectedId;
  /* Clearing the selection is what makes re-clicking the SAME sortie work: an
     effect keyed on selectedId cannot see id → id. */
  const closeInspector = ()=> select(null);

  return (
    <div className="h-screen w-screen flex flex-col bg-bg">
      <TopBar />

      <div className="flex flex-1 min-h-0">
        <Rail />

        {/* Exactly one mode. Each of these owns the whole region: its own
            header, its own scrolling, its own empty state. */}
        <div className="flex-1 min-w-0 flex flex-col relative">
          {mode==="map"     && <SeasonMode />}
          {mode==="review"  && <ReviewMode />}
          {mode==="ingest"  && <IngestMode />}
          {mode==="archive" && <ArchiveMode />}
          {mode==="report"  && <ReportMode />}
          {mode==="manage"  && <ManageMode />}
        </div>

        {showInspector && (
          <div className="shrink-0 flex flex-col border-l border-line">
            <div className="h-9 shrink-0 flex items-center justify-between pl-4 pr-1.5 border-b border-line bg-bg">
              <span className="hd">{t("sec.sortie")}</span>
              <IconButton name="close" onClick={closeInspector} title={t("btn.close")} />
            </div>
            <RightInspector compact />
          </div>
        )}
      </div>
    </div>
  );
}
