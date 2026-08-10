"use client";
/**
 * Dropzone — where files enter the platform, and the body of the Загрузка mode.
 *
 * It does three things and hands everything else to the ingest store: it takes
 * a drop, it decides what each file IS, and it collects the survey metadata the
 * operator can only supply here. The queue beside it is a view over the store,
 * so leaving the screen mid-count no longer throws the log away.
 *
 * It is laid out as a page now, not as a panel: the drop target is a strip
 * across the top, the queue is a reading column under it, and the survey
 * details stand in their own column to the right instead of being folded away
 * behind a disclosure because 360 px had no room for four fields.
 *
 * The grouping rule changed, and it is the reason this component was rewritten.
 * Files used to be grouped by lowercased basename, one queue entry per group:
 * two cards each holding a DJI_0001.MP4 collapsed into one entry and the second
 * file was discarded before it was ever probed, silently. A stem carrying both
 * a photo and a video lost the video the same way. Now the STEM groups sidecars
 * only — which is what a stem is genuinely for — and every media file gets its
 * own row under its own real filename.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  useIngestStore,
  kindOf,
  NOTE_MAX,
  SIDECAR_RE,
  type IngestReason,
  type NewIngest,
} from "@/store/useIngestStore";
import { useFootageStore } from "@/store/useFootageStore";
import { useOperator } from "@/lib/identity";
import IngestQueue, { FailedIngests } from "@/components/upload/IngestQueue";
import Icon from "@/components/ui/Icon";
import { Button } from "@/components/ui/primitives";
import { useT } from "@/lib/i18n";

/** Sample footage bundled with the app so the ingest flow can be tried without
 *  sourcing a drone file. Real video, real GPS in its metadata. */
const SAMPLE_CLIP = { url: "/samples/FIELD_0001.MP4", name: "FIELD_0001.MP4" };

/** Camera raw. The engine reads decoded pixels; a .DNG is a sensor dump. */
const RAW_RE = /\.(dng|arw|cr2|cr3|nef|raf|orf|rw2|pef|srw|3fr|iiq)$/i;
/** Flight logs and the rest of what comes off an SD card. */
const LOG_RE = /\.(csv|txt|log|gpx|kml|kmz|dat|xml)$/i;

const stemOf = (name: string) => name.replace(/\.[^.]+$/, "").toLowerCase();

/** The honest per-type sentence for a file this platform cannot read. */
function skipReason(name: string): IngestReason {
  if (RAW_RE.test(name)) return { key: "ingest.skipRaw", vars: { name } };
  if (LOG_RE.test(name)) return { key: "ingest.skipLog", vars: { name } };
  return { key: "ingest.skipUnknown", vars: { name } };
}

/* No `onSettled` any more, and the prop is gone rather than merely unused: the
   screen no longer closes over the queue, it hands back to the map, and the
   shell owns that hand-back. A second component able to signal the same return
   is a race whose loser strands somebody on a finished list. */
export default function Dropzone() {
  const { t } = useT();
  const [drag, setDrag] = useState(false);
  const [loadingSample, setLoadingSample] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const enqueue = useIngestStore((s) => s.enqueue);
  const meta = useIngestStore((s) => s.meta);
  const setMeta = useIngestStore((s) => s.setMeta);
  const pinTarget = useIngestStore((s) => s.pinTarget);
  const claimPin = useIngestStore((s) => s.claimPin);
  const refreshFailed = useIngestStore((s) => s.refreshFailed);
  const wantFrames = useIngestStore((s) => s.wantFrames);

  /* Who this upload will be attributed to. Read, not edited: the identity is
     one field in the top bar, and a second input for the same name here is how
     two halves of an app end up disagreeing about who did the work. */
  const [operator] = useOperator();
  const pinMode = useFootageStore((s) => s.pinMode);
  const pinPoints = useFootageStore((s) => s.pinPoints);
  const setPinMode = useFootageStore((s) => s.setPinMode);
  const setPinPoints = useFootageStore((s) => s.setPinPoints);

  useEffect(() => {
    void refreshFailed();
  }, [refreshFailed]);

  /* One pass over the drop. Every file leaves this loop as a row: countable,
     skipped-with-a-reason, or attached to a media file as its sidecar. Nothing
     is dropped on the floor, which is the whole change. */
  const takeFiles = useCallback(
    (files: FileList | File[]) => {
      const arr = Array.from(files as FileList);
      if (!arr.length) return;

      /* Sidecars indexed by stem, .srt winning over .json when both exist —
         the SRT is the telemetry, the JSON is usually an export of it. */
      const sidecarByStem = new Map<string, File[]>();
      for (const f of arr) {
        if (!SIDECAR_RE.test(f.name)) continue;
        const stem = stemOf(f.name);
        const list = sidecarByStem.get(stem) ?? [];
        if (/\.srt$/i.test(f.name)) list.unshift(f);
        else list.push(f);
        sidecarByStem.set(stem, list);
      }
      /* How many media files claim each stem. A sidecar is only attached when
         exactly ONE does: two cards' worth of DJI_0001.MP4 next to a single
         DJI_0001.SRT means one of the two videos would be georeferenced
         against a flight it never flew. */
      const mediaPerStem = new Map<string, number>();
      for (const f of arr) {
        const k = kindOf(f.name);
        if (k === "video" || k === "image") {
          const stem = stemOf(f.name);
          mediaPerStem.set(stem, (mediaPerStem.get(stem) ?? 0) + 1);
        }
      }

      const entries: NewIngest[] = [];
      const claimed = new Set<File>();
      let unreadable = 0;
      /* EVERY video goes to the picker — bulk drops included. Picking the
         frame IS how a clip is counted now; the whole-clip path is gone from
         this app. The decode load that used to justify a bulk exception is
         handled where it belongs: the store serializes extraction, one clip's
         decoder at a time, and the other cards honestly say "extracting". */
      const videos = new Set(arr.filter((f) => kindOf(f.name) === "video"));

      for (const f of arr) {
        const kind = kindOf(f.name);
        if (kind === "sidecar") continue;
        if (kind === "other") {
          entries.push({ file: f, kind: "other", phase: "skipped", reason: skipReason(f.name) });
          unreadable++;
          continue;
        }
        const stem = stemOf(f.name);
        const pool = sidecarByStem.get(stem);
        const solo = (mediaPerStem.get(stem) ?? 0) === 1;
        const sidecar = pool && pool.length && solo ? pool[0] : null;
        if (sidecar) claimed.add(sidecar);
        /* Keyed on the File object: a photo and a video sharing a stem are two
           rows, and so are two files that merely happen to be named alike.
           The frame choice is set HERE, before the row is enqueued — the
           worker takes the first `queued` item the instant enqueue returns, so
           asking afterwards would lose the race and count the whole video. */
        entries.push({ file: f, sidecar, kind, phase: videos.has(f) ? "frame_choice" : undefined });
      }

      for (const [stem, pool] of sidecarByStem) {
        const media = mediaPerStem.get(stem) ?? 0;
        for (const sc of pool) {
          if (claimed.has(sc)) continue;
          entries.push({
            file: sc,
            kind: "sidecar",
            phase: "skipped",
            reason:
              media > 1
                ? { key: "ingest.skipAmbiguousSidecar", vars: { name: sc.name, n: media } }
                : { key: "ingest.skipOrphanSidecar", vars: { name: sc.name } },
          });
          unreadable++;
        }
      }

      const ids = enqueue(entries);

      /* ONE collapsed toast for the whole drop. A toast per unreadable file
         buries the ones that DID make it in a stack of red. */
      if (unreadable > 0) toast.error(t("ingest.someSkipped", { n: unreadable, total: arr.length }));

      entries.forEach((e, i) => {
        if (videos.has(e.file)) void wantFrames(ids[i]);
      });
    },
    [enqueue, wantFrames, t],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDrag(false);
      if (e.dataTransfer.files?.length) takeFiles(e.dataTransfer.files);
    },
    [takeFiles],
  );

  const onInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files?.length) takeFiles(e.target.files);
      // Clear the input, or picking the same file twice in a row fires no
      // change event at all and the second attempt looks ignored.
      e.target.value = "";
    },
    [takeFiles],
  );

  /** Pull the bundled sample clip through the normal ingest path. */
  const loadSampleClip = useCallback(async () => {
    setLoadingSample(true);
    try {
      const res = await fetch(SAMPLE_CLIP.url);
      if (!res.ok) throw new Error(`${res.status}`);
      const blob = await res.blob();
      takeFiles([new File([blob], SAMPLE_CLIP.name, { type: "video/mp4" })]);
    } catch (e: any) {
      toast.error(t("drop.sampleError", { msg: String(e?.message ?? e), url: SAMPLE_CLIP.url }));
    } finally {
      setLoadingSample(false);
    }
  }, [takeFiles, t]);

  /* An anchor nobody owns. It is shown, never applied: the old image branch
     consumed whatever pin happened to be armed and published a coordinate the
     photo had no relationship to, to four decimals, with no confirmation. */
  const orphanAnchor = pinMode && !pinTarget && pinPoints.length > 0;

  return (
    /* No stack of boxes. Each band is held by a hairline and by the alignment
       of its own left edge — the drop target, the survey metadata, the sample
       clip and the queue read as one instrument, not as four grey cards
       floating in a fifth. */
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-label={t("drop.title")}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileRef.current?.click();
          }
        }}
        /* The dashed rounded rectangle is gone: a drop target announces itself
           in words, and a dashed box around them is the app drawing a picture
           of a box. Dragging over it is a live state, so it is allowed the
           signal colour — the only moment this band is anything but grey. */
        className={`border-y py-4 transition-colors cursor-pointer flex flex-wrap items-center gap-x-6 gap-y-3 ${
          drag ? "border-accent bg-accent-soft" : "border-t-line border-b-hair hover:bg-hover"
        }`}
      >
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <Icon name="upload" size={13} className="text-ink4 shrink-0 translate-y-px" />
            <span className="text-base font-medium text-ink">{t("drop.title")}</span>
          </div>
          <div className="text-xs text-ink3 mt-1 leading-relaxed">{t("drop.sub")}</div>
          <div className="text-2xs text-ink3 mt-1">{t("ingest.acceptedTypes")}</div>
        </div>
        {/* The whole strip is the target, but a person who has never dropped a
            file onto a web page needs a control to press, and "click the big
            area" is not a control. It opens the same picker; the click is
            stopped here so the strip's own handler does not open a second one
            on top of it. */}
        <div className="ml-auto shrink-0">
          <Button
            icon="upload"
            onClick={(e) => {
              e.stopPropagation();
              fileRef.current?.click();
            }}
          >
            {t("drop.browse")}
          </Button>
        </div>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".mp4,.mov,.avi,.mkv,.webm,.jpg,.jpeg,.png,.tif,.tiff,.webp,.srt,.json"
          onChange={onInput}
          onClick={(e) => e.stopPropagation()}
          className="hidden"
        />
      </div>

      {/* ------------------------------------------------------ two columns */}
      {/* The queue is the wide half and the survey details stand beside it. On
          a narrow window the two stack in source order — queue first, because
          the queue is what a person came here to watch; the survey details are
          filled once for a drop and then left alone. */}
      <div className="mt-6 flex flex-col gap-x-10 gap-y-8 lg:flex-row lg:items-start">
        <div className="flex-1 min-w-0 lg:max-w-[640px]">
          {/* An aside, marked the way the instrument marks asides: one rule
              down its left edge. The pin glyph keeps the signal colour — an
              armed anchor is genuinely live. */}
          {orphanAnchor && (
            <div className="mb-4 border-l border-line pl-2.5 flex items-start gap-2">
              <Icon name="pin" size={13} className="text-accent mt-0.5" />
              <div className="flex-1 min-w-0 text-2xs text-ink2 leading-relaxed">
                {t("ingest.anchorNoOwner")}
              </div>
              <button
                onClick={() => {
                  setPinPoints([]);
                  setPinMode(false);
                  claimPin(null);
                }}
                className="text-ink3 hover:text-ink"
                aria-label={t("btn.clear")}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          )}

          <IngestQueue />

          {/* The failures the SERVICE remembers. They used to be pinned to the
              map, visible from everywhere, because the ingest panel could be
              shut over them. The panel is gone and the rail now carries the
              needs-you count from every mode, so this is their one home — and
              it is the screen the count sends you to. */}
          <FailedIngests />
        </div>

        {/* ----------------------------------------- the survey metadata */}
        {/* The service has had these fields since /v1/media was written and no
            caller has ever filled them — which is unsurprising, since until now
            they lived folded away behind a disclosure in a 360 px panel. An
            altitude typed here is what turns an unknown scale into a measured
            one for every hectare downstream, so it is on screen, always, beside
            the queue it applies to.
            The fields are underlines rather than boxes: an input is a place a
            value is written on the instrument, and four outlined rectangles are
            four rectangles competing with the numbers. */}
        <aside className="w-full shrink-0 lg:w-[264px]">
          <div className="hd pb-1.5 border-b border-line">{t("ingest.metaTitle")}</div>
          <div className="pt-2.5 space-y-3">
            <label className="block">
              <span className="label">{t("ingest.metaDate")}</span>
              <input
                type="date"
                value={(meta.captured_at ?? "").slice(0, 10)}
                onChange={(e) => setMeta({ captured_at: e.target.value || undefined })}
                className="w-full h-7 mt-0.5 bg-transparent border-x-0 border-t-0 border-b border-line px-0 text-xs text-ink tnum transition-colors focus:outline-none focus:border-ink2"
              />
            </label>
            <label className="block">
              <span className="label">{t("ingest.metaAltitude")}</span>
              <input
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                value={meta.altitude_m ?? ""}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setMeta({ altitude_m: e.target.value === "" || !Number.isFinite(n) || n <= 0 ? undefined : n });
                }}
                className="w-full h-7 mt-0.5 bg-transparent border-x-0 border-t-0 border-b border-line px-0 text-xs text-ink tnum transition-colors focus:outline-none focus:border-ink2"
              />
            </label>
            <div>
              <span className="label">{t("ingest.metaOperator")}</span>
              <div className="text-xs text-ink mt-0.5">
                {operator ?? <span className="text-ink3">{t("ingest.metaOperatorNone")}</span>}
              </div>
            </div>
            <label className="block">
              <span className="label">{t("ingest.metaNote")}</span>
              <textarea
                rows={3}
                maxLength={NOTE_MAX}
                value={meta.notes ?? ""}
                onChange={(e) => setMeta({ notes: e.target.value })}
                className="w-full mt-0.5 bg-transparent border-x-0 border-t-0 border-b border-line px-0 py-1 text-xs text-ink resize-y transition-colors focus:outline-none focus:border-ink2"
              />
            </label>
            <div className="text-2xs text-ink3 leading-relaxed">{t("ingest.metaWhy")}</div>
          </div>

          {/* Nothing to source, nothing to install — a real GPS-tagged clip
              ships with the app, so the ingest path can be tried on a bare
              machine. */}
          <button
            onClick={loadSampleClip}
            disabled={loadingSample}
            aria-label={t("drop.sampleAria")}
            className="mt-5 w-full flex items-start gap-2 py-2 border-t border-hair text-left transition-colors hover:bg-hover disabled:opacity-60 disabled:pointer-events-none"
          >
            <Icon name={loadingSample ? "download" : "map"} size={13} className="text-ink3 mt-0.5 shrink-0" />
            <span className="flex-1 min-w-0">
              <span className="block text-xs text-ink">
                {loadingSample ? t("drop.sampleLoading") : t("drop.sampleUse")}
              </span>
              <span className="block text-2xs text-ink3 leading-relaxed">{t("drop.sampleDesc")}</span>
            </span>
          </button>
        </aside>
      </div>
    </div>
  );
}
