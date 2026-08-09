"use client";
/**
 * Dropzone — where files enter the platform.
 *
 * It does three things and hands everything else to the ingest store: it takes
 * a drop, it decides what each file IS, and it collects the survey metadata the
 * operator can only supply here. The queue below it is a view over the store,
 * so closing this panel mid-count no longer throws the log away.
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
import IngestQueue from "@/components/upload/IngestQueue";
import Icon from "@/components/ui/Icon";
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

export default function Dropzone() {
  const { t } = useT();
  const [drag, setDrag] = useState(false);
  const [loadingSample, setLoadingSample] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const enqueue = useIngestStore((s) => s.enqueue);
  const meta = useIngestStore((s) => s.meta);
  const setMeta = useIngestStore((s) => s.setMeta);
  const metaOpen = useIngestStore((s) => s.metaOpen);
  const setMetaOpen = useIngestStore((s) => s.setMetaOpen);
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
    <div className="space-y-2">
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
        className={`rounded border border-dashed px-3 py-5 transition-colors text-center cursor-pointer ${
          drag ? "border-accent bg-accent-soft" : "border-line hover:border-ink3 hover:bg-surface2"
        }`}
      >
        <Icon name="upload" size={16} className="text-ink3 mx-auto" />
        <div className="text-sm text-ink mt-2">{t("drop.title")}</div>
        <div className="text-xs text-ink3 mt-1 leading-relaxed">{t("drop.sub")}</div>
        <div className="text-2xs text-ink3 mt-1">{t("ingest.acceptedTypes")}</div>
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

      {/* --------------------------------------------- the survey metadata */}
      {/* The service has had these fields since /v1/media was written and no
          caller has ever filled them. An altitude typed here is what turns an
          unknown scale into a measured one for every hectare downstream. */}
      <div className="rounded border border-line bg-surface2">
        <button
          onClick={() => setMetaOpen(!metaOpen)}
          className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left"
          aria-expanded={metaOpen}
        >
          <Icon name={metaOpen ? "chevronLeft" : "chevronRight"} size={12} className="text-ink3" />
          <span className="text-xs text-ink2 flex-1">{t("ingest.metaTitle")}</span>
          <span className="text-2xs text-ink3 truncate max-w-[120px]">
            {[meta.captured_at, meta.altitude_m ? `${meta.altitude_m} ${t("unit.m")}` : "", operator]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </button>
        {metaOpen && (
          <div className="px-2.5 pb-2.5 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="label">{t("ingest.metaDate")}</span>
                <input
                  type="date"
                  value={(meta.captured_at ?? "").slice(0, 10)}
                  onChange={(e) => setMeta({ captured_at: e.target.value || undefined })}
                  className="w-full h-7 mt-1 bg-surface border border-line rounded px-2 text-xs text-ink focus:outline-none focus:border-ink3"
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
                  className="w-full h-7 mt-1 bg-surface border border-line rounded px-2 text-xs text-ink tnum focus:outline-none focus:border-ink3"
                />
              </label>
            </div>
            <div>
              <span className="label">{t("ingest.metaOperator")}</span>
              <div className="text-xs text-ink mt-1">
                {operator ?? <span className="text-ink3">{t("ingest.metaOperatorNone")}</span>}
              </div>
            </div>
            <label className="block">
              <span className="label">{t("ingest.metaNote")}</span>
              <textarea
                rows={2}
                maxLength={NOTE_MAX}
                value={meta.notes ?? ""}
                onChange={(e) => setMeta({ notes: e.target.value })}
                className="w-full mt-1 bg-surface border border-line rounded px-2 py-1.5 text-xs text-ink resize-y focus:outline-none focus:border-ink3"
              />
            </label>
            <div className="text-2xs text-ink3 leading-relaxed">{t("ingest.metaWhy")}</div>
          </div>
        )}
      </div>

      {/* Nothing to source, nothing to install — a real GPS-tagged clip ships
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
          <span className="block text-2xs text-ink3 truncate">{t("drop.sampleDesc")}</span>
        </span>
      </button>

      {orphanAnchor && (
        <div className="rounded border border-line bg-surface2 px-2.5 py-2 flex items-start gap-2">
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
    </div>
  );
}
