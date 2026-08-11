"use client";
/**
 * FramePicker — pick the frame the clip gets counted on.
 *
 * Video ingest is frame-first. One frame per second is drawn in this browser,
 * BEFORE a byte is uploaded, and the operator picks the one where the animals
 * actually read; that frame is exported as a JPEG and ingested as an image.
 * There is no second button here that quietly counts the whole clip instead —
 * the service can still do it and other callers still ask for it, but a hidden
 * full-analysis path inside a picker whose whole job is "choose a frame" is a
 * fork nobody was told they were taking.
 *
 * Two things this card owes the operator, and both are here because a frame
 * count is a narrower claim than the clip it came from:
 *
 *  · A frame big enough to judge. The strip fills the width it is given — four
 *    thumbnails abreast in the Загрузка screen's column, two in anything
 *    narrower — and the real look happens in a lightbox: the
 *    same Dialog the evidence view uses, arrow keys and all. The lightbox
 *    starts from the strip's own bitmap (nothing is re-extracted to open it)
 *    and upgrades in place to the frame at the video's native resolution: the
 *    exact JPEG that would be counted, so what is judged is what is measured.
 *  · The movement line. When the clip's own track says the aircraft travelled
 *    more than {@link CLIP_MOVED_M} between its first and last fix, one frame
 *    is part of a strip and the count is a floor for it. No track, no line —
 *    silence is the honest output for a clip that never said where it went.
 *
 * The resulting sortie is labelled single_image everywhere downstream. That
 * label is the point: it is what stops one frame of a transect being read as
 * the transect.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useIngestStore, CLIP_MOVED_M, type IngestItem } from "@/store/useIngestStore";
import { MAX_FRAMES, type ExtractedFrame, type FrameErrorCode } from "@/lib/media/frames";
import { Button } from "@/components/ui/primitives";
import Icon from "@/components/ui/Icon";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT, type I18nKey } from "@/lib/i18n";

const ERROR_KEY: Record<FrameErrorCode, I18nKey> = {
  no_metadata: "frames.errNoMetadata",
  no_duration: "frames.errNoDuration",
  seek_timeout: "frames.errSeek",
  draw_failed: "frames.errDraw",
  no_frames: "frames.errNone",
};

/* ------------------------------------------------------------- the lightbox */

/**
 * One frame, large. Mounted for as long as the picker is, so the frames a
 * person has already opened stay decoded while they compare them — and so the
 * object URLs behind them have exactly one place to be revoked.
 */
function FrameLightbox({
  frames,
  index,
  busy,
  onIndex,
  onChoose,
  onClose,
}: {
  frames: ExtractedFrame[];
  /** Which frame is open; null when the lightbox is shut. */
  index: number | null;
  busy: boolean;
  onIndex: (i: number) => void;
  onChoose: (atSeconds: number) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const frame = index === null ? null : (frames[index] ?? null);
  const at = frame?.atSeconds ?? null;

  /* The same instant at the video's native resolution, keyed by second. The
     strip's thumbnail is 320 px wide — enough for a 2-column grid, not enough
     to rule on an animal at 900 px — so the frame the count would actually run
     on is fetched once per frame and kept. */
  const cache = useRef(new Map<number, string>());
  const mounted = useRef(true);
  const wanted = useRef<number | null>(null);
  const [full, setFull] = useState<string | null>(null);

  useEffect(() => {
    const held = cache.current;
    return () => {
      mounted.current = false;
      for (const url of held.values()) URL.revokeObjectURL(url);
      held.clear();
    };
  }, []);

  useEffect(() => {
    wanted.current = at;
    if (at === null || !frame) {
      setFull(null);
      return;
    }
    const have = cache.current.get(at);
    if (have) {
      setFull(have);
      return;
    }
    setFull(null);
    void frame
      .toBlob()
      .then((b) => {
        if (!mounted.current) return;
        const url = URL.createObjectURL(b);
        cache.current.set(at, url);
        if (wanted.current === at) setFull(url);
      })
      .catch(() => {
        /* The decoder gave up on this instant. The preview stays on screen;
           nothing is claimed to be full resolution that is not. */
      });
  }, [at, frame]);

  /* ←/→ move across the strip. Bound on the window rather than on the dialog
     so the keys work wherever focus landed inside it — the close button, the
     confirm, the image. Escape belongs to Radix and closes the dialog. */
  useEffect(() => {
    if (index === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        onIndex(Math.min(frames.length - 1, index + 1));
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        onIndex(Math.max(0, index - 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, frames.length, onIndex]);

  return (
    <Dialog open={index !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="max-w-[92vw] w-[min(1000px,92vw)] h-[92vh] p-0 gap-0 flex flex-col overflow-hidden bg-bg border-line"
      >
        <DialogHeader className="flex-row items-baseline gap-3 space-y-0 px-4 py-3 pr-12 border-b border-line shrink-0">
          <DialogTitle className="text-base font-medium text-ink tracking-normal">
            {at === null ? t("frames.title") : t("frames.previewAt", { s: at })}
          </DialogTitle>
          {index !== null && (
            <span className="text-xs text-ink3 tnum">
              {index + 1}/{frames.length}
            </span>
          )}
          {!full && index !== null && (
            <span className="text-2xs text-ink3">{t("frames.fullRes")}</span>
          )}
          <span className="ml-auto text-2xs text-ink3 hidden sm:block">{t("frames.keys")}</span>
        </DialogHeader>

        {/* Absolutely filled and `object-contain`, NOT a centred `max-h-full`:
            a percentage max-height inside an auto-sized track resolves against
            nothing, so a 720×1280 frame laid itself out at natural size and the
            bottom third of it was simply clipped away by the dialog — a picker
            hiding part of the very frame it is asking a person to judge. */}
        <div className="flex-1 min-h-0 relative bg-bg">
          {frame && (
            /* Drawn by this browser from the operator's own file. The preview
               is shown the instant the lightbox opens and swapped for the
               native-resolution frame when that has decoded, so the panel is
               never blank and never pretends to a sharpness it does not have
               yet. */
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={full ?? frame.dataUrl}
              alt=""
              className="absolute inset-0 w-full h-full object-contain p-1"
            />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 px-4 py-3 border-t border-line shrink-0">
          <Button
            icon="chevronLeft"
            title={t("frames.prev")}
            disabled={index === null || index === 0}
            onClick={() => index !== null && onIndex(Math.max(0, index - 1))}
          >
            {t("frames.prev")}
          </Button>
          <Button
            icon="chevronRight"
            title={t("frames.next")}
            disabled={index === null || index >= frames.length - 1}
            onClick={() => index !== null && onIndex(Math.min(frames.length - 1, index + 1))}
          >
            {t("frames.next")}
          </Button>
          <div className="ml-auto flex items-center gap-1.5">
            <Button variant="ghost" onClick={onClose}>
              {t("btn.cancel")}
            </Button>
            <Button
              variant="primary"
              icon="check"
              disabled={at === null || busy}
              onClick={() => at !== null && onChoose(at)}
            >
              {t("frames.choose")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ----------------------------------------------------------------- the card */

export default function FramePicker({ item }: { item: IngestItem }) {
  const { t } = useT();
  const wantFrames = useIngestStore((s) => s.wantFrames);
  const chooseQuickCount = useIngestStore((s) => s.chooseQuickCount);
  const [open, setOpen] = useState<number | null>(null);

  /* Extraction lives in the store, so closing the panel mid-strip and
     reopening it costs nothing. This only kicks it off if nothing has yet. */
  useEffect(() => {
    if (!item.frames && !item.framesBusy && !item.frameError) void wantFrames(item.id);
  }, [item.id, item.frames, item.framesBusy, item.frameError, wantFrames]);

  const frames = item.frames ?? [];
  const spread = item.frameSpread;
  const busy = !!item.framesBusy;

  const choose = useCallback(
    (atSeconds: number) => {
      setOpen(null);
      void chooseQuickCount(item.id, atSeconds);
    },
    [chooseQuickCount, item.id],
  );

  /* Measured, or absent. `undefined` means the track has not been read yet and
     `null` means the clip carries none — neither is a licence to say anything
     about how far the aircraft went. */
  const moved = item.frameMoveM != null && item.frameMoveM > CLIP_MOVED_M ? item.frameMoveM : null;

  return (
    /* A nested box inside a row that is already delimited by a hairline is one
       frame too many. The head and the strip's own alignment carry it. */
    <div className="mt-3">
      <div className="hd">{t("frames.title")}</div>
      <div className="text-xs text-ink3 mt-1 leading-relaxed">{t("frames.pickWhy")}</div>

      {busy && frames.length === 0 && (
        <div className="text-2xs text-ink3 mt-1.5">{t("frames.extracting")}</div>
      )}

      {frames.length > 0 && (
        <>
          <div className="text-2xs text-ink3 mt-1 leading-relaxed">
            {spread?.evenlySpaced
              ? t("frames.spread", { n: frames.length, max: MAX_FRAMES, dur: Math.round(spread.duration) })
              : t("frames.perSecond", { n: frames.length })}
          </div>
          {/* One muted line, only when the clip's own track says it moved. */}
          {moved !== null && (
            <div className="text-2xs text-ink3 mt-1 leading-relaxed">
              {t("frames.moved", { m: Math.round(moved) })}
            </div>
          )}
          {/* Auto-fill, not a fixed column count: the strip is handed a 640 px
              reading column on the Загрузка screen and lays out four frames
              abreast, and it still degrades to two in anything narrow without
              a second breakpoint to keep in step. */}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-2 mt-2">
            {frames.map((f, i) => (
              <div
                key={f.atSeconds}
                /* Held by a hairline that goes to full ink under the cursor —
                   the reference's own "this one" mark. NOT the signal colour:
                   hovering a thumbnail is not a live state, and a strip of
                   green rectangles would outshout the counts on the map.
                   The frames themselves stay at full opacity, because judging
                   animals in them is the entire job of this control. */
                className="relative group overflow-hidden border border-hair hover:border-ink transition-colors"
              >
                {/* Opening the frame is the main path: a ~130 px thumbnail is
                    for finding the candidate, not for ruling on it. */}
                <button
                  onClick={() => setOpen(i)}
                  disabled={busy}
                  title={t("frames.openAt", { s: f.atSeconds })}
                  className="block w-full disabled:opacity-50 disabled:pointer-events-none"
                >
                  {/* A frame the browser drew from the operator's own file — no
                      remote source, nothing to sanitise, and it is never
                      rendered as markup. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={f.dataUrl} alt="" className="block w-full aspect-video object-cover" />
                </button>
                <span className="absolute bottom-0 left-0 bg-black/70 text-2xs text-ink2 px-1.5 tnum pointer-events-none">
                  {f.atSeconds}s
                </span>
                {/* The shortcut for somebody who already knows which frame they
                    want. It is deliberately not the only way in. */}
                <button
                  onClick={() => choose(f.atSeconds)}
                  disabled={busy}
                  title={t("frames.quickAt", { s: f.atSeconds })}
                  aria-label={t("frames.quickAt", { s: f.atSeconds })}
                  className="absolute top-0 right-0 grid h-7 w-7 place-items-center bg-black/70 text-ink3 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 hover:text-ink disabled:pointer-events-none [@media(hover:none)]:opacity-100 sm:h-5 sm:w-5"
                >
                  <Icon name="check" size={11} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {item.frameError && (
        <div className="text-2xs text-ink2 mt-1.5 leading-relaxed">
          {t(ERROR_KEY[item.frameError])}
          {/* With no frame there is nothing to count: the clip is not ingested
              here at all, and the card says that instead of implying a second
              path that no longer exists. */}
          {frames.length > 0 ? ` ${t("frames.partial", { n: frames.length })}` : ` ${t("frames.noPath")}`}
        </div>
      )}

      <FrameLightbox
        frames={frames}
        index={open}
        busy={busy}
        onIndex={setOpen}
        onChoose={choose}
        onClose={() => setOpen(null)}
      />
    </div>
  );
}
