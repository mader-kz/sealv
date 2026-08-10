"use client";
/**
 * ScanStage — the count, while it is happening, on the thing being counted.
 *
 * A row used to report the most interesting minute in this app as a right-
 * aligned grey phrase: `counting, frame 8/24`. The file was on screen as a
 * filename and a byte figure, and the frame the engine was looking at was
 * nowhere. This puts the frame back: the chosen still (a quick-count's frame,
 * or the photo itself) shown large, with a signal-green line sweeping down it
 * for as long as the machine is working.
 *
 * What the sweep is, and what it is not. It is NOT progress — nothing about it
 * is measured, and it moves at the same speed for a two-second job and a
 * two-minute one. It is the "the instrument is awake" light. Everything that
 * IS measured stays in figures: the frames the engine reports, under the
 * image, in tabular numerals, next to a hairline that is only ever as long as
 * the fraction it stands for. When the engine reports no frames there is no
 * bar at all, because a bar with nothing behind it is a lie that moves.
 *
 * On done the sweep stops, the marks land on the frame — the engine's own
 * pixels, the same ones the evidence view draws — and the count arrives in the
 * signal colour beside them. Then the stage steps aside after {@link SETTLE_MS}
 * and the row goes back to the quiet finished line it has always had: a
 * finished ingest is history, and history does not get a stage.
 */

import { useEffect, useMemo, useState } from "react";
import { EvidenceFrame } from "@/components/evidence/EvidenceView";
import { ReplayStage } from "@/components/replay/ReplayView";
import { Button } from "@/components/ui/primitives";
import { isRunning, type IngestItem } from "@/store/useIngestStore";
import { useFootageStore } from "@/store/useFootageStore";
import { useT } from "@/lib/i18n";

/** How long the counted frame keeps the stage before the row settles. Long
 *  enough to read a number and see where the animals were; short enough that a
 *  thirty-file drop does not become thirty posters. */
const SETTLE_MS = 6000;

/** Whether this row's state is told by the stage rather than by a text label
 *  and a bar. Exported so the row can drop its own progress bar instead of
 *  running two of them a centimetre apart.
 *
 *  Only images: by the time anything is uploaded a clip has already been
 *  through the picker and IS an image, and a video the browser would have to
 *  decode to show is not worth a decoder for a decoration. */
export const hasScanStage = (item: IngestItem) =>
  item.kind === "image" && item.file.size > 0 && (isRunning(item.phase) || item.phase === "done");

export default function ScanStage({ item }: { item: IngestItem }) {
  const { t, tp } = useT();
  const [url, setUrl] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  /* The finished sortie, as the archive knows it. When it exists with marks,
     the done-state is not a poster of the result but the result HAPPENING:
     the same ReplayStage the dialog mounts, playing itself in the row. */
  const footages = useFootageStore((s) => s.footages);
  const replayFootage = useMemo(() => {
    if (item.phase !== "done" || !item.footageId) return null;
    const f = footages.find((x) => x.id === item.footageId);
    return f && (f.pixels?.length ?? 0) > 0 ? f : null;
  }, [item.phase, item.footageId, footages]);

  const done = item.phase === "done";
  /* Once the file is in the archive the archive's copy is the one with marks
     registered to it, so the local blob is released rather than held for a row
     that is finished with it. */
  const fromArchive = done && !!item.mediaId;
  const file = item.file;

  useEffect(() => {
    if (fromArchive) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file, fromArchive]);

  /* The stage hands the row back on its own. Keyed on `done` only, so a
     re-render mid-count cannot restart the clock. */
  useEffect(() => {
    if (!done || replayFootage) {
      /* A replay does not step aside on a timer: the reader is watching it,
         and the row's own Скрыть is the door out. The clock only settles the
         markless fallback poster. */
      setSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setSettled(true), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [done, replayFootage]);

  if (!hasScanStage(item) || settled) return null;
  if (!fromArchive && !url) return null;

  /* Two things are genuinely measured during a scan, and only one of them
     exists at a time: bytes on the wire, then frames through the engine. */
  const frames =
    item.frameTotal && item.frameTotal > 0
      ? { done: item.frameDone ?? 0, total: item.frameTotal }
      : null;
  const fraction = frames
    ? frames.done / frames.total
    : item.phase === "uploading" && item.bytesTotal > 0
      ? item.bytesSent / item.bytesTotal
      : null;
  const best = item.result?.best ?? null;

  if (replayFootage) {
    return (
      <div className="mt-2.5">
        {/* The replay owns the stage: engine, tally and transport are the
            dialog's own ReplayStage, so what plays here is what plays there. */}
        <div className="h-[420px] flex flex-col bg-surface2 border border-hair overflow-hidden">
          <ReplayStage f={replayFootage} />
        </div>
        {/* The way to the chart, from the thing that just landed on it. The
            flyto channel switches the mode and replays the event until the
            map answers — this button only has to say where. */}
        {Number.isFinite(replayFootage.center.lat) && Number.isFinite(replayFootage.center.lng) && (
          <div className="flex justify-end mt-1.5">
            <Button
              icon="map"
              onClick={() =>
                document.dispatchEvent(
                  new CustomEvent("flyto", {
                    detail: { lat: replayFootage.center.lat, lng: replayFootage.center.lng, zoom: 11 },
                  }),
                )
              }
            >
              {t("ingest.viewOnMap")}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2.5">
      {/* A fixed reading height, not an aspect ratio: a portrait photo and a
          16:9 frame both have to sit in the same column without the row under
          them jumping when the next file is a different shape. */}
      <div className="relative h-[420px] bg-surface2 border border-hair overflow-hidden">
        {fromArchive ? (
          /* The archive's own still with the engine's marks on it — the same
             component the evidence view uses, so a mark here and a mark there
             cannot come to mean different things. */
          <EvidenceFrame mediaId={item.mediaId!} pixels={item.pixels ?? []} />
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={url!}
            alt={t("ingest.scanAlt")}
            draggable={false}
            decoding="async"
            className="absolute inset-0 w-full h-full object-contain select-none"
          />
        )}

        {/* The tick edge stays through both states: it is the frame's ruler,
            not part of the animation. */}
        <div className="scan-ticks absolute inset-y-0 left-0 w-[5px] pointer-events-none" />

        {!done && (
          <div className="scan-sweep absolute inset-x-0 top-0 pointer-events-none" aria-hidden="true" />
        )}

        {done && (
          /* The count, in the signal colour, on a plate — landed beside the
             animals it counted rather than announced somewhere else. */
          <div className="scan-land plate absolute right-2 bottom-2 px-2.5 py-1.5 flex items-baseline gap-1.5">
            <span className="text-fig tnum text-accent">{best ?? "?"}</span>
            <span className="text-2xs text-ink3">{tp(best ?? 0, "insp.sealsCounted")}</span>
          </div>
        )}
      </div>

      {/* Under the image, where a scale belongs. The hairline is drawn only
          when there is a fraction behind it; the frame figures only when the
          engine sent frames. Both are absent on a job that reports neither,
          and the sweep alone carries "working". */}
      <div className="h-[2px] bg-hair overflow-hidden">
        {fraction !== null && (
          <div
            className="h-full bg-accent transition-[width] duration-200"
            style={{ width: `${Math.max(0, Math.min(100, Math.round(fraction * 100)))}%` }}
          />
        )}
      </div>
      <div className="flex items-baseline gap-2 mt-1 text-2xs text-ink3">
        {frames && (
          <span className="tnum text-accent">
            {frames.done}/{frames.total}
          </span>
        )}
        {done && <span>{t("ingest.scanReady")}</span>}
      </div>
    </div>
  );
}
