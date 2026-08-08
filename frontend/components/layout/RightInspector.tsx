"use client";
import { useFootageStore } from "@/store/useFootageStore";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Row, SectionHead, Pill } from "@/components/ui/primitives";
import Icon from "@/components/ui/Icon";
import EvidenceView, { EvidenceFrame } from "@/components/evidence/EvidenceView";
import { basisText, useT } from "@/lib/i18n";
import { formatArea } from "@/lib/analytics/area";
import { countOf } from "@/lib/analytics/count";
import { formatDate } from "@/lib/analytics/brush";
import { isPlaced } from "@/lib/analytics/surveys";
import { reviewStats } from "@/lib/analytics/review";
import { useReviewStore } from "@/store/useReviewStore";
import SortieNotes from "@/components/record/SortieNotes";
import SitePicker from "@/components/record/SitePicker";
import SurveyMetaEdit from "@/components/record/SurveyMetaEdit";
import EditHistory from "@/components/record/EditHistory";

export default function RightInspector({ compact }: { compact?: boolean }){
  const { t, tp, lang } = useT();
  const footages = useFootageStore(s=>s.footages);
  const selectedId = useFootageStore(s=>s.selectedId);
  const select = useFootageStore(s=>s.select);
  const retirement = useFootageStore(s=>s.retirement);
  const unretireFootage = useFootageStore(s=>s.unretireFootage);
  const openReview = useReviewStore(s=>s.openReview);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const f = useMemo(()=> footages.find(x=>x.id===selectedId) || null, [footages, selectedId]);

  /* Copy-to-clipboard outcome, shown for ~1.5s. It is not cosmetic: the
     documented deployment is a FastAPI container on a plain-http LAN, where
     `navigator.clipboard` does not exist at all, and the old handler threw
     into the void and looked exactly like a success. */
  const [copyState, setCopyState] = useState<null | "ok" | "fail">(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  const flashCopy = (ok: boolean) => {
    setCopyState(ok ? "ok" : "fail");
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopyState(null), 1500);
  };

  /* A selection change swaps the sortie under the dialog; showing sortie B's
     photo in a dialog opened for sortie A would be quiet misinformation. */
  useEffect(() => { setEvidenceOpen(false); }, [selectedId]);

  const shell = `w-[340px] ${compact ? "flex-1" : "shrink-0 border-l border-line"} bg-surface flex flex-col overflow-hidden`;

  if (!f) {
    return (
      <div className={shell}>
        <div className="flex-1 grid place-items-center p-8 text-center">
          <div className="max-w-[220px]">
            <Icon name="target" size={20} className="text-ink3 mx-auto" />
            <p className="text-sm text-ink2 mt-3 leading-relaxed">
              {t("insp.selectHint")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  /* Only for the legacy bbox placeholder below, and only a surviving
     detection: a box drawn round something a reviewer already rejected is
     not evidence of anything. This is one animal out of the sortie's many and
     nothing else may read it as the sortie's own verdict — two pills under
     the count did exactly that until this change. */
  const det = f.detections.find(d => d.status !== "false_positive") || null;
  /* The Evidence view exists only where its raw material does: a photo
     sortie whose engine run left us the media id and per-animal pixels.
     Everything here is optional on Footage - guard all of it, or the
     inspector goes down with the whole app (it already did once). */
  const evidence =
    !f.videoUrl && f.mediaId && f.pixels && f.pixels.length > 0
      ? { mediaId: f.mediaId, pixels: f.pixels }
      : null;
  /* With the real engine a sortie holds one detection PER ANIMAL, so the
     headline is the band's best estimate; summing the SURVIVING detections is
     the fallback for test data, which never carries a band. countOf() is that
     rule, shared with the panel, the report and the CSV — the fallback here
     used to include detections a reviewer had already rejected. */
  const totalSeals = countOf(f);
  const low = f.band?.low ?? null;
  const best = f.band?.best ?? null;
  const high = f.band?.high ?? null;
  const hasRange = low != null && high != null && low !== high;
  /* The service serves runs whose lead number sits outside its own bounds
     (it emits a `band is incoherent` caveat for exactly this, and rows
     predating the engine fix are still in the database). Deriving the state
     from the numbers rather than from that English sentence keeps this
     honest in all three languages and if the wording ever changes. */
  const bandBroken = hasRange && best != null && (best < low || best > high);
  /* Fraction of the strip the best estimate sits at, in the 6–94% the track
     actually occupies. Clamped: the arithmetic is only inside those bounds
     while low ≤ best ≤ high, and an out-of-band best used to place an
     absolutely-positioned marker off the end of its own track. */
  const markerLeft =
    hasRange && best != null && !bandBroken
      ? Math.min(94, Math.max(6, 6 + 88 * ((best - low) / Math.max(1, high - low))))
      : null;
  /* How much of this count a human has actually signed off on — from the one
     shared helper, so this row, the list row and the dashboard's verification
     share cannot each answer the question differently. Animals with no
     reviewable row (a video's unplaced ones, the aggregate marker) are counted
     as NOT REVIEWABLE rather than folded into the denominator: "0 of 562
     verified" over rows nobody can rule on reads as neglect, not as a
     structural limit of this build. */
  const review = reviewStats(f);
  /* A count a person made rather than the engine. Labelled, never dressed up
     with a range it does not have. */
  const isManual = f.engine === "manual";
  const retired = f.retiredAt ?? null;
  const retiredNote = retirement[f.id] ?? null;
  /* "On map" means animals, so it counts animals. `detections.length` is the
     rows the endpoint returned, and those now include the ones a reviewer
     rejected — printing that as the number on the map would silently put
     them back into the count. Rejections are stated, not disappeared. */
  const placed = f.detections.filter(d => d.status !== "false_positive").length;
  const rejected = f.detections.length - placed;
  const provenance = [
    f.band ? t("insp.onMap", { n: placed }) : null,
    f.band && f.unplaced ? t("insp.withoutCoords", { n: f.unplaced }) : null,
    rejected > 0 ? t("insp.rejected", { n: rejected }) : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className={shell}>
      {/* A retired sortie says so before it says anything else: every number
          below it is still true and none of it is in the season's estimate. */}
      {retired && (
        <div className="px-4 py-2.5 border-b border-line bg-surface2">
          <div className="flex items-baseline gap-2">
            <Icon name="alert" size={12} className="text-accent shrink-0" />
            <span className="text-xs text-ink2 flex-1">
              {t("rec.retire.banner", { when: formatDate(retired, lang) })}
            </span>
            <button
              onClick={()=> void unretireFootage(f.id)}
              className="text-2xs text-ink3 hover:text-ink transition-colors shrink-0"
            >
              {t("rec.retire.undo")}
            </button>
          </div>
          <div className="text-2xs text-ink3 mt-1 leading-relaxed break-words">
            {/* Rendered as text, never as markup — the reason is something an
                operator typed. A reason the archive never recorded is left
                unsaid rather than filled in. */}
            {retiredNote?.reason ? t("rec.retire.reasonIs", { reason: retiredNote.reason }) : null}
            {retiredNote?.reason && retiredNote?.by ? " · " : null}
            {retiredNote?.by ? t("rec.retire.byWho", { who: retiredNote.by }) : null}
          </div>
        </div>
      )}

      {/* The count is the answer this product exists to give — so it leads. */}
      <div className="px-4 pt-4 pb-3.5 border-b border-line">
        {f.status === "error" ? (
          <div>
            <div className="text-sm text-bad font-medium">{t("insp.countFailed")}</div>
            <div className="text-2xs text-ink3 mt-1 break-words">{f.error}</div>
          </div>
        ) : f.status === "processing" ? (
          <div className="flex items-baseline gap-2">
            <span className="text-hero tnum font-medium leading-none text-ink3 animate-pulse">…</span>
            <span className="text-sm text-ink2">{t("insp.counting")}</span>
          </div>
        ) : (
          <div className="flex items-baseline gap-2">
            <span className="text-hero tnum font-medium leading-none">{totalSeals}</span>
            <span className="text-sm text-ink2">{tp(totalSeals, "insp.sealsCounted")}</span>
          </div>
        )}

        {/* The range is not decoration: frames of the same colony disagree,
            and a single integer would be false precision. Test data has no
            band, so this strip only appears over a real count. */}
        {hasRange && (
          <div className="mt-3">
            <div className="relative h-1.5 rounded-full bg-surface2">
              <div className={`absolute inset-y-0 rounded-full ${bandBroken ? "bg-line" : "bg-accent-soft"}`}
                   style={{ left: "6%", right: "6%" }} />
              {/* No marker on a band the service has already called
                  indefensible. A precise indicator over broken bounds is a
                  drawing of a measurement that does not exist. */}
              {markerLeft != null && (
                <div className="absolute top-1/2 -translate-y-1/2 h-3 w-0.5 rounded bg-accent"
                     style={{ left: `${markerLeft}%` }} />
              )}
            </div>
            <div className="flex justify-between mt-1 text-2xs tnum text-ink3">
              <span>{low}</span>
              {bandBroken ? (
                <span className="text-bad" title={t("insp.bandUnusableWhy")}>
                  {t("insp.bandUnusable")}
                </span>
              ) : (
                <span className="text-ink2">{t("insp.rangeBetweenFrames")}</span>
              )}
              <span>{high}</span>
            </div>
          </div>
        )}

        <div className="flex items-center flex-wrap gap-2 mt-2.5">
          {f.source==="test" && <Pill tone="accent">{t("pill.testData")}</Pill>}
          {/* No confidence pill. The detector's score is an uncalibrated model
              output; printing it as "NN% confidence" dressed it up as a
              probability the number cannot support. The band is the honest
              uncertainty, and it is already above. */}
          {/* No per-detection verdict pill either. It read `detections[0]` and
              printed one arbitrary animal's status as the whole sortie's — a
              sortie carries one detection per animal, so the label flipped
              with array order. The reviewed share is the honest figure and it
              is already computed and shown in the Review row below. */}
          {/* A manual basis is not an engine basis and must not look like one:
              the accent pill says a person produced this number, and the line
              under it says what that costs — no cross-frame range. */}
          {isManual
            ? <Pill tone="accent">{t("rec.manual.pill")}</Pill>
            : f.band?.basis && <Pill tone="neutral">{basisText(lang, f.band.basis)}</Pill>}
          {retired && <Pill tone="neutral">{t("rec.retire.pill")}</Pill>}
          {provenance && <span className="text-2xs text-ink3">{provenance}</span>}
        </div>
        {isManual && (
          <p className="text-2xs text-ink3 mt-1.5 leading-relaxed">{t("rec.manual.noBand")}</p>
        )}
      </div>

      {/* frame preview: the real photo with every animal marked when the
          engine gave us one; the video player for video; the placeholder
          only where there is genuinely nothing to show. */}
      <div className="aspect-video bg-bg border-b border-line relative shrink-0">
        {f.videoUrl ? (
          <video src={f.videoUrl} controls className="w-full h-full object-contain" />
        ) : evidence ? (
          <>
            {/* Not while the dialog is up: the two frames are the same
                original, so both <img> elements decode the full-resolution
                still and both overlays stay mounted behind an opaque
                dialog nobody can see through. */}
            {!evidenceOpen && (
              <EvidenceFrame mediaId={evidence.mediaId} pixels={evidence.pixels} />
            )}
            <Button
              icon="search"
              className="absolute bottom-2 right-2 shadow-pop"
              onClick={() => setEvidenceOpen(true)}
            >
              {t("insp.openEvidence")}
            </Button>
          </>
        ) : (
          <FramePreview filename={f.filename} count={totalSeals} det={det} />
        )}
      </div>

      {evidence && (
        <EvidenceView
          open={evidenceOpen}
          onOpenChange={setEvidenceOpen}
          mediaId={evidence.mediaId}
          pixels={evidence.pixels}
          band={f.band ?? null}
        />
      )}

      <div className="flex-1 overflow-auto">
        {/* The engine's own reasons not to trust its band, first - before the
            filename, before anything. They are English sentences straight from
            the run's quality ledger and are rendered verbatim: they are the
            evidence, and paraphrasing evidence is how a floor becomes a
            measurement. Absent (not empty) means the service never reported
            them, and silence is the only honest rendering of that. */}
        {f.caveats && (
          <div className="px-4 py-3 border-b border-line">
            <SectionHead title={t("sec.caveats")} className="mb-1.5" />
            {f.caveats.length ? (
              f.caveats.map((c, i) => (
                <div key={i} className="flex items-start gap-1.5 py-1 border-b border-line-soft last:border-0">
                  <Icon name="alert" size={12} className="text-accent shrink-0 mt-[3px]" />
                  <span className="text-xs text-ink2 leading-relaxed break-words">{c}</span>
                </div>
              ))
            ) : (
              <div className="text-xs text-ink3 py-1">{t("insp.noCaveats")}</div>
            )}
          </div>
        )}

        <div className="px-4 py-3">
          <SectionHead title={t("sec.sortie")} className="mb-1" />
          {/* A ground count has no file to name. Printing "(archived survey)"
              over a number a person reported would invent footage. */}
          {isManual
            ? <Row label={t("row.file")} value={t("rec.manual.title")} />
            : <Row label={t("row.file")} value={f.filename} mono />}
          {/* The DATE, said as what it is. `uploadedAt` falls back to the
              count job's clock so the timeline always has something to sort
              on; printing that fallback under "flown on" turns a processing
              timestamp into a field observation, so the two are separate rows
              and the fallback carries its caveat. */}
          {f.capturedAt ? (
            <Row label={t("rec.date.captured")} value={formatDate(f.capturedAt, lang)} mono />
          ) : (
            <Row
              label={t("rec.date.counted")}
              value={
                <span className="inline-flex items-baseline gap-1.5 min-w-0">
                  <span className="font-mono tnum">{formatDate(f.uploadedAt, lang)}</span>
                  <span className="text-2xs text-ink3 truncate" title={t("rec.date.notRecorded")}>
                    {t("rec.date.notRecorded")}
                  </span>
                </span>
              }
            />
          )}
          <SitePicker f={f} />
          {/* A still has no duration; "0s" read as a broken video rather than
              as a photo. Region is gone for a harder reason: "KZ-East" was a
              latitude threshold wearing a toponym's clothes. Coordinates are
              the measured thing, so coordinates are what is shown. */}
          {f.duration > 0 && <Row label={t("row.duration")} value={`${f.duration}${t("unit.s")}`} mono />}
          <Row label={t("row.source")} value={f.source} />
          {f.track.length > 0 && (
            <Row label={t("row.track")} value={`${f.track.length} ${tp(f.track.length, "misc.trackPoints")}`} mono />
          )}
          {/* A sortie with no track and no georeferenced animal has no centre.
              Its stored centre is NaN precisely so that nothing prints it as a
              position; four decimal places of NaN is a fabricated measurement.
              Where there IS a position, its PROVENANCE rides with it: four
              decimals is ~10 m, which a coordinate somebody clicked on a map
              cannot support, so a pinned or typed one prints at three. */}
          <Row
            label={t("row.location")}
            value={
              isPlaced(f) ? (
                <span className="inline-flex items-baseline gap-1.5 min-w-0">
                  <span className="font-mono tnum">
                    {f.center.lat.toFixed(locPrecision(f.locationSource))},{" "}
                    {f.center.lng.toFixed(locPrecision(f.locationSource))}
                  </span>
                  {f.locationSource && (
                    <span className="text-2xs text-ink3 truncate" title={locText(t, f.locationSource)}>
                      {locText(t, f.locationSource)}
                    </span>
                  )}
                </span>
              ) : (
                t("misc.notPlaced")
              )
            }
          />
          {(f.areaM2 != null || f.gsdSource) && (
            <Row
              label={t("row.footprint")}
              value={
                <span className="inline-flex items-baseline gap-1.5">
                  {/* Hectares, formatted by the same shared helper the
                      dashboard total uses - one unit for one quantity across
                      the product. */}
                  <span className="font-mono tnum">
                    {f.areaM2 != null ? `${formatArea(f.areaM2, lang)} ${t("unit.ha")}` : "—"}
                  </span>
                  {/* title: the source token is what says whether this area was
                      measured or guessed, and the row is narrow enough to clip
                      it mid-word ("assumed_nativ…"). It stays readable on hover
                      rather than only in the export. */}
                  {f.gsdSource && (
                    <span className="text-2xs text-ink3 truncate" title={gsdNote(f.gsdCmPx, f.gsdSource)}>
                      {gsdNote(f.gsdCmPx, f.gsdSource)}
                    </span>
                  )}
                </span>
              }
            />
          )}
          {/* Three numbers, not a percentage on its own: verified, still to
              review, and the animals this build has no reviewable row for.
              `pct === null` means there is nothing to review at all, which is
              a different statement from "0% reviewed" and is printed as one. */}
          <Row
            label={t("row.review")}
            value={
              review.reviewable === 0 ? (
                <span className="text-ink3">{t("rec.review.nothing")}</span>
              ) : (
                <span className="tnum text-2xs">
                  {t("rec.review.value", {
                    v: review.verified,
                    r: review.reviewable - review.verified,
                    u: review.unreviewable,
                  })}
                </span>
              )
            }
          />
        </div>

        {review.reviewable > review.verified && f.runId && (
          <div className="px-4 pb-3">
            <Button icon="check" full onClick={()=> openReview(f.runId)}>
              {t("rec.review.open")}
            </Button>
          </div>
        )}

        {/* ------------------------------------------------------- the record
            What a person knows and the engine cannot derive. Below the
            measured figures, because it annotates them rather than competing
            with them, and above the exports, because a report should carry
            what was just written down. */}
        <SortieNotes f={f} />
        <SurveyMetaEdit f={f} />
        <EditHistory f={f} />

        <div className="px-4 pb-4 flex gap-1.5">
          {/* Per-animal exports, not a dump of this component's state. The old
              "Export JSON" handed over the store object - internal shape, no
              schema, useless to QGIS or a spreadsheet. */}
          <Button
            icon="download"
            full
            onClick={async ()=>{
              const m = await import("@/lib/export/animals");
              m.exportAnimalsGeoJSON([f]);
            }}
          >
            GeoJSON
          </Button>
          <Button
            icon="download"
            full
            onClick={async ()=>{
              const m = await import("@/lib/export/animals");
              m.exportAnimalsCSV([f]);
            }}
          >
            CSV
          </Button>
          <Button
            icon={copyState === "ok" ? "check" : copyState === "fail" ? "alert" : "copy"}
            /* Disabled where there is no coordinate: the old handler happily
               put "NaN,NaN" on the clipboard, which pastes into a field
               notebook as a measurement. */
            disabled={!isPlaced(f)}
            title={
              copyState === "ok" ? t("insp.copied")
              : copyState === "fail" ? t("insp.copyFailed")
              : t("btn.copyCoords")
            }
            onClick={async () => {
              flashCopy(await copyText(`${f.center.lat},${f.center.lng}`));
            }}
          >
            {copyState === "ok" ? t("insp.copied") : copyState === "fail" ? t("insp.copyFailed") : undefined}
          </Button>
          {/* The icon swap is for the operator; this is for a screen reader,
              which otherwise gets no signal that anything happened. */}
          <span className="sr-only" role="status" aria-live="polite">
            {copyState === "ok" ? t("insp.copied") : copyState === "fail" ? t("insp.copyFailed") : ""}
          </span>
        </div>
      </div>
    </div>
  );
}

/* Copy that works where this product actually runs. The async Clipboard API
   is only defined in a secure context, and the documented field deployment is
   the FastAPI container serving this export over plain http on a LAN - there,
   `navigator.clipboard` is undefined and the old one-liner threw an unhandled
   rejection while looking exactly like a success. Returns whether the text
   really reached the clipboard, so the button can say so. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* Permission denied or a non-secure origin - try the legacy path. */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    /* Off-screen but focusable: `display:none` cannot be selected. */
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/* Where a coordinate came from, and how many digits it can carry.
 *
 * A telemetry fix and a click on a map are both "the location", and the app
 * printed both to four decimals — ~10 m, a precision a hand-placed pin does
 * not have. So a pinned or typed position prints to three, and every position
 * states its provenance next to itself.
 *
 * An unrecognised token is printed as the service wrote it rather than mapped
 * to a friendly guess: a location provenance this build does not know is
 * exactly the thing a reader must be able to see. */
function locPrecision(source: string | null | undefined): number {
  return source === "measured" || source === "telemetry" || source == null ? 4 : 3;
}

function locText(t: (k: any, v?: any) => string, source: string): string {
  switch (source) {
    case "measured":
    case "telemetry":
      return t("rec.loc.measured");
    case "pin":
    case "pinned":
      return t("rec.loc.pinned");
    case "manual":
    case "entered":
      return t("rec.loc.manual");
    default:
      return source;
  }
}

/* Scale and where it came from. `gsd_source` stays a machine word (optics,
   assumed_native_width, unknown) - the same token the service and the exports
   use, and an assumed scale written out as prose would read like a measured
   one. With no GSD there is no area, so the source is shown alone: it says why
   the footprint is a dash. */
function gsdNote(gsd: number | null | undefined, source: string): string {
  return gsd ? `GSD: ${gsd.toFixed(1)} cm/px · ${source}` : `GSD: ${source}`;
}

function FramePreview({ filename, count, det }: { filename:string; count:number; det:any }){
  return (
    <div className="w-full h-full relative bg-[#0d0f11] overflow-hidden grid place-items-center">
      <div
        className="absolute inset-0 opacity-60"
        style={{ background:"radial-gradient(ellipse at 35% 40%, #14202a 0%, transparent 65%)" }}
      />
      {/* bbox is optional and, since the real engine replaced the mock, usually
          absent: the counter returns a point per animal, not a box. The mock
          always supplied one, so the old code indexed it unguarded - which
          crashed the whole app the moment a real sortie was selected. */}
      {det && Array.isArray(det.bbox) && det.bbox.length === 4 && (
        <div
          className="absolute border border-accent rounded-[2px]"
          style={{ left: `${det.bbox[0]*100}%`, top: `${det.bbox[1]*100}%`, width: `${det.bbox[2]*100}%`, height: `${det.bbox[3]*100}%` }}
        >
          <span className="absolute -top-[15px] left-0 bg-accent text-accent-ink text-2xs font-medium px-1 rounded-sm leading-[14px] tnum">
            {count}
          </span>
        </div>
      )}
      <span className="absolute bottom-2 left-2.5 text-2xs font-mono text-ink3 truncate max-w-[80%]">{filename}</span>
    </div>
  );
}
