"use client";
/**
 * IngestQueue — the ingest store, rendered.
 *
 * One row per dropped file, and every row states what is actually happening to
 * that file right now: `uploading 42%` while the bytes are on the wire,
 * `counting frame 8/24` while the engine is looking at it, `queued (3 of 30)`
 * while it waits its turn. The panel this replaced printed one shared line —
 * "counting…" — from the instant before the upload even started, which was a
 * false statement about the machine for most of the minutes it was on screen.
 *
 * Rows that need a person (a duplicate, a missing location, a frame choice)
 * carry their own controls. There is no single shared "pending" slot, because
 * a single slot is how three photos dropped together became one row and two
 * silently discarded files.
 *
 * The list no longer scrolls inside itself. It sits in the Загрузка screen's
 * own column, and that screen scrolls: a 46vh window inside a panel meant a
 * queue of thirty files was read four rows at a time, with the card asking for
 * a decision as likely as not just below the fold of a box inside a box.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  useIngestStore,
  isRunning,
  type IngestItem,
  type FailedJob,
} from "@/store/useIngestStore";
import { useFootageStore } from "@/store/useFootageStore";
import FramePicker from "@/components/upload/FramePicker";
import ScanStage, { hasScanStage } from "@/components/upload/ScanStage";
import Icon from "@/components/ui/Icon";
import { Button } from "@/components/ui/primitives";
import { setMode } from "@/lib/modes";
import { stageText, useT } from "@/lib/i18n";

/* Files whose arrival has already sent the operator to the map once. Outside
   the component on purpose: a row unmounts every time Загрузка is left, and
   the point of the record is to survive exactly that. Ids only, and an ingest
   id is never reused, so this stays small and cannot mis-fire on a later
   file. */
const autoShown = new Set<string>();

const KB = 1024;
function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < KB) return `${n} B`;
  if (n < KB * KB) return `${Math.round(n / KB)} KB`;
  return `${(n / (KB * KB)).toFixed(n < 10 * KB * KB ? 1 : 0)} MB`;
}

/** A thin honest bar. No indeterminate animation: a bar that moves without a
 *  measurement is decoration pretending to be information.
 *
 *  Two hairlines thick, on the hairline grey, filled in the signal colour —
 *  it only ever runs while something genuinely is. At this weight it reads as
 *  a scale mark under the filename rather than as a progress widget. */
function Bar({ value }: { value: number | null }) {
  if (value === null) return null;
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div className="h-[2px] bg-hair overflow-hidden mt-1.5">
      <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
    </div>
  );
}

function Details({ text, label }: { text: string; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-2xs text-ink3 hover:text-ink underline underline-offset-2"
      >
        {label}
      </button>
      {open && (
        /* The raw service text — a full ffprobe argv, a stack line. It belongs
           behind a disclosure, never in a toast that scrolls past. Held by one
           rule down its left edge: a quoted machine voice, not a grey box. */
        <pre className="mt-1 text-2xs text-ink3 border-l border-line pl-2 max-h-28 overflow-auto whitespace-pre-wrap break-all">
          {text}
        </pre>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ a row */

function Row({ item, queuePos, queueTotal }: { item: IngestItem; queuePos: number; queueTotal: number }) {
  const { t, tp, lang } = useT();
  /* Selected field by field, not as one `useIngestStore()` call: the whole
     state changes on every byte of upload progress, and a row that subscribes
     to all of it re-renders thirty times a second for a file that is not
     even its own. */
  const pinTarget = useIngestStore((s) => s.pinTarget);
  const claimPin = useIngestStore((s) => s.claimPin);
  const applyPin = useIngestStore((s) => s.applyPin);
  const dismiss = useIngestStore((s) => s.dismiss);
  const cancel = useIngestStore((s) => s.cancel);
  const retry = useIngestStore((s) => s.retry);
  const wantFrames = useIngestStore((s) => s.wantFrames);
  const openDuplicate = useIngestStore((s) => s.openDuplicate);
  const countAgain = useIngestStore((s) => s.countAgain);
  const pinMode = useFootageStore((s) => s.pinMode);
  const pinPoints = useFootageStore((s) => s.pinPoints);
  const setPinMode = useFootageStore((s) => s.setPinMode);
  const setPinPoints = useFootageStore((s) => s.setPinPoints);

  /* A card that needs a person scrolls itself into view: on a screen this
     long the frame picker or the pin controls otherwise appear below the fold
     and the file just looks stuck. */
  const cardRef = useRef<HTMLDivElement>(null);
  const needsYou =
    item.phase === "needs_location" || item.phase === "duplicate_choice" || item.phase === "frame_choice";
  useEffect(() => {
    if (needsYou) cardRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [needsYou]);

  /* Arm the pin the moment a location-less file needs one — the gesture users
     learned before the queue existed was drop-then-click-the-map, and without
     this the map click silently did nothing until the button was found. Only
     an UNOWNED pin is claimed (getState, not the subscribed value: two cards
     mounting together both see null and would both claim), so a second file
     still waits for an explicit hand-over; when the owner confirms or is
     dismissed the store frees the pin and this effect claims for the next. */
  useEffect(() => {
    if (item.phase !== "needs_location") return;
    if (useIngestStore.getState().pinTarget !== null) return;
    claimPin(item.id);
    setPinMode(true);
    setPinPoints([]);
    /* And, ONCE per file, go where the pinning is. The map is the only screen
       a point can be placed on, so asking for a location and staying on the
       queue costs the operator a mode switch they cannot have wanted.

       Once, though, and not every time this effect runs. Cancelling on the map
       frees the pin, and this row re-mounts and re-arms whenever Загрузка is
       opened — so an unconditional jump would answer "I do not want to place
       this now" by throwing the operator back at the map, and would keep the
       queue (its own × included) unreachable while any file lacked a location.
       A module-level set, not a ref: the ref dies with the unmounting row and
       would forget on the way back. */
    if (!autoShown.has(item.id)) {
      autoShown.add(item.id);
      setMode("map");
    }
  }, [item.phase, item.id, pinTarget, claimPin, setPinMode, setPinPoints]);

  const reason = item.reason ? t(item.reason.key, item.reason.vars) : null;

  const label = (() => {
    switch (item.phase) {
      case "queued":
        return queueTotal > 1 ? t("ingest.queuedOf", { n: queuePos, total: queueTotal }) : t("ingest.queued");
      case "reading":
        return t("ingest.reading");
      case "hashing":
        return t("ingest.hashing");
      case "uploading":
        return item.bytesTotal > 0 && item.bytesSent > 0
          ? t("ingest.uploadingPct", { pct: Math.round((item.bytesSent / item.bytesTotal) * 100) })
          : t("ingest.uploading");
      case "enqueued":
        return t("ingest.waitingEngine");
      case "counting":
        return item.frameTotal
          ? t("ingest.countingFrame", { done: item.frameDone ?? 0, total: item.frameTotal })
          : stageText(lang, item.stage);
      case "writing":
        return t("ingest.writing");
      case "done":
        return t("ingest.done");
      case "failed":
        return t("ingest.failed");
      case "cancelled":
        return t("ingest.cancelled");
      case "skipped":
        return t("ingest.skipped");
      case "duplicate_choice":
        return t("ingest.duplicate");
      case "needs_location":
        return t("ingest.needsLocation");
      case "frame_choice":
        return t("ingest.frameChoice");
    }
  })();

  const progress =
    item.phase === "uploading" && item.bytesTotal > 0
      ? item.bytesSent / item.bytesTotal
      : item.phase === "counting" && item.frameTotal
        ? (item.frameDone ?? 0) / item.frameTotal
        : null;

  /* Four registers, and only one of them is coloured for effect. Running is
     genuinely live, which is one of the two things this design spends the
     signal colour on. A failure is semantic red. A card waiting on a person is
     plain ink set in italic — it stands out by being the only italic on the
     screen, not by adding a third hue. Everything settled, DONE INCLUDED,
     steps back to grey: a finished ingest is history, and painting it green
     was the accent being spent on an event nobody has to act on. */
  const toneColor =
    item.phase === "failed"
      ? "text-bad"
      : needsYou
        ? "text-ink"
        : isRunning(item.phase)
          ? "text-accent"
          : "text-ink3";
  const tone = needsYou ? `${toneColor} italic` : toneColor;

  const owningPin = pinTarget === item.id;

  return (
    /* No card. A hairline above each row and the shared left edge below the
       icon are the whole structure — which is also why the row can now afford
       a filename at reading size. The vertical rhythm is a screen's, not a
       panel's: a row that is asking a question needs air around the question. */
    <div ref={cardRef} className="border-t border-hair first:border-t-0 py-3.5">
      <div className="flex items-start gap-2">
        <Icon
          name={
            item.phase === "failed" || item.phase === "skipped"
              ? "alert"
              : item.phase === "done"
                ? "check"
                : item.phase === "needs_location"
                  ? "pin"
                  : "upload"
          }
          size={13}
          className={`${toneColor} mt-0.5 shrink-0`}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            {/* The REAL filename. The old grouping keyed on a lowercased stem
                and printed that, so DJI_0001.MP4 was reported as "dji_0001".
                Inter with tabular figures, not a typewriter face: a filename is
                read, not compared character by character. */}
            <span className="flex-1 min-w-0 text-base font-medium text-ink truncate" title={item.fileName}>
              {item.fileName}
            </span>
            {/* The state, where the instrument keeps states: at the far end of
                the line it belongs to. Capped at just over half the row and
                allowed to wrap, so "waiting for the counting engine" in three
                languages cannot squeeze the filename down to an ellipsis.
                Tabular figures, because this line counts: `uploading 9%` →
                `uploading 10%` and `frame 9/24` → `frame 10/24` change width
                on proportional digits, and a right-aligned label that changes
                width several times a second drags the truncation point of the
                filename beside it back and forth. Only the numerals are
                touched — `tnum` would also retune the letter-spacing of a
                string that is mostly words. */}
            <span className={`shrink-0 max-w-[56%] text-right text-xs tabular-nums ${tone}`}>{label}</span>
          </div>
          {/* While a file is under the engine it is shown, being scanned, at a
              size a person can actually look at — and the stage carries its own
              hairline, so the row's bar stands down rather than running a
              second copy of the same fraction a centimetre away. */}
          <ScanStage item={item} />
          {!hasScanStage(item) && <Bar value={progress} />}
          {/* The honest numbers, in one quiet row. They are facts, so they sit
              at the readable floor rather than on the decoration step. */}
          <div className="flex flex-wrap items-baseline gap-x-3 text-2xs text-ink3 tnum mt-1.5">
            <span>{humanBytes(item.bytes)}</span>
            {item.quickCount && (
              <span>
                {t("ingest.quickFrom", { name: item.quickCount.fromVideo, s: item.quickCount.atSeconds })}
              </span>
            )}
          </div>
          {item.note && item.phase !== "skipped" && (
            <div className="text-2xs text-ink3 mt-1 leading-relaxed">{item.note}</div>
          )}
          {reason && <div className="text-2xs text-ink2 mt-1 leading-relaxed">{reason}</div>}
          {item.result && (
            <div className="text-2xs text-ink2 mt-1 tnum">
              {item.result.best ?? "?"} {tp(item.result.best ?? 0, "unit.seals")}
              {item.result.low != null && item.result.high != null && item.result.low !== item.result.high
                ? ` (${t("misc.range", { low: item.result.low, high: item.result.high })})`
                : ""}
              {item.result.unplaced ? ` · ${t("insp.withoutCoords", { n: item.result.unplaced })}` : ""}
            </div>
          )}
          {item.detail && <Details text={item.detail} label={t("ingest.details")} />}

          {/* ---------------------------------------------- the duplicate */}
          {item.phase === "duplicate_choice" && item.duplicateOf && (
            <div className="mt-1.5">
              <div className="text-2xs text-ink2 leading-relaxed">
                {t("ingest.dupSeen", {
                  date: item.duplicateOf.created_at
                    ? new Date(item.duplicateOf.created_at.replace(" ", "T")).toLocaleDateString()
                    : t("ingest.dupUnknownDate"),
                  name: item.duplicateOf.filename ?? item.duplicateOf.media_id,
                })}
              </div>
              <div className="text-2xs text-ink3 mt-0.5 leading-relaxed">
                {item.duplicateAfterUpload ? t("ingest.dupAfterUpload") : t("ingest.dupBeforeUpload")}
              </div>
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                <Button variant="primary" onClick={() => void openDuplicate(item.id)}>
                  {t("ingest.dupOpen")}
                </Button>
                <Button onClick={() => countAgain(item.id)}>
                  {item.duplicateAfterUpload ? t("ingest.dupCountSeparate") : t("ingest.dupCountAgain")}
                </Button>
                <Button variant="ghost" onClick={() => dismiss(item.id)}>
                  {t("btn.cancel")}
                </Button>
              </div>
            </div>
          )}

          {/* ------------------------------------------- the missing anchor */}
          {item.phase === "needs_location" && (
            <div className="mt-2">
              {item.anchor && (
                <div className="text-2xs text-ink2 tnum">
                  {t("ingest.anchorAt", { lat: item.anchor.lat.toFixed(3), lng: item.anchor.lng.toFixed(3) })}
                </div>
              )}
              {/* The map is its own screen now, so the gesture spans two of
                  them: this says so in one sentence rather than leaving a
                  person clicking an ingest screen that has no map on it. The
                  armed pin, the point and this row all survive the trip. */}
              <div className="text-2xs text-ink3 mt-1 leading-relaxed">{t("ingest.pinOnMap")}</div>
              <div className="flex flex-wrap gap-1.5 mt-2">
                <Button
                  variant={owningPin ? "primary" : "default"}
                  icon="pin"
                  /* Arms the pin AND takes you to where the pin is placed.
                     Pressing "point at it on the map" and staying on a screen
                     without a map was the whole complaint. */
                  onClick={() => {
                    claimPin(item.id);
                    setPinMode(true);
                    setPinPoints([]);
                    setMode("map");
                  }}
                >
                  {owningPin ? t("ingest.pinning") : t("ingest.pinThis")}
                </Button>
                {/* Confirm is required on the image path exactly as on the
                    video path: the old image branch consumed whatever anchor
                    happened to be armed, with no confirmation, and published a
                    coordinate the photo had no relationship to. */}
                {/* Same action the map card's Confirm runs — `applyPin` is the
                    single definition of what confirming a pin does, so the two
                    buttons cannot come to mean different things. */}
                <Button
                  variant="primary"
                  disabled={!owningPin || !pinMode || pinPoints.length < 1}
                  onClick={() => { applyPin(); }}
                >
                  {t("btn.confirm")}
                </Button>
                <Button variant="ghost" onClick={() => dismiss(item.id)}>
                  {t("a11y.dismiss")}
                </Button>
              </div>
            </div>
          )}

          {/* ------------------------------------------------ frame picker */}
          {item.phase === "frame_choice" && <FramePicker item={item} />}

          {/* --------------------------------------------------- the rest */}
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {item.phase === "queued" && item.kind === "video" && (
              <Button icon="layers" onClick={() => void wantFrames(item.id)}>
                {t("ingest.pickFrame")}
              </Button>
            )}
            {(isRunning(item.phase) || item.phase === "queued") && (
              <Button variant="ghost" onClick={() => cancel(item.id)}>
                {t("btn.cancel")}
              </Button>
            )}
            {item.phase === "failed" && (
              <Button icon="download" onClick={() => retry(item.id)}>
                {item.mediaId ? t("ingest.retryCount") : t("ingest.retryUpload")}
              </Button>
            )}
            {/* `frame_choice` is in this list because the picker is now the
                ONLY way a clip is counted: when the browser cannot draw a
                frame from it there is nothing to choose, and without a way out
                the row would sit in the panel forever. It is not running and
                not queued, so the cancel above never covered it. */}
            {(item.phase === "failed" ||
              item.phase === "skipped" ||
              item.phase === "cancelled" ||
              item.phase === "done" ||
              item.phase === "frame_choice") && (
              <Button variant="ghost" onClick={() => dismiss(item.id)}>
                {t("a11y.dismiss")}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- failed ingests */

function FailedJobRow({ job }: { job: FailedJob }) {
  const { t } = useT();
  const retryJob = useIngestStore((s) => s.retryJob);
  const dismissJob = useIngestStore((s) => s.dismissJob);
  return (
    <div className="border-t border-hair first:border-t-0 py-2">
      <div className="flex items-start gap-2">
        <Icon name="alert" size={13} className="text-bad mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-base font-medium text-ink truncate" title={job.filename ?? job.job_id}>
            {job.filename ?? job.job_id}
          </div>
          <div className="text-2xs text-ink3 tnum mt-0.5">
            {job.state === "retrying" ? t("ingest.retrying") : t("ingest.jobFailed")}
            {job.created_at ? ` · ${new Date(job.created_at.replace(" ", "T")).toLocaleString()}` : ""}
          </div>
          {job.error && <Details text={job.error} label={t("ingest.details")} />}
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {/* The media row survives a job-stage failure, so the retry creates
                a job against it. The file is never uploaded twice. */}
            <Button
              icon="download"
              disabled={job.state === "retrying" || !job.media_id}
              onClick={() => void retryJob(job.job_id)}
            >
              {t("ingest.retryCount")}
            </Button>
            <Button variant="ghost" onClick={() => dismissJob(job.job_id)}>
              {t("a11y.dismiss")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The failed ingests the SERVICE remembers. A job-stage failure writes no run
 *  row, hydrate() rebuilds only from the runs, and so every failure used to
 *  disappear on F5 with no trace any screen could reach. It lives on the
 *  Загрузка screen now — reachable from anywhere, because the rail carries the
 *  needs-you count in every mode and sends you here. Renders nothing when this
 *  client cannot list them — an empty "failed ingests" section reads as
 *  "nothing failed", which would be a claim rather than an absence. */
export function FailedIngests({ compact = false }: { compact?: boolean }) {
  const { t } = useT();
  const jobs = useIngestStore((s) => s.failedJobs);
  const supported = useIngestStore((s) => s.failedJobsSupported);
  if (!supported || jobs.length === 0) return null;
  return (
    <div className={compact ? "" : "pt-6"}>
      <div className="hd pb-1.5 border-b border-line">{t("ingest.failedSection", { n: jobs.length })}</div>
      {jobs.map((j) => (
        <FailedJobRow key={j.job_id} job={j} />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- the list */

export default function IngestQueue() {
  const { t } = useT();
  const items = useIngestStore((s) => s.items);
  const clearFinished = useIngestStore((s) => s.clearFinished);

  const queued = useMemo(() => items.filter((i) => i.phase === "queued"), [items]);
  const finished = useMemo(
    () => items.filter((i) => ["done", "skipped", "cancelled"].includes(i.phase)).length,
    [items],
  );

  /* The failed-ingest section is NOT rendered here — the screen mounts it
     below this list, once. Two copies of it a centimetre apart is just noise. */

  /* An empty queue renders NOTHING now. It used to state its own emptiness
     under its own rule — an honest line, but on an empty screen it stood next
     to the drop card saying the same thing twice, and two headings over two
     empty regions is most of what made this mode feel padded. The drop card
     owns the empty state; this list appears when there is a list. */
  if (!items.length) return null;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 pb-1.5 border-b border-line">
        <span className="hd">{t("ingest.listTitle", { n: items.length })}</span>
        {finished > 0 && (
          <button onClick={clearFinished} className="text-xs text-ink3 hover:text-ink">
            {t("ingest.clearFinished")}
          </button>
        )}
      </div>
      {/* No inner scroller: this list is as tall as it is and the screen
          scrolls. */}
      <div>
        {items.map((item) => (
          <Row
            key={item.id}
            item={item}
            queuePos={queued.findIndex((q) => q.id === item.id) + 1}
            queueTotal={queued.length}
          />
        ))}
      </div>
    </div>
  );
}
