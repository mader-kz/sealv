"use client";
/**
 * FramePicker — see the clip before spending twenty minutes counting it.
 *
 * One frame per second, drawn in this browser, shown BEFORE a byte is
 * uploaded. Two explicit paths, and the operator chooses:
 *
 *  · Full analysis — the whole video, consensus across its frames, and the
 *    low–high band that comes out of that comparison. Visually primary here
 *    because the band is the honest part of the product: it is the only thing
 *    that says how much the count could be out by.
 *  · Quick count — the picked frame alone, exported as a JPEG and ingested as
 *    an image. Faster and cheaper, and it gives up the band; there is nothing
 *    to compare one frame against. The button says exactly that, next to it,
 *    every time — a faster mode that quietly stopped reporting uncertainty
 *    would be the most expensive shortcut in this codebase.
 *
 * Picking a frame never silently replaces full analysis.
 */

import { useEffect } from "react";
import { useIngestStore, type IngestItem } from "@/store/useIngestStore";
import { MAX_FRAMES, type FrameErrorCode } from "@/lib/media/frames";
import { Button } from "@/components/ui/primitives";
import { useT, type I18nKey } from "@/lib/i18n";

const ERROR_KEY: Record<FrameErrorCode, I18nKey> = {
  no_metadata: "frames.errNoMetadata",
  no_duration: "frames.errNoDuration",
  seek_timeout: "frames.errSeek",
  draw_failed: "frames.errDraw",
  no_frames: "frames.errNone",
};

export default function FramePicker({ item }: { item: IngestItem }) {
  const { t } = useT();
  const wantFrames = useIngestStore((s) => s.wantFrames);
  const chooseFullAnalysis = useIngestStore((s) => s.chooseFullAnalysis);
  const chooseQuickCount = useIngestStore((s) => s.chooseQuickCount);

  /* Extraction lives in the store, so closing the panel mid-strip and
     reopening it costs nothing. This only kicks it off if nothing has yet. */
  useEffect(() => {
    if (!item.frames && !item.framesBusy && !item.frameError) void wantFrames(item.id);
  }, [item.id, item.frames, item.framesBusy, item.frameError, wantFrames]);

  const frames = item.frames ?? [];
  const spread = item.frameSpread;

  return (
    <div className="mt-2 rounded border border-line bg-surface p-2">
      <div className="label">{t("frames.title")}</div>

      {item.framesBusy && frames.length === 0 && (
        <div className="text-2xs text-ink3 mt-1.5">{t("frames.extracting")}</div>
      )}

      {frames.length > 0 && (
        <>
          <div className="text-2xs text-ink3 mt-1 leading-relaxed">
            {spread?.evenlySpaced
              ? t("frames.spread", { n: frames.length, max: MAX_FRAMES, dur: Math.round(spread.duration) })
              : t("frames.perSecond", { n: frames.length })}
          </div>
          <div className="grid grid-cols-4 gap-1 mt-1.5">
            {frames.map((f) => (
              <button
                key={f.atSeconds}
                onClick={() => void chooseQuickCount(item.id, f.atSeconds)}
                disabled={item.framesBusy}
                title={t("frames.quickAt", { s: f.atSeconds })}
                className="relative group rounded overflow-hidden border border-line hover:border-accent transition-colors disabled:opacity-50 disabled:pointer-events-none"
              >
                {/* A frame the browser drew from the operator's own file — no
                    remote source, nothing to sanitise, and it is never
                    rendered as markup. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={f.dataUrl} alt="" className="block w-full aspect-video object-cover" />
                <span className="absolute bottom-0 right-0 bg-bg/80 text-2xs text-ink px-1 tnum">
                  {f.atSeconds}s
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {item.frameError && (
        <div className="text-2xs text-ink2 mt-1.5 leading-relaxed">
          {t(ERROR_KEY[item.frameError])}
          {frames.length > 0 ? ` ${t("frames.partial", { n: frames.length })}` : ` ${t("frames.fallFull")}`}
        </div>
      )}

      {/* Full analysis is the primary control and stays primary whether or not
          the strip came out — a codec this browser cannot decode says nothing
          about whether the engine can count the video. */}
      <div className="flex flex-wrap items-center gap-1.5 mt-2">
        <Button variant="primary" icon="check" onClick={() => chooseFullAnalysis(item.id)}>
          {t("frames.full")}
        </Button>
        <span className="text-2xs text-ink3">{t("frames.fullWhy")}</span>
      </div>
      {frames.length > 0 && (
        <div className="text-2xs text-ink3 mt-1.5 leading-relaxed">{t("frames.quickTrade")}</div>
      )}
    </div>
  );
}
