"use client";
/**
 * Dropzone — where files enter the platform, and the body of the Загрузка mode.
 *
 * It does three things and hands everything else to the ingest store: it takes
 * a drop, it decides what each file IS, and it collects the survey metadata the
 * operator can only supply here. The queue beside it is a view over the store,
 * so leaving the screen mid-count no longer throws the log away.
 *
 * It is laid out as a page now, not as a panel. The shape follows the state of
 * the queue, because the two states want opposite things:
 *
 *  · EMPTY. One calm card in the middle of the column: a mark, one line, and
 *    one quiet line of formats. Three lines of format prose, a paragraph about
 *    altitude and a permanently open four-field survey column added up to a
 *    screen that was mostly text about a thing that had not happened yet.
 *  · WORKING. The queue owns the width and everything else steps back to a
 *    strip above it.
 *
 * The survey details are folded behind a disclosure again — but for the
 * opposite reason to the old 360 px panel, which hid them because there was no
 * room. There is room; they are simply not what a person is looking at, on a
 * screen whose subject is a file being counted. Open, they are the same four
 * fields, and the honest paragraph about what an altitude buys is on the
 * altitude field itself as its tooltip: demoted, not deleted.
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
  /* Closed by default, and deliberately not remembered: the survey block is
     filled once for a drop, and a disclosure that reopens itself every visit
     is the permanent column again by another name. */
  const [metaOpen, setMetaOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  /* Only the length. The queue's own view subscribes to the items; this
     component re-laying itself out on every byte of upload progress would be
     the whole screen re-rendering thirty times a second. */
  const queueLength = useIngestStore((s) => s.items.length);
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

  const empty = queueLength === 0;

  /* The file input, mounted once and shared by every control that opens a
     picker. Two inputs for one job is two places for the "same file twice"
     bug to live. */
  const input = (
    <input
      ref={fileRef}
      type="file"
      multiple
      accept=".mp4,.mov,.avi,.mkv,.webm,.jpg,.jpeg,.png,.tif,.tiff,.webp,.srt,.json"
      onChange={onInput}
      onClick={(e) => e.stopPropagation()}
      className="hidden"
    />
  );

  const dropProps = {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": t("drop.title"),
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDrag(true);
    },
    onDragLeave: () => setDrag(false),
    onDrop,
    onClick: () => fileRef.current?.click(),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileRef.current?.click();
      }
    },
  };

  /* The bundled clip. One line, at the weight of an offer rather than of a
     feature: nothing to source and nothing to install, so the ingest path can
     be tried on a bare machine. */
  const sampleRow = (
    <button
      onClick={loadSampleClip}
      disabled={loadingSample}
      aria-label={t("drop.sampleAria")}
      className="w-full flex items-baseline gap-2 py-2 border-t border-hair text-left transition-colors hover:bg-hover disabled:opacity-60 disabled:pointer-events-none"
    >
      <Icon name={loadingSample ? "download" : "map"} size={13} className="text-ink3 shrink-0 translate-y-px" />
      <span className="text-xs text-ink shrink-0">
        {loadingSample ? t("drop.sampleLoading") : t("drop.sampleUse")}
      </span>
      {/* The provenance only where there is room for it — on the working
          screen the aria-label still carries it. */}
      {empty && <span className="text-2xs text-ink3 min-w-0 truncate">{t("drop.sampleDesc")}</span>}
    </button>
  );

  /* The survey block, folded. The head is the control: a rule, a label and a
     chevron, the same disclosure the season summary uses. */
  const metaBlock = (
    <div className="mt-5">
      <button
        type="button"
        onClick={() => setMetaOpen((v) => !v)}
        aria-expanded={metaOpen}
        title={metaOpen ? t("ingest.metaCollapse") : t("ingest.metaExpand")}
        className="w-full flex items-center gap-2 pb-1.5 border-b border-line text-left text-ink3 hover:text-ink transition-colors"
      >
        <Icon name={metaOpen ? "chevronUp" : "chevronDown"} size={13} className="shrink-0" />
        <span className="hd">{t("ingest.metaTitle")}</span>
      </button>
      {metaOpen && (
        /* Two columns where the column allows it — these are four short
           fields, and a 640 px stack of them is a form pretending to be
           long. The fields are underlines rather than boxes: a value is
           written ON the instrument, and four outlined rectangles are four
           rectangles competing with the numbers. */
        <div className="pt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
          <label className="block">
            <span className="label">{t("ingest.metaDate")}</span>
            <input
              type="date"
              value={(meta.captured_at ?? "").slice(0, 10)}
              onChange={(e) => setMeta({ captured_at: e.target.value || undefined })}
              className="w-full h-7 mt-0.5 bg-transparent border-x-0 border-t-0 border-b border-line px-0 text-xs text-ink tnum transition-colors focus:outline-none focus:border-ink2"
            />
          </label>
          {/* The five lines about what an altitude buys used to stand under
              this block as a paragraph. It is the same sentence, on the field
              it is about, where it is read by the person who is deciding
              whether to type a number — and nowhere else. */}
          <label className="block" title={t("ingest.metaWhy")}>
            <span className="label">{t("ingest.metaAltitude")}</span>
            <input
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              title={t("ingest.metaWhy")}
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
          <label className="block sm:col-span-2">
            <span className="label">{t("ingest.metaNote")}</span>
            <textarea
              rows={2}
              maxLength={NOTE_MAX}
              value={meta.notes ?? ""}
              onChange={(e) => setMeta({ notes: e.target.value })}
              className="w-full mt-0.5 bg-transparent border-x-0 border-t-0 border-b border-line px-0 py-1 text-xs text-ink resize-y transition-colors focus:outline-none focus:border-ink2"
            />
          </label>
        </div>
      )}
    </div>
  );

  /* An anchor nobody owns, as an aside marked the way this instrument marks
     asides: one rule down its left edge. The pin glyph keeps the signal
     colour — an armed anchor is genuinely live. */
  const anchorAside = orphanAnchor && (
    <div className="mb-4 border-l border-line pl-2.5 flex items-start gap-2">
      <Icon name="pin" size={13} className="text-accent mt-0.5" />
      <div className="flex-1 min-w-0 text-2xs text-ink2 leading-relaxed">{t("ingest.anchorNoOwner")}</div>
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
  );

  /* ------------------------------------------------------- nothing dropped */
  if (empty) {
    return (
      <div className="mx-auto w-full max-w-[520px] pt-8">
        <div
          {...dropProps}
          className={`border px-6 py-14 flex flex-col items-center text-center gap-2 cursor-pointer transition-colors ${
            drag ? "border-accent bg-accent-soft" : "border-line hover:bg-hover"
          }`}
        >
          <Icon name="upload" size={20} className="text-ink4" />
          <div className="text-lead text-ink">{t("drop.title")}</div>
          {/* ONE line of formats, at decoration weight. It replaced two
              sentences that said the same thing twice at reading size. */}
          <div className="text-2xs text-ink3">{t("drop.formats")}</div>
          <Button
            icon="upload"
            className="mt-2"
            onClick={(e) => {
              e.stopPropagation();
              fileRef.current?.click();
            }}
          >
            {t("drop.browse")}
          </Button>
          {input}
        </div>
        {sampleRow}
        {anchorAside}
        {metaBlock}
        <FailedIngests />
      </div>
    );
  }

  /* ---------------------------------------------------------- files in hand */
  return (
    <div>
      {/* The strip. Everything explanatory is gone from it — the queue below
          is the subject now, and the drop target only has to stay reachable
          for the next file. */}
      <div
        {...dropProps}
        className={`border-y py-3 transition-colors cursor-pointer flex items-center gap-x-4 ${
          drag ? "border-accent bg-accent-soft" : "border-t-line border-b-hair hover:bg-hover"
        }`}
      >
        <Icon name="upload" size={13} className="text-ink4 shrink-0" />
        <span className="text-base font-medium text-ink min-w-0 truncate">{t("drop.title")}</span>
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
        {input}
      </div>

      {metaBlock}

      <div className="mt-6">
        {anchorAside}
        <IngestQueue />
        {/* The failures the SERVICE remembers. They used to be pinned to the
            map, visible from everywhere, because the ingest panel could be
            shut over them. The panel is gone and the rail now carries the
            needs-you count from every mode, so this is their one home — and
            it is the screen the count sends you to. */}
        <FailedIngests />
        {sampleRow}
      </div>
    </div>
  );
}
