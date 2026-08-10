"use client";
import { useFootageStore, envKeyOf } from "@/store/useFootageStore";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Row, SectionHead, Pill } from "@/components/ui/primitives";
import Icon from "@/components/ui/Icon";
import EvidenceView, { EvidenceFrame } from "@/components/evidence/EvidenceView";
import ReplayView from "@/components/replay/ReplayView";
import { basisText, useT, type I18nKey } from "@/lib/i18n";
import {
  compassOf, conditionsTime, dateIsRecorded, envUnitKey, envVarRank,
  formatEnvValue, iceClassKey, seasonOf,
} from "@/lib/analytics/season";
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
import {
  fetchSurveyCounts, fetchPurgePreview, REASON_MAX,
  type PurgeReceipt, type SurveyCount,
} from "@/lib/api";
import type { EnvSample, Footage } from "@/lib/types";

export default function RightInspector({ compact }: { compact?: boolean }){
  const { t, tp, lang } = useT();
  const footages = useFootageStore(s=>s.footages);
  const selectedId = useFootageStore(s=>s.selectedId);
  const select = useFootageStore(s=>s.select);
  const retirement = useFootageStore(s=>s.retirement);
  const corrections = useFootageStore(s=>s.corrections);
  const unretireFootage = useFootageStore(s=>s.unretireFootage);
  const correctFootageCount = useFootageStore(s=>s.correctFootageCount);
  const openReview = useReviewStore(s=>s.openReview);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  const f = useMemo(()=> footages.find(x=>x.id===selectedId) || null, [footages, selectedId]);

  /* Correcting the number. Open/closed, the draft, and what the last attempt
     said — held here rather than in the store because a half-typed value is
     not archive state, and the store must never hold a count nobody saved. */
  const [correctOpen, setCorrectOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [why, setWhy] = useState("");
  const [correctError, setCorrectError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /* A selection change swaps the sortie under an open form; a value typed for
     sortie A must never be one Enter away from landing on sortie B. */
  useEffect(() => {
    setCorrectOpen(false);
    setDraft("");
    setWhy("");
    setCorrectError(null);
  }, [selectedId]);

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
  useEffect(() => { setEvidenceOpen(false); setReplayOpen(false); }, [selectedId]);

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
  /* The replay needs marks to reveal and a frame to reveal them on: for a
     photo that is the media file, for a video run the reference frame the
     run id can name. A processing or failed sortie has neither number nor
     evidence to animate. */
  const replayable =
    f.status === "ready" &&
    !!f.pixels?.some(p => p.status !== "false_positive") &&
    !!(evidence || (f.runId && f.mediaId));
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
  /* A standing count a person corrected by hand, or null. Everything below
     reads this rather than inferring it from `basis`, because a corrected
     sortie and a shore count both store basis 'manual' and they are not the
     same thing: one has footage, animals and a review queue behind it. */
  const corrected = corrections[f.id] ?? null;
  /* Straight from the shared helper, on the sortie as it is. It used to be
     handed a doctored band here — basis swapped back to the engine's — because
     `isGroundCount` read 'manual' off a corrected drone sortie and reported
     "nothing to review" over animals that are all still there. That is fixed
     where it belonged, in `isGroundCount`, so this row, the list row and the
     dashboard's share now agree without a local patch that only this panel
     had. */
  const review = reviewStats(f);
  /* A count a person made rather than the engine. Labelled, never dressed up
     with a range it does not have. */
  const isManual = f.engine === "manual";
  /* Nothing to correct where the archive has no survey behind this row: test
     data and an upload that never reached the service live in this tab only. */
  const canCorrect = !!f.surveyId && f.status !== "processing" && f.status !== "error";
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
        /* The lamp is gone. An amber alert glyph in the one accent colour said
           "warning" in the same green the standing estimate is set in; the
           sentence already says what happened, and the quiet fill is enough to
           mark the block as a state rather than a fact. */
        <div className="px-4 py-2.5 border-b border-line bg-surface2">
          <div className="flex items-baseline gap-2">
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
          {/* The second step, and only ever the second. Withdrawing a sortie is
              reversible and takes a reason; this destroys it. Offering both at
              once would put "delete for ever" one click from a season's work,
              so the irreversible one lives inside the banner the reversible one
              raised. */}
          <PurgeControl f={f} />
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
          /* Counting right now, said in words and one colour — the same way the
             list row says it, and the way the reference marks a live state. The
             ellipsis used to pulse: a shimmer is a decorative lamp for an event
             a word already states, and it made the quiet placeholder the loudest
             thing on the panel. It holds the hero's height and nothing else. */
          <div className="flex items-baseline gap-2.5">
            <span className="text-hero tnum font-medium leading-none text-ink4">…</span>
            <span className="text-sm text-accent">{t("insp.counting")}</span>
          </div>
        ) : (
          <div className="flex items-baseline gap-2.5">
            {/* The standing count for this sortie — the one figure the signal
                colour exists for. A zero drops to the quiet step: "this survey
                found nothing" and "this survey found six hundred" must not
                arrive at the same volume. */}
            <span className={`text-hero tnum font-medium leading-none ${totalSeals>0 ? "text-accent" : "text-ink3"}`}>{totalSeals}</span>
            <span className="text-xs text-ink3 leading-tight">{tp(totalSeals, "insp.sealsCounted")}</span>
            <span className="flex-1" />
            {/* The count is the one number a reviewer cannot fix from the
                review queue: ruling on animals moves the verified share, not
                the engine's estimate. This is where a person who counted the
                frame themselves says so. */}
            {canCorrect && !correctOpen && (
              <button
                onClick={() => {
                  setDraft(String(totalSeals));
                  setWhy("");
                  setCorrectError(null);
                  setCorrectOpen(true);
                }}
                className="text-2xs text-ink3 hover:text-ink transition-colors shrink-0"
              >
                {t("rec.correct.action")}
              </button>
            )}
          </div>
        )}

        {correctOpen && (
          /* Held by the rule down its left edge, not by a filled panel: this is
             an action nested under the figure it changes, and the fields are
             ruled lines rather than boxes. */
          <div className="mt-3 space-y-2 border-l border-line pl-3">
            {/* Said before the field, not after it. What this does is replace
                the number the whole product reports for this sortie — and the
                sentence has to promise only what the archive actually does:
                the previous count is kept, not overwritten. */}
            <p className="text-2xs text-ink2 leading-relaxed">{t("rec.correct.explain")}</p>
            <label className="block">
              <span className="sr-only">{t("rec.correct.countLabel")}</span>
              <input
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                autoFocus
                value={draft}
                onChange={(e) => { setDraft(e.currentTarget.value); setCorrectError(null); }}
                aria-label={t("rec.correct.countLabel")}
                className="w-full bg-transparent border-b border-line px-0 py-1 text-lead tnum text-ink focus:border-ink2 transition-colors"
              />
            </label>
            <input
              type="text"
              value={why}
              /* The service caps this at REASON_MAX and refuses past it; the
                 input stops at the same number so a reason that types fine
                 cannot 400 behind a generic failure toast. */
              maxLength={REASON_MAX}
              onChange={(e) => setWhy(e.currentTarget.value)}
              placeholder={t("rec.correct.reasonPlaceholder")}
              aria-label={t("rec.correct.reasonLabel")}
              className="w-full bg-transparent border-b border-line px-0 py-1 text-xs text-ink placeholder:text-ink4 focus:border-ink2 transition-colors"
            />
            {correctError && <p className="text-2xs text-bad leading-relaxed">{correctError}</p>}
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                disabled={saving}
                onClick={async () => {
                  /* Parsed strictly. `Number("12abc")` is NaN and
                     `parseInt("12.7")` is 12 — one of those silently stores a
                     count nobody entered, which is the failure mode a counting
                     product can least afford. */
                  const n = Number(draft.trim());
                  if (!draft.trim() || !Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
                    setCorrectError(t("rec.correct.badCount"));
                    return;
                  }
                  setSaving(true);
                  const ok = await correctFootageCount(f.id, n, why);
                  setSaving(false);
                  if (ok) { setCorrectOpen(false); setWhy(""); }
                  else setCorrectError(t("rec.correct.failed"));
                }}
              >
                {saving ? t("rec.correct.saving") : t("rec.correct.save")}
              </Button>
              <button
                onClick={() => { setCorrectOpen(false); setCorrectError(null); }}
                className="text-2xs text-ink3 hover:text-ink transition-colors"
              >
                {t("btn.cancel")}
              </button>
            </div>
          </div>
        )}

        {/* The range is not decoration: frames of the same colony disagree,
            and a single integer would be false precision. Test data has no
            band, so this strip only appears over a real count. */}
        {hasRange && (
          /* A 2px rule and a tick, not a capsule meter. The span is the
              uncertainty and stays decoration — the two numbers under it are
              what a reader actually takes away — and the tick on the standing
              estimate is the only thing here allowed the signal colour. */
          <div className="mt-3.5">
            <div className="relative h-0.5 bg-hair">
              <div className={`absolute inset-y-0 ${bandBroken ? "bg-line" : "bg-ink4"}`}
                   style={{ left: "6%", right: "6%" }} />
              {/* No marker on a band the service has already called
                  indefensible. A precise indicator over broken bounds is a
                  drawing of a measurement that does not exist. */}
              {markerLeft != null && (
                <div className="absolute top-1/2 -translate-y-1/2 h-2.5 w-px bg-accent"
                     style={{ left: `${markerLeft}%` }} />
              )}
            </div>
            <div className="flex justify-between mt-1.5 text-2xs tnum text-ink3">
              <span>{low}</span>
              {bandBroken ? (
                <span className="text-bad" title={t("insp.bandUnusableWhy")}>
                  {t("insp.bandUnusable")}
                </span>
              ) : (
                <span className="text-ink3">{t("insp.rangeBetweenFrames")}</span>
              )}
              <span>{high}</span>
            </div>
          </div>
        )}

        {/* One line of quiet words joined by middots — the reference's marker
            line. It used to be a row of capsules, which gave a provenance note
            the same visual weight as the count above it, and a `gap` with three
            of five conditions false left unrelated words abutting with nothing
            saying they were a list. */}
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
            the italic marker says a person produced this number, and the line
            under it says what that costs — no cross-frame range. */}
        {/* A corrected number is a person's number, and the marker says which
            KIND of person's: `basisText` would render the stored 'manual'
            through a fallback that prints the raw English word in all three
            languages, and "ground count" would be false over footage nobody
            stood in front of. */}
        <MarkerLine
          className="mt-2.5"
          marks={[
            f.source==="test" ? <Pill key="test" tone="accent">{t("pill.testData")}</Pill> : null,
            corrected
              ? <Pill key="basis" tone="accent">{t("rec.correct.pill")}</Pill>
              : isManual
                ? <Pill key="basis" tone="accent">{t("rec.manual.pill")}</Pill>
                : f.band?.basis ? <Pill key="basis" tone="neutral">{basisText(lang, f.band.basis)}</Pill> : null,
            retired ? <Pill key="retired" tone="neutral">{t("rec.retire.pill")}</Pill> : null,
            provenance ? <span key="prov" className="text-xs text-ink3">{provenance}</span> : null,
          ]}
        />
        {(isManual || corrected) && (
          <p className="text-2xs text-ink3 mt-1.5 leading-relaxed">{t("rec.manual.noBand")}</p>
        )}
        {/* What the standing number replaced, who replaced it and why — the
            three facts that let a corrected figure be defended a year later.
            The superseded count is named out loud: a correction whose "before"
            is invisible is indistinguishable from an overwrite. */}
        {corrected && (
          <div className="text-2xs text-ink3 mt-1 leading-relaxed break-words">
            {corrected.previous?.best != null
              ? t("rec.correct.was", {
                  n: corrected.previous.best,
                  basis: corrected.previous.basis
                    ? basisText(lang, corrected.previous.basis)
                    : t("rep.basisNone"),
                })
              : null}
            {corrected.by ? ` · ${t("rec.correct.byWho", { who: corrected.by })}` : null}
            {corrected.reason ? ` · ${t("rec.correct.reasonIs", { reason: corrected.reason })}` : null}
          </div>
        )}
      </div>

      {/* frame preview: the real photo with every animal marked when the
          engine gave us one; the video player for video; the placeholder
          only where there is genuinely nothing to show. */}
      <div className="aspect-video bg-bg border-b border-line relative shrink-0">
        {f.videoUrl ? (
          <>
            <video src={f.videoUrl} controls className="w-full h-full object-contain" />
            {/* Top corner: the native controls own the bottom edge. */}
            {replayable && (
              <Button
                icon="play"
                className="absolute top-2 right-2 shadow-pop"
                onClick={() => setReplayOpen(true)}
              >
                {t("insp.replay")}
              </Button>
            )}
          </>
        ) : evidence ? (
          <>
            {/* Not while a dialog is up: the two frames are the same
                original, so both <img> elements decode the full-resolution
                still and both overlays stay mounted behind an opaque
                dialog nobody can see through. */}
            {!evidenceOpen && !replayOpen && (
              <EvidenceFrame mediaId={evidence.mediaId} pixels={evidence.pixels} />
            )}
            {/* A control standing on a photograph needs a body of its own —
                the plate, the same one a panel floating over the map gets. A
                bare hairline button over a bright shoreline is unreadable.
                Both controls carry it, replay included. */}
            <div className="absolute bottom-2 right-2 flex gap-1.5">
              {replayable && (
                <Button icon="play" className="plate shadow-pop" onClick={() => setReplayOpen(true)}>
                  {t("insp.replay")}
                </Button>
              )}
              <Button icon="search" className="plate shadow-pop" onClick={() => setEvidenceOpen(true)}>
                {t("insp.openEvidence")}
              </Button>
            </div>
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

      {replayable && (
        <ReplayView open={replayOpen} onOpenChange={setReplayOpen} footage={f} />
      )}

      <div className="flex-1 overflow-auto">
        {/* The engine's own reasons not to trust its band, first - before the
            filename, before anything. They are English sentences straight from
            the run's quality ledger and are rendered verbatim: they are the
            evidence, and paraphrasing evidence is how a floor becomes a
            measurement. Absent (not empty) means the service never reported
            them, and silence is the only honest rendering of that. */}
        {f.caveats && (
          /* No warning lamps. Each caveat had an alert glyph in the signal
             colour beside it — the colour reserved for the standing estimate,
             spent on decoration, repeated once per sentence. The section is
             named "caveats"; the sentences are the warning. */
          <div className="px-4 py-3.5 border-b border-hair">
            <SectionHead title={t("sec.caveats")} className="mb-2" />
            {f.caveats.length ? (
              f.caveats.map((c, i) => (
                <div key={i} className="text-xs text-ink2 leading-relaxed break-words py-1.5 border-b border-hair last:border-0 last:pb-0">
                  {c}
                </div>
              ))
            ) : (
              <div className="text-xs text-ink3 py-1">{t("insp.noCaveats")}</div>
            )}
          </div>
        )}

        <div className="px-4 py-3.5">
          <SectionHead title={t("sec.sortie")} className="mb-1.5" />
          {/* A ground count has no file to name. Printing "(archived survey)"
              over a number a person reported would invent footage. */}
          {/* No `mono` on the filename: the flag means tabular figures now, and
              a filename is not a column of numbers. */}
          {isManual
            ? <Row label={t("row.file")} value={t("rec.manual.title")} />
            : <Row label={t("row.file")} value={f.filename} />}
          {/* A quick count names the clip it was cut from, the second it was
              taken at, and the thing it gave up for the speed. The basis alone
              says `single image`, which does not distinguish this from a
              photograph — and the difference is the whole trade. */}
          {f.quickCount && (
            <Row
              label={t("rec.quick.label")}
              value={
                <span className="text-2xs leading-relaxed">
                  {t("ingest.quickFrom", { name: f.quickCount.fromVideo, s: f.quickCount.atSeconds })}
                  <span className="text-ink3"> · {t("rec.quick.tradeoff")}</span>
                </span>
              }
            />
          )}
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
                  <span className="tnum">{formatDate(f.uploadedAt, lang)}</span>
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
                  <span className="tnum">
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
                  <span className="tnum">
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
          {/* Four numbers, not a percentage on its own: confirmed, rejected,
              still to rule on, and the animals this build has no reviewable
              row for. A rejection is a verdict — leaving it out of both terms
              made a finished triage pass read as an untouched one, and a
              sortie whose animals were all rejected print "nothing to review".
              `pct === null` still means there is genuinely nothing to rule on,
              which is a different statement from "0% reviewed". */}
          <Row
            label={t("row.review")}
            value={
              review.groundCount ? (
                /* A person's count has no per-animal record and never will —
                   that is not the same claim as "this build cannot show you
                   the rows", and it must not be printed as one. */
                <span className="text-ink3">{t("rec.review.ground")}</span>
              ) : review.reviewable === 0 ? (
                <span className="text-ink3">{t("rec.review.nothing")}</span>
              ) : (
                <span className="tnum text-2xs">
                  {t("rec.review.value", {
                    v: review.verified,
                    x: review.rejected,
                    r: review.reviewable - review.ruled,
                  })}
                  {review.unreviewable > 0
                    ? ` · ${t("rec.review.unreviewable", { u: review.unreviewable })}`
                    : ""}
                </span>
              )
            }
          />
        </div>

        {/* Offered while rows are still UNRULED. Gated on `verified` it stayed
            up after a pass that rejected everything, inviting the reviewer back
            to work they had already finished. */}
        {review.reviewable > review.ruled && f.runId && (
          <div className="px-4 pb-3">
            <Button icon="check" full onClick={()=> openReview(f.runId)}>
              {t("rec.review.open")}
            </Button>
          </div>
        )}

        {/* What this sortie was flown INTO. Below the count, because it does
            not change the count; above the record, because it is measured
            rather than written down. */}
        <SortieConditions f={f} />

        {/* ------------------------------------------------------- the record
            What a person knows and the engine cannot derive. Below the
            measured figures, because it annotates them rather than competing
            with them, and above the exports, because a report should carry
            what was just written down. */}
        <SortieNotes f={f} />
        <SurveyMetaEdit f={f} />
        {/* Two logs, two questions. This one answers "what has this sortie's
            COUNT been", the one under it "who ruled on which animal". */}
        <CountHistory surveyId={f.surveyId ?? null} standingRunId={corrected?.runId ?? f.runId ?? null} />
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

        {/* Withdrawing a sortie belongs where the decision is made. The archive
            row has an × too, but it appears on hover, in a list, next to a
            filename — while the reason to withdraw ("this was flown over the
            wrong beach", "the frame is unusable") is legible only here, with
            the count, the caveats and the photograph in front of you. Not for
            an already-retired sortie: that banner at the top already carries
            Undo and, inside it, the destructive second step. */}
        {!retired && <RetireControl f={f} />}
      </div>
    </div>
  );
}

/* A line of quiet markers, middot-separated, skipping the ones that do not
   apply. This is what the pill badges became: words sitting next to the figure
   they qualify. The separator is decoration and is hidden from the screen
   reader, which hears the markers as the separate phrases they are. */
function MarkerLine({ marks, className = "" }: { marks: React.ReactNode[]; className?: string }) {
  const shown = marks.filter(Boolean);
  if (!shown.length) return null;
  return (
    <div className={`flex items-baseline flex-wrap gap-x-1.5 gap-y-0.5 ${className}`}>
      {shown.map((m, i) => (
        <Fragment key={i}>
          {i > 0 && <span aria-hidden="true" className="text-xs text-ink4">·</span>}
          {m}
        </Fragment>
      ))}
    </div>
  );
}

/* --------------------------------------------------- conditions at capture

   The weather, the water, the ice and the food base where and when this
   sortie was flown — every figure named, timed and sourced.

   The rule this panel exists to keep is that no reading is ever shown alone.
   "26.8 °C" is not something this product says: it says 26.8 °C, from MUR at
   1 km, out of the slice of 8 August, 47 hours before the moment asked about,
   from the cell the point falls in. Three consequences the layout has to
   carry:

   - TWO SOURCES FOR ONE THING ARE BOTH SHOWN. MUR (1 km, ~2 days behind) and
     CoralTemp (5 km, same day) measure the same water and disagree by design.
     Neither is picked, neither is averaged; both rows are drawn with their
     own names, because the disagreement IS the uncertainty.
   - A MISSING VALUE IS A ROW, not a gap in the list and never a zero. Ice
     concentration that was not collected says so, with the archive's own
     reason.
   - LATENCY IS A FACT. A reading out of a two-day-old analysis prints how old
     it is next to itself. */
function SortieConditions({ f }: { f: Footage }) {
  const { t, lang } = useT();
  const loadEnv = useFootageStore(s => s.loadEnv);
  /* The store keys conditions by point-and-moment, so two sorties off the same
     spit within the hour share one answer; a sortie with no position has no
     question to ask and is keyed by its own id so the panel can say that
     rather than spin. */
  const key = envKeyOf(f) ?? `unplaced:${f.id}`;
  const card = useFootageStore(s => s.env[key]);
  const [showMissing, setShowMissing] = useState(false);
  const [asking, setAsking] = useState(false);

  /* Keyed on the QUESTION, not on the sortie: re-selecting the same point and
     moment costs nothing, and the store's own guard makes a repeat a no-op. */
  useEffect(() => { void loadEnv(f); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setShowMissing(false); }, [key]);

  const season = seasonOf(conditionsTime(f));
  const when = conditionsTime(f);

  /* Every measured value as its own row, in one order across the product:
     air, then sea state, then water, then ice, then the basin, then the food
     base. Wind speed and direction are the one merge — they are one
     measurement of one thing and reading them two rows apart is worse. */
  const readings = useMemo(() => {
    const out: Array<{ id: string; variable: string; sample: EnvSample; value: number }> = [];
    for (const s of card?.data?.samples ?? []) {
      for (const [variable, value] of Object.entries(s.values ?? {})) {
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        /* Folded into the wind row below. On its own — a source that gave a
           bearing and no speed — it stays a row of its own. */
        if (variable === "wind_dir" && typeof s.values.wind_ms === "number") continue;
        out.push({ id: `${s.source}:${variable}`, variable, sample: s, value });
      }
    }
    return out.sort((a, b) =>
      envVarRank(a.variable) - envVarRank(b.variable) || a.sample.source.localeCompare(b.sample.source));
  }, [card?.data]);

  const missing = card?.data?.missing ?? [];

  return (
    <div className="px-4 py-3 border-b border-line">
      <SectionHead
        title={t("env.conditions")}
        className="mb-1.5"
        right={
          season ? (
            <span className="text-2xs text-ink3" title={t("season.basis")}>
              {t(`season.${season}` as I18nKey)} · {t(`season.${season}.what` as I18nKey)}
            </span>
          ) : (
            <span className="text-2xs text-ink3">{t("season.unknown")}</span>
          )
        }
      />

      {/* Which moment these describe, and — when the flight date was never
          recorded — the fact that the moment is the count job's clock rather
          than the day anybody flew. Conditions on the wrong day are worse than
          no conditions, so the substitution is never silent. */}
      <p className="text-2xs text-ink3 leading-relaxed">
        {t("env.forTime", { time: fmtSlice(when, lang) })}
        {!dateIsRecorded(f) && <> · {t("env.dateFallback")}</>}
      </p>

      {card?.state === "unplaced" ? (
        <p className="text-2xs text-ink3 mt-1.5 leading-relaxed">{t("env.missing.notLocated")}</p>
      ) : card == null || card.state === "loading" ? (
        <p className="text-2xs text-ink3 mt-1.5">{asking ? t("env.asking") : t("env.loading")}</p>
      ) : card.state === "error" ? (
        <div className="mt-1.5">
          <p className="text-2xs text-bad leading-relaxed break-words">
            {t("env.failed", { why: card.error ?? "" })}
          </p>
          <button
            onClick={() => void loadEnv(f, true)}
            className="text-2xs text-ink3 hover:text-ink transition-colors mt-1"
          >
            {t("env.retry")}
          </button>
        </div>
      ) : (
        <>
          {readings.length === 0 ? (
            <div className="mt-1.5">
              <p className="text-2xs text-ink3 leading-relaxed">{t("env.empty")}</p>
              {/* The one place a live fetch is legitimate: a coordinate the
                  collector has never visited, in front of a person who has
                  decided to wait for it. Never on a page load — it is eight
                  third-party round trips. */}
              <button
                disabled={asking}
                onClick={async () => {
                  setAsking(true);
                  await loadEnv(f, true);
                  setAsking(false);
                }}
                className="text-2xs text-ink3 hover:text-ink transition-colors mt-1 disabled:opacity-40"
                title={t("env.askLiveNote")}
              >
                {asking ? t("env.asking") : t("env.askLive")}
              </button>
              <p className="text-2xs text-ink3 mt-0.5 leading-relaxed">{t("env.askLiveNote")}</p>
            </div>
          ) : (
            <div className="mt-1.5">
              {readings.map((r) => (
                <EnvReading
                  key={r.id}
                  variable={r.variable}
                  value={r.value}
                  sample={r.sample}
                  askedAt={card.data?.time ?? when}
                />
              ))}
            </div>
          )}

          {/* Every source in the catalogue that has nothing here, with the
              archive's own reason. Collapsed by default because it is usually
              two rows of "not collected", never omitted because a source that
              has been silently broken since the first cycle would otherwise be
              invisible. */}
          {missing.length > 0 && (
            <div className="mt-2">
              <button
                onClick={() => setShowMissing(!showMissing)}
                aria-expanded={showMissing}
                className="text-2xs text-ink3 hover:text-ink transition-colors"
              >
                {t("env.missingCount", { n: missing.length })} · {showMissing ? t("env.hide") : t("env.show")}
              </button>
              {showMissing && (
                <div className="mt-1">
                  <p className="text-2xs text-ink3 leading-relaxed">{t("env.missing.note")}</p>
                  {missing.map((m) => (
                    <div key={m.source} className="mt-1 leading-relaxed">
                      <span className="text-2xs text-ink2">{sourceName(t, m.source)}</span>
                      <span className="text-2xs text-ink3"> — {missingReason(t, m.reason)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** One measured value: the quantity, the number with its unit, and — on its
 *  own line, in the same breath — the product it came from and the slice it
 *  came out of. The provenance is not a tooltip: a reader copying "27.4 °C"
 *  out of this panel has to carry the source with it. */
function EnvReading({
  variable, value, sample, askedAt,
}: { variable: string; value: number; sample: EnvSample; askedAt: string }) {
  const { t, lang } = useT();
  const unitKey = envUnitKey(variable);
  const unit = unitKey ? t(unitKey as I18nKey) : "";

  /* The IMS classes are an enumeration, not a quantity: 1 open water, 2 land,
     3 sea ice, 4 snow-covered land. Class 2 is honest data — the 1 km chart
     covers the coast too — and is named as land rather than hidden or
     coloured in with the ice. */
  const classKey = variable === "ice_class" ? iceClassKey(value) : null;
  const point = variable === "wind_ms" ? compassOf(sample.values.wind_dir) : null;

  const text = classKey
    ? t(classKey as I18nKey)
    : `${formatEnvValue(variable, value)}${unit ? ` ${unit}` : ""}`;

  return (
    <div className="py-1 border-b border-line-soft last:border-0">
      <div className="flex items-baseline gap-2">
        {/* Wrapped, never clipped. "Температура воды" and "Аномалия
            температуры" are different measurements and an ellipsis renders
            both as "Температура…" — in a panel whose whole claim is that every
            number says what it is. */}
        <span className="text-2xs text-ink3 shrink-0 w-[104px] leading-tight">
          {t(`env.var.${variable}` as I18nKey)}
        </span>
        <span className="text-xs text-ink tnum flex-1 break-words">
          {text}
          {/* Wind is one measurement: the compass point a pilot reads and the
              degrees the instrument recorded, never one without the other. */}
          {point != null && typeof sample.values.wind_dir === "number" && (
            <span className="text-ink2">
              {" · "}
              {t("env.windFrom", {
                dir: t(`env.compass.${point}` as I18nKey),
                deg: formatEnvValue("wind_dir", sample.values.wind_dir),
              })}
            </span>
          )}
          {/* Sea level is a height against a geoid, and the number is negative
              and large. Unlabelled it reads as a depth. */}
          {variable === "sea_level_m" && (
            <span className="text-2xs text-ink3"> · {t("env.seaLevelDatum")}</span>
          )}
        </span>
      </div>
      <div className="text-2xs text-ink3 leading-relaxed break-words" title={latencyOf(t, sample)}>
        {sourceShort(t, sample.source)} · {fmtSlice(sample.measured_at, lang)}
        {ageText(t, sample, askedAt) ? <> · {ageText(t, sample, askedAt)}</> : null}
        {" · "}
        {sample.scope === "basin"
          ? t("env.scope.basin")
          : t("env.distanceKm", { km: sample.distance_km.toFixed(1) })}
      </div>
    </div>
  );
}

/** The slice's own timestamp, to the minute. A conditions reading is only
 *  meaningful with the hour on it — a 09:00 analysis and a 21:00 forecast are
 *  different weather on the same date. */
function fmtSlice(iso: string, lang: string): string {
  return formatDate(iso, lang, {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

/** How far the slice is from the moment asked about, in the right direction.
 *  A satellite analysis is behind; an atmospheric forecast for a planned
 *  sortie is ahead, and printing that as "47 h earlier" would be a lie about
 *  a working feed. `gap_hours` is unsigned, so the direction is read off the
 *  two timestamps. Under an hour is not worth a line. */
function ageText(
  t: (k: I18nKey, v?: Record<string, string | number>) => string,
  s: EnvSample,
  askedAt: string,
): string | null {
  const n = Math.round(s.gap_hours);
  if (!Number.isFinite(n) || n < 1) return null;
  const slice = Date.parse(s.measured_at);
  const asked = Date.parse(askedAt);
  const ahead = Number.isFinite(slice) && Number.isFinite(asked) && slice > asked;
  return ahead ? t("env.aheadHours", { n }) : t("env.ageHours", { n });
}

/** The compact source label — "MUR 1 км" — with its resolution baked in,
 *  because the resolution is what makes two disagreeing readings legible. An
 *  id this build does not know prints as the id: an unrecognised feed is
 *  exactly what a reader must be able to see. */
function sourceShort(t: (k: I18nKey) => string, source: string): string {
  const key = `env.srcShort.${source}` as I18nKey;
  const s = t(key);
  return s === key ? source : s;
}

/** The source's full name, for the missing list where there is room for it. */
function sourceName(t: (k: I18nKey) => string, source: string): string {
  const key = `env.source.${source}` as I18nKey;
  const s = t(key);
  return s === key ? source : s;
}

/** The source's own publishing lag, in the reader's language. */
function latencyOf(t: (k: I18nKey) => string, s: EnvSample): string {
  const key = `env.latency.${s.source}` as I18nKey;
  const text = t(key);
  /* The service's English note is the fallback rather than silence: an
     unrecognised source still has a lag, and it is evidence. */
  return `${s.dataset} · ${text === key ? s.latency_note : text}`;
}

/** The archive's reason a source has nothing here, in the reader's language.
 *
 *  The service writes three sentences and, on a live fetch, the source's own
 *  error text. The three are recognised and translated; anything else is
 *  printed verbatim, because a message from a feed is evidence and
 *  paraphrasing evidence is how a failure becomes a shrug. */
function missingReason(t: (k: I18nKey) => string, reason: string): string {
  const r = (reason ?? "").toLowerCase();
  if (r.startsWith("no stored value")) return t("env.missing.noStored");
  if (r.startsWith("reached the source")) return t("env.missing.noValue");
  if (r.startsWith("not used for this date")) return t("env.missing.otherSource");
  return reason;
}

/* ------------------------------------------------------- the count history

   Every number this sortie has ever carried: the engine's run and each human
   correction above it, newest first, with the standing one marked.

   This is the panel that makes "correct the count" an honest operation rather
   than an edit. The archive keeps both runs either way — but a record nobody
   can read is not a record, and without this the only visible difference
   between a corrected count and an overwritten one is a badge.

   Loaded on demand, like the edit log next to it: nothing should fetch a
   history nobody asked to see. */
function CountHistory({
  surveyId,
  standingRunId,
}: {
  surveyId: string | null;
  standingRunId: string | null;
}) {
  const { t, lang } = useT();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<SurveyCount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  /* Reset on a different sortie AND on a new standing count. The second is
     what keeps this from showing a stale history the moment somebody corrects
     a number with the panel already open — the list would then be missing the
     very row they just wrote. */
  useEffect(() => {
    setRows(null);
    setError(null);
  }, [surveyId, standingRunId]);

  const load = useCallback(async () => {
    if (!surveyId) return;
    setLoading(true);
    setError(null);
    try {
      setRows(await fetchSurveyCounts(surveyId));
    } catch (e) {
      setError(`${t("rec.counts.failed")}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [surveyId, t]);

  /* Reloads when a correction lands under an open panel, for the reason
     above. Not on mount: `open` is false there. */
  useEffect(() => {
    if (open && rows === null && !loading && !error) void load();
  }, [open, rows, loading, error, load]);

  return (
    <div className="px-4 py-3.5 border-b border-hair">
      <SectionHead
        title={t("rec.counts.title")}
        className="mb-2"
        right={
          surveyId ? (
            <button
              onClick={() => setOpen(!open)}
              aria-expanded={open}
              className="text-2xs text-ink3 hover:text-ink transition-colors"
            >
              {open ? t("rec.counts.hide") : t("rec.counts.show")}
            </button>
          ) : undefined
        }
      />
      {!surveyId ? (
        <p className="text-2xs text-ink3 leading-relaxed">{t("rec.counts.noSurvey")}</p>
      ) : open ? (
        loading ? (
          <p className="text-2xs text-ink3">{t("rec.counts.loading")}</p>
        ) : error ? (
          <p className="text-2xs text-bad leading-relaxed">{error}</p>
        ) : rows && rows.length ? (
          <div className="max-h-[180px] overflow-auto -mx-1 px-1">
            {rows.map((c) => (
              <div
                key={c.run_id}
                className="flex items-baseline gap-2 py-1.5 border-b border-hair last:border-0"
              >
                {/* The standing figure carries the signal colour; the word
                    marking it stays a quiet word. Colouring the badge and
                    leaving the number grey put the accent on the label
                    instead of on the thing the label is about. */}
                <span className={`text-sm tnum shrink-0 w-[52px] ${c.standing ? "text-accent" : "text-ink3"}`}>
                  {c.best ?? "—"}
                </span>
                <span className="text-2xs text-ink3 flex-1 truncate">
                  {/* The engine's own word for how it counted, or the fact
                      that a person entered this one. Never both, and never a
                      band's label over a number that has no band. */}
                  {c.correction && c.corrects_run
                    ? t("rec.correct.pill")
                    : c.engine === "manual"
                      ? t("rec.manual.pill")
                      : c.basis
                        ? basisText(lang, c.basis)
                        : t("rep.basisNone")}
                  {c.operator ? ` · ${c.operator}` : ""}
                  {c.reason ? ` · ${c.reason}` : ""}
                </span>
                {c.standing && <Pill>{t("rec.counts.standing")}</Pill>}
                <span className="text-2xs text-ink3 tnum shrink-0">
                  {c.created_at ? formatDate(c.created_at, lang) : "—"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-2xs text-ink3">{t("rec.counts.empty")}</p>
        )
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- withdraw

   Step one of the two, and the reversible one. A reason is mandatory for the
   same reason it is mandatory in the archive: a number that silently left a
   season's total is as bad as one that silently joined it, and six months on
   nobody can defend either without the sentence somebody typed here. */
function RetireControl({ f }: { f: Footage }) {
  const { t } = useT();
  const retireFootage = useFootageStore(s => s.retireFootage);
  const [asked, setAsked] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* A different sortie under the same panel: an unfinished withdrawal must not
     follow the operator onto it. */
  useEffect(() => {
    setAsked(false);
    setReason("");
    setError(null);
  }, [f.id]);

  if (!asked) {
    return (
      <button
        onClick={() => setAsked(true)}
        className="mt-3 text-2xs text-ink3 hover:text-bad transition-colors"
      >
        {t("rec.retire.action")}
      </button>
    );
  }

  return (
    <div className="mt-3 space-y-2 border-t border-hair pt-2.5">
      <p className="text-2xs text-ink2 leading-relaxed">{t("rec.retire.explain")}</p>
      <input
        value={reason}
        onChange={(e) => { setReason(e.target.value); setError(null); }}
        maxLength={REASON_MAX}
        autoFocus
        placeholder={t("rec.retire.reasonPlaceholder")}
        aria-label={t("rec.retire.reasonLabel")}
        className="w-full h-7 bg-transparent border-b border-line px-0 text-xs placeholder:text-ink4 focus:border-ink2 transition-colors"
      />
      {error && <p className="text-2xs text-bad leading-relaxed">{error}</p>}
      <div className="flex items-center gap-3 text-2xs">
        <button
          disabled={busy}
          onClick={async () => {
            if (!reason.trim()) { setError(t("rec.retire.reasonRequired")); return; }
            setBusy(true);
            const ok = await retireFootage(f.id, reason.trim());
            setBusy(false);
            if (ok) setAsked(false);
            else setError(t("rec.retire.failed"));
          }}
          className="text-bad hover:underline disabled:opacity-50"
        >
          {t("rec.retire.action")}
        </button>
        <button
          onClick={() => { setAsked(false); setError(null); }}
          className="text-ink3 hover:text-ink transition-colors"
        >
          {t("btn.cancel")}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ hard delete

   The end of the two-step. Retirement withdrew this sortie from the estimate
   and can be undone; this destroys it — the survey row, every run, every
   animal, the correction log and the footage on disk.

   The confirmation names real numbers, and they come from the service's own
   dry run rather than from anything this component counted: a client's guess
   under a button marked "for ever" is worse than no number. */
export function PurgeControl({ f }: { f: Footage }) {
  const { t } = useT();
  const purgeFootage = useFootageStore(s => s.purgeFootage);
  const [asked, setAsked] = useState(false);
  const [preview, setPreview] = useState<PurgeReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /* A selection change closes an armed confirmation. A dialog that survived
     the sortie under it would delete the wrong season. */
  useEffect(() => { setAsked(false); setPreview(null); setError(null); }, [f.id]);

  const ask = async () => {
    setAsked(true);
    setError(null);
    setPreview(null);
    if (!f.surveyId) return;   // local-only row: nothing to count, nothing on disk
    setBusy(true);
    try {
      setPreview(await fetchPurgePreview(f.surveyId));
    } catch (e) {
      setError(`${t("rec.purge.previewFailed")}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  if (!asked) {
    return (
      <button
        onClick={() => void ask()}
        className="mt-1.5 text-2xs text-ink3 hover:text-bad transition-colors"
      >
        {t("rec.purge.action")}
      </button>
    );
  }

  return (
    /* A rule, not a box inside the banner's box. */
    <div className="mt-2 pl-3 border-l border-bad space-y-1.5">
      <p className="text-2xs text-ink2 leading-relaxed">{t("rec.purge.confirmTitle")}</p>
      {busy ? (
        <p className="text-2xs text-ink3">{t("rec.purge.checking")}</p>
      ) : error ? (
        <p className="text-2xs text-bad leading-relaxed">{error}</p>
      ) : (
        <p className="text-2xs text-ink3 leading-relaxed">
          {/* Counted by the same function that does the deleting. A sortie
              this tab never sent to the service has no archive rows at all,
              and the sentence says that instead of printing four zeros. */}
          {f.surveyId && preview
            ? t("rec.purge.what", {
                files: preview.files,
                points: preview.counts.points,
                edits: preview.counts.edits,
                runs: preview.counts.runs,
              })
            : t("rec.purge.localOnly")}
        </p>
      )}
      <div className="flex items-center gap-2 text-2xs">
        <button
          disabled={busy || (!!f.surveyId && !preview)}
          onClick={async () => {
            setBusy(true);
            const ok = await purgeFootage(f.id);
            setBusy(false);
            if (!ok) setAsked(false);
            /* On success this component unmounts with the sortie it described. */
          }}
          className="text-bad hover:underline disabled:opacity-40 disabled:no-underline"
        >
          {t("rec.purge.confirm")}
        </button>
        <button
          onClick={() => { setAsked(false); setError(null); }}
          className="text-ink3 hover:text-ink transition-colors"
        >
          {t("btn.cancel")}
        </button>
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
  /* Nothing to show, said flatly. The blue radial wash that used to sit here
     was a picture of a photograph that does not exist — and the filename under
     it was set in a typewriter face for no reason but decoration. */
  return (
    <div className="w-full h-full relative bg-bg overflow-hidden grid place-items-center">
      {/* bbox is optional and, since the real engine replaced the mock, usually
          absent: the counter returns a point per animal, not a box. The mock
          always supplied one, so the old code indexed it unguarded - which
          crashed the whole app the moment a real sortie was selected. */}
      {det && Array.isArray(det.bbox) && det.bbox.length === 4 && (
        <div
          className="absolute border border-accent"
          style={{ left: `${det.bbox[0]*100}%`, top: `${det.bbox[1]*100}%`, width: `${det.bbox[2]*100}%`, height: `${det.bbox[3]*100}%` }}
        >
          <span className="absolute -top-[15px] left-0 bg-bg text-accent text-2xs font-medium px-1 leading-[14px] tnum">
            {count}
          </span>
        </div>
      )}
      <span className="absolute bottom-2 left-2.5 text-2xs text-ink3 truncate max-w-[80%]">{filename}</span>
    </div>
  );
}
