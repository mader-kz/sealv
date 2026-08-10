"use client";
/**
 * ПРОВЕРКА — the screen a review actually happens on.
 *
 * There used to be two windows for this and neither was a workspace. The
 * Детекции drawer showed a filename, a score and two coordinates per animal,
 * which is not evidence of anything — a scientist could certify 1474 animals
 * through it without looking at one. The Доказательство dialog showed the
 * frame, but as a modal over the map: 88vh of photograph with the verdict
 * controls in a strip, opened from an inspector, closed by a reflex keystroke.
 *
 * This is the same machinery in a room of its own. Three quarters of the
 * screen is the photograph. The quarter beside it is everything a reviewer has
 * to know while looking at it — what this sortie is claiming, how much of the
 * claim a human has ruled on, which animal is next, and the two keys that rule
 * on it. Nothing floats, nothing overlaps, and Escape goes back to Карта
 * instead of destroying the pass.
 *
 * What it does NOT do is invent a review model. The queue, the verdicts, the
 * live merge of engine points with archive rows, the camera and the honest
 * arithmetic all already existed (useReviewStore, EvidenceCanvas/useLiveReview,
 * lib/analytics/review). This file houses them.
 *
 * The season-wide table is one tab away, not deleted: bulk verdicts, the
 * cross-sortie filter, the undo of a mass mistake and the CSV are things the
 * frame cannot do, and a screen that quietly dropped them would be a smaller
 * product wearing a better layout.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EvidenceCanvas, markedCount, useLiveReview, type EvidenceCanvasApi, type Transform } from "@/components/evidence/EvidenceView";
import TriageTable from "@/components/workbench/Workbench";
import SortieNotes from "@/components/record/SortieNotes";
import { Button, SectionHead, Pill } from "@/components/ui/primitives";
import { reviewStats } from "@/lib/analytics/review";
import { basisText, useT } from "@/lib/i18n";
import { REASON_MAX } from "@/lib/api";
import { setMode } from "@/lib/modes";
import { useFootageStore } from "@/store/useFootageStore";
import { useReviewStore } from "@/store/useReviewStore";
import type { DetectionPixel, Footage } from "@/lib/types";

/* Rows of the queue kept in the DOM. A season target of ~2000 animals per
   sortie is not a list anybody scrolls; what a reviewer needs beside the frame
   is what is coming and the few they just passed. */
const QUEUE_ROWS = 40;
const QUEUE_LOOKBACK = 4;

/** Short, sayable run id. Three of the fixture's sorties share a filename;
 *  without this there is no way to tell them apart in the picker. */
const shortRun = (f: Footage): string => (f.runId ?? f.id.replace(/^run-/, "")).slice(0, 8);

/** A sortie whose animals can be put in front of a person in this build: a
 *  still, with the frame behind it and points measured on it. Same test the
 *  inspector uses to decide whether to offer the evidence view. */
const hasFrame = (f: Footage | null | undefined): boolean =>
  !!f && !f.videoUrl && !!f.mediaId && !!f.pixels && f.pixels.length > 0;

/** Where a reviewer who has not chosen anything should land: the sortie with
 *  work left on it. Not "the newest" — the point of opening this screen is the
 *  backlog, and a newest-first default puts a finished sortie on screen while
 *  four hundred unruled animals sit two clicks away. */
function pickBacklog(footages: Footage[]): Footage | null {
  let best: Footage | null = null;
  let bestLeft = 0;
  for (const f of footages) {
    if (!hasFrame(f)) continue;
    const s = reviewStats(f);
    const left = s.reviewable - s.ruled;
    if (left > bestLeft) { best = f; bestLeft = left; }
    if (!best && left === 0) best = f;
  }
  if (best) return best;
  return footages.find(hasFrame) ?? footages[0] ?? null;
}

export default function ReviewMode() {
  const { t } = useT();
  const footages = useFootageStore((s) => s.footages);
  const view = useReviewStore((s) => s.view);
  const setView = useReviewStore((s) => s.setView);
  const runScope = useReviewStore((s) => s.runScope);
  const setRunScope = useReviewStore((s) => s.setRunScope);

  /* The scope is one value shared with the table, and it is read in both
     spellings: the inspector's button hands over a bare RUN id, the store
     knows footage ids. */
  const scoped = useMemo(
    () => (runScope ? footages.find((f) => f.id === runScope || f.runId === runScope) ?? null : null),
    [footages, runScope],
  );
  const auto = useMemo(() => pickBacklog(footages), [footages]);
  /* Derived, never written back on mount. An effect that "helpfully" wrote the
     auto-pick into the store would turn "the whole season" — which is a real
     and useful state of the table next door — into a scope nobody chose. */
  const f = scoped ?? auto;

  /* Escape belongs to the screen, not to a widget: it is how you leave. Text
     fields keep their own — a reviewer clearing a half-typed note must not be
     thrown out onto the map. */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (isTyping(e.target)) return;
      e.preventDefault();
      setMode("map");
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, []);

  const stats = useMemo(() => reviewStats(f), [f]);
  const progressText = !f
    ? ""
    : stats.pct === null
      ? t("wb.reviewNothing")
      : t("wb.reviewProgress", { n: stats.ruled, m: stats.reviewable, pct: Math.round(stats.pct) });

  return (
    <>
      {/* The mode's own header. One line: what this is, which sortie, how far
          in, and the two shapes the screen can take. */}
      <div className="h-9 shrink-0 border-b border-line flex items-center gap-3 px-4">
        <span className="hd">{t("nav.review")}</span>
        {view === "frame" && footages.length > 0 && (
          <select
            aria-label={t("wb.scope")}
            value={f?.id ?? ""}
            onChange={(e) => setRunScope(e.target.value || null)}
            className="h-7 max-w-[300px] bg-transparent border-0 border-b border-line px-0 text-xs text-ink2 hover:border-ink4 focus:border-ink2 transition-colors"
          >
            {footages.map((x) => {
              const s = reviewStats(x);
              const left = s.reviewable > 0 ? ` · ${s.ruled}/${s.reviewable}` : "";
              return (
                <option key={x.id} value={x.id}>
                  {`${x.filename} · ${shortRun(x)}${left}`}
                </option>
              );
            })}
          </select>
        )}
        {view === "frame" && f && <span className="text-xs text-ink3 tnum">{progressText}</span>}
        <div className="flex-1" />
        <span className="text-2xs text-ink3 hidden xl:block">{t("rev.keysMode")}</span>
        <div className="flex items-center">
          <Tab active={view === "frame"} onClick={() => setView("frame")} title={t("rev.viewFrameWhy")}>
            {t("rev.viewFrame")}
          </Tab>
          <Tab active={view === "table"} onClick={() => setView("table")} title={t("rev.viewTableWhy")}>
            {t("rev.viewTable")}
          </Tab>
        </div>
      </div>

      {view === "table" ? (
        <TriageTable />
      ) : f ? (
        /* Keyed on the sortie: a different frame is a different pass, and the
           camera, the queue window and the correction draft all belong to the
           one it was opened on. */
        <FrameWorkspace key={f.id} f={f} />
      ) : (
        <div className="flex-1 grid place-items-center p-8">
          <p className="text-sm text-ink3 max-w-[380px] text-center leading-relaxed">{t("rev.nothing")}</p>
        </div>
      )}
    </>
  );
}

/* An underline, not a filled chip: the same hairline vocabulary as the rest of
   the instrument, and the active one is stated by ink rather than by a box. */
function Tab({
  active, onClick, title, children,
}: { active: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`h-7 px-2.5 text-xs border-b transition-colors ${
        active ? "border-ink text-ink" : "border-transparent text-ink3 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

/** Is the keystroke somebody's typing rather than a verdict. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

/** Does the keyboard already mean something on this element — a button the
 *  space bar presses, a link Enter follows. */
function isActivatable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute?.("role") === "button";
}

/* ------------------------------------------------------------------------ */

function FrameWorkspace({ f }: { f: Footage }) {
  const { t, tp, lang } = useT();
  const updateDetection = useFootageStore((s) => s.updateDetection);
  const saving = useFootageStore((s) => Number((s as any).verdictsInFlight ?? 0) > 0);

  const setCursor = useReviewStore((s) => s.setCursor);
  const storedCursor = useReviewStore((s) => s.cursor);
  const cursorScope = useReviewStore((s) => s.cursorScope);

  const pixels = useMemo(() => f.pixels ?? [], [f.pixels]);
  const { livePixels, order, detOf, scopeKey } = useLiveReview({ pixels, footageId: f.id });

  /* Where in the queue we are. The store holds it so leaving for the map and
     coming back resumes; it is clamped on read rather than written back,
     because a queue that shortened under a reviewer is not a reason to
     rewrite what they had chosen. */
  const idx = cursorScope === scopeKey ? Math.min(storedCursor, Math.max(0, order.length - 1)) : 0;
  const current: DetectionPixel | null = order[idx] ?? null;
  const currentDet = detOf(current);

  /* Bumped on every move the reviewer did NOT make with the mouse on the
     frame. Clicking an animal must not yank the camera away from the animal
     they just clicked; choosing one from the queue, or stepping with the
     arrows, must bring it to them. */
  const [focusToken, setFocusToken] = useState(0);
  const [xf, setXf] = useState<Transform>({ scale: 1, tx: 0, ty: 0 });
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const canvas = useRef<EvidenceCanvasApi | null>(null);

  const goTo = useCallback((i: number, camera: boolean) => {
    if (!order.length) return;
    const n = Math.max(0, Math.min(order.length - 1, i));
    setCursor(n, scopeKey);
    if (camera) setFocusToken((v) => v + 1);
  }, [order.length, setCursor, scopeKey]);

  /* A verdict, and only where one can actually be stored. A point with no
     per-animal row behind it has nowhere for the decision to go, and writing
     it to local state alone would be a saved-looking lie.

     Never back to "auto": the service records exactly two operator verdicts
     (service/db.py apply_edit), so "nobody has looked at this" is a state a
     point can leave and cannot be put back into. Which is why a click cycles
     between the two verdicts and never round to untouched. */
  const rule = useCallback((to: "validated" | "false_positive", advance: boolean) => {
    const d = currentDet;
    if (!d) return;
    if (d.status !== to) updateDetection(d.id, { status: to });
    if (advance) goTo(idx + 1, true);
  }, [currentDet, updateDetection, goTo, idx]);

  /* The frame's own keys. Bound on the document rather than on the viewport so
     they work while the reviewer's hand is over the queue or the note — and
     skipped inside a text field, where "x" is a letter. */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const code = e.code;
      const key = e.key;
      /* Space on a focused button is that button being pressed, and swallowing
         it here would make every control in the rail keyboard-inert. */
      if ((key === " " || code === "Space") && isActivatable(e.target)) return;
      /* Read off `code` as well as `key`: on the Cyrillic layout two thirds of
         this product's users type, the physical V key emits "м". */
      const hit = (c: string, k: string) => code === c || key.toLowerCase() === k;
      if (key === "ArrowRight" || key === "ArrowDown") { e.preventDefault(); goTo(idx + 1, true); return; }
      if (key === "ArrowLeft" || key === "ArrowUp") { e.preventDefault(); goTo(idx - 1, true); return; }
      if (key === " " || code === "Space") { e.preventDefault(); goTo(idx + 1, true); return; }
      if (hit("KeyV", "v")) { e.preventDefault(); rule("validated", true); return; }
      if (hit("KeyX", "x")) { e.preventDefault(); rule("false_positive", true); }
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [goTo, idx, rule]);

  /* A click on the frame SELECTS. A second click on the animal already under
     the cursor rules on it — the prototype's "click cycles the verdict", with
     the one click of slack that keeps a mis-aimed pointer from certifying an
     animal nobody looked at. */
  const onPick = useCallback((p: DetectionPixel) => {
    const i = order.findIndex((x) => x.id === p.id);
    if (i < 0) return;
    if (i !== idx) { goTo(i, false); return; }
    const d = detOf(p);
    if (!d) return;
    rule(d.status === "validated" ? "false_positive" : "validated", false);
  }, [order, idx, goTo, detOf, rule]);

  const stats = useMemo(() => reviewStats(f), [f]);
  const marked = useMemo(() => markedCount(livePixels), [livePixels]);
  const untouched = Math.max(0, stats.reviewable - stats.ruled);

  const band = f.band ?? null;
  const hasRange = !!band && band.low != null && band.high != null && band.low !== band.high;

  const frame = hasFrame(f);
  const queueStart = Math.max(0, Math.min(idx - QUEUE_LOOKBACK, Math.max(0, order.length - QUEUE_ROWS)));
  const queue = order.slice(queueStart, queueStart + QUEUE_ROWS);

  return (
    <div className="flex-1 min-h-0 flex">
      {/* --------------------------------------------------------- the frame */}
      <div className="flex-1 min-w-0 relative flex flex-col">
        {frame && f.mediaId ? (
          <>
            <EvidenceCanvas
              className="flex-1"
              mediaId={f.mediaId}
              pixels={livePixels}
              cursor={current}
              focusToken={focusToken}
              onPick={onPick}
              onTransform={setXf}
              onDims={setDims}
              apiRef={canvas}
            />
            {/* What is on screen and at what magnification. On a plate, because
                it stands on a photograph. */}
            <div className="plate absolute left-3 bottom-3 px-2 py-1 flex items-center gap-2 text-2xs text-ink3 pointer-events-none">
              <span className="text-ink2">{f.filename}</span>
              {dims && <span className="tnum">{dims.w}×{dims.h}</span>}
              <span className="tnum">{t("rev.zoom", { n: Math.round(xf.scale * 100) })}</span>
              <span className="hidden lg:inline">{t("rev.panHint")}</span>
            </div>
            <div className="plate absolute right-3 bottom-3 flex items-center">
              <button
                onClick={() => canvas.current?.zoomBy(1.35)}
                title={t("rev.zoomIn")}
                aria-label={t("rev.zoomIn")}
                className="w-7 h-7 grid place-items-center text-ink3 hover:text-ink transition-colors"
              >+</button>
              <button
                onClick={() => canvas.current?.zoomBy(1 / 1.35)}
                title={t("rev.zoomOut")}
                aria-label={t("rev.zoomOut")}
                className="w-7 h-7 grid place-items-center text-ink3 hover:text-ink transition-colors"
              >−</button>
              <button
                onClick={() => canvas.current?.reset()}
                title={t("rev.zoomFit")}
                aria-label={t("rev.zoomFit")}
                className="w-7 h-7 grid place-items-center text-2xs text-ink3 hover:text-ink transition-colors"
              >1:1</button>
            </div>
          </>
        ) : (
          /* A video sortie. Its animals are real, they have ids, pixels and
             scores in the archive, and this build cannot put a single one of
             them in front of a person — there is no one frame to show them on.
             That is said in the same words the table and the dashboard use,
             and it is not dressed up as an error. */
          <div className="flex-1 grid place-items-center p-8">
            <div className="max-w-[420px] text-center space-y-2">
              <p className="text-sm text-ink2">{t("rev.noFrame")}</p>
              {stats.unreviewable > 0 && (
                <p className="text-xs text-ink3 leading-relaxed">
                  {t("wb.noMapPosition", { n: stats.unreviewable })}
                </p>
              )}
              <p className="text-2xs text-ink4 leading-relaxed">{t("wb.noMapPositionWhy")}</p>
            </div>
          </div>
        )}
      </div>

      {/* ---------------------------------------------------------- the rail */}
      <aside className="w-[300px] shrink-0 border-l border-line flex flex-col min-h-0 overflow-y-auto">
        {/* What this sortie is claiming. The engine's own figure and its range
            stay next to it: the standing number is the engine's minus what a
            person threw out, and hiding either half would make the difference
            look like a measurement nobody made. */}
        <div className="px-4 py-3 border-b border-line">
          <div className="flex items-baseline gap-2">
            <span className={`text-hero tnum font-medium leading-none ${marked > 0 ? "text-accent" : "text-ink3"}`}>
              {marked}
            </span>
            <span className="text-xs text-ink3 leading-tight">{tp(marked, "ev.animalsMarked")}</span>
          </div>
          <p className="mt-1.5 text-2xs text-ink3">{t("rev.standingWhy")}</p>
          {band && (
            <p className="mt-2 text-2xs text-ink3 tnum">
              {t("rev.engineCount", { n: band.best ?? marked })}
              {" · "}
              {hasRange
                ? t("misc.range", { low: band.low as number, high: band.high as number })
                : t("rev.noBand")}
            </p>
          )}
          {band?.basis && (
            <div className="mt-1.5"><Pill tone="neutral">{basisText(lang, band.basis)}</Pill></div>
          )}
        </div>

        {/* How much of it a human has ruled on. `pct` is null when there is
            nothing to review, and that is printed as such: "0% reviewed" over a
            sortie the product cannot offer a reviewer is an accusation, not a
            measurement. */}
        <div className="px-4 py-3 border-b border-line">
          <SectionHead title={t("rev.pointsChecked")} />
          <p className="mt-2 text-xs text-ink2 tnum">
            {stats.pct === null
              ? t("wb.reviewNothing")
              : t("wb.reviewProgress", { n: stats.ruled, m: stats.reviewable, pct: Math.round(stats.pct) })}
          </p>
          <p className="mt-1.5 text-2xs text-ink3 tnum">
            {t("rev.breakdown", { v: stats.verified, x: stats.rejected, o: untouched })}
          </p>
          {stats.unreviewable > 0 && (
            <p className="mt-1.5 text-2xs text-ink3 leading-relaxed" title={t("wb.noMapPositionWhy")}>
              {t("wb.noMapPosition", { n: stats.unreviewable })}
            </p>
          )}
        </div>

        {frame && (
          <>
            {/* The two verdicts, with their keys on them. Inert — and saying
                why — when the point under the cursor has no archive row. */}
            <div className="px-4 py-3 border-b border-line">
              <div className="flex items-center gap-1.5">
                <Button
                  icon="check"
                  className="hover:!text-good hover:!border-good"
                  disabled={!currentDet || currentDet.status === "validated"}
                  title={currentDet ? t("wb.markVerifiedWhy") : t("rev.noRecord")}
                  onClick={() => rule("validated", true)}
                >
                  {t("rev.verify")}
                </Button>
                <Button
                  className="hover:!text-bad hover:!border-bad"
                  disabled={!currentDet || currentDet.status === "false_positive"}
                  title={currentDet ? t("wb.markFalseWhy") : t("rev.noRecord")}
                  onClick={() => rule("false_positive", true)}
                >
                  {t("rev.false")}
                </Button>
                {saving && <span className="text-2xs text-ink3">{t("wb.saving")}</span>}
              </div>
              <p className="mt-2 text-2xs text-ink3 leading-relaxed">
                {current
                  ? t("rev.pointSelected", { n: current.id })
                  : t("rev.pickPoint")}
              </p>
              <p className="mt-1.5 text-2xs text-ink4 leading-relaxed">{t("rev.noUndoAuto")}</p>
            </div>

            {/* The queue. Worst score first, because that is where a human's
                time is worth the most — and the order is the model's own
                confidence, not a shuffle. */}
            <div className="px-4 py-3 border-b border-line">
              <SectionHead
                title={t("rev.worst")}
                right={<span className="text-2xs text-ink3 tnum">{t("rev.queueLeft", { n: untouched })}</span>}
              />
              <p className="sr-only">{t("rev.worstWhy")}</p>
              <div className="mt-2" title={t("rev.worstWhy")}>
                {queue.map((p, i) => {
                  const at = queueStart + i;
                  const st = detOf(p)?.status ?? p.status;
                  const mark = st === "validated" ? "✓" : st === "false_positive" ? "✕" : "·";
                  return (
                    <button
                      key={p.id}
                      onClick={() => goTo(at, true)}
                      className={`w-full flex items-center gap-2 px-1 py-1 text-2xs border-b border-hair last:border-0 transition-colors ${
                        at === idx ? "bg-hover text-ink" : "text-ink3 hover:bg-hover hover:text-ink"
                      }`}
                    >
                      <span className={st === "validated" ? "text-good" : st === "false_positive" ? "text-bad" : "text-ink4"}>
                        {mark}
                      </span>
                      <span className="tnum">#{p.id}</span>
                      <span className="flex-1" />
                      <span className="tnum">
                        {typeof p.score === "number" && Number.isFinite(p.score) ? p.score.toFixed(2) : "—"}
                      </span>
                    </button>
                  );
                })}
                {order.length === 0 && (
                  <p className="text-2xs text-ink3">{t("wb.reviewNothing")}</p>
                )}
              </div>
            </div>
          </>
        )}

        {/* What the engine cannot say, and the one number a review pass cannot
            fix: ruling on animals moves the verified share, not the estimate.
            This is where a person who counted the frame themselves says so. */}
        <SortieNotes f={f} />
        <CorrectCount f={f} />
      </aside>
    </div>
  );
}

/* --------------------------------------------------------------- correction */

/** «Исправить число» — the same write the inspector offers, in the room where
 *  a person is actually looking at the frame and can see that the engine is
 *  wrong. Same store action, same service call, same words. */
function CorrectCount({ f }: { f: Footage }) {
  const { t } = useT();
  const correctFootageCount = useFootageStore((s) => s.correctFootageCount);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [why, setWhy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /* No survey row behind this sortie means there is nothing to address a
     correction to; a form that could only fail is worse than no form. */
  if (!f.surveyId || f.status === "processing" || f.status === "error") return null;

  const current = f.band?.best ?? 0;

  return (
    <div className="px-4 py-3 border-t border-line">
      {!open ? (
        <button
          onClick={() => { setDraft(String(current)); setWhy(""); setError(null); setOpen(true); }}
          className="text-2xs text-ink3 hover:text-ink transition-colors"
        >
          {t("rec.correct.action")}
        </button>
      ) : (
        <div className="space-y-2 border-l border-line pl-3">
          {/* Said before the field, not after it: this replaces the number the
              whole product reports for this sortie, and the previous count is
              kept rather than overwritten. */}
          <p className="text-2xs text-ink2 leading-relaxed">{t("rec.correct.explain")}</p>
          <input
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            autoFocus
            value={draft}
            onChange={(e) => { setDraft(e.currentTarget.value); setError(null); }}
            aria-label={t("rec.correct.countLabel")}
            className="w-full bg-transparent border-b border-line px-0 py-1 text-lead tnum text-ink focus:border-ink2 transition-colors"
          />
          <input
            type="text"
            value={why}
            /* The service caps this at REASON_MAX and refuses past it; the
               input stops at the same number so a reason that types fine
               cannot 400 behind a generic failure. */
            maxLength={REASON_MAX}
            onChange={(e) => setWhy(e.currentTarget.value)}
            placeholder={t("rec.correct.reasonPlaceholder")}
            aria-label={t("rec.correct.reasonLabel")}
            className="w-full bg-transparent border-b border-line px-0 py-1 text-xs text-ink placeholder:text-ink4 focus:border-ink2 transition-colors"
          />
          {error && <p className="text-2xs text-bad leading-relaxed">{error}</p>}
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              disabled={saving}
              onClick={async () => {
                /* Parsed strictly. `Number("12abc")` is NaN and
                   `parseInt("12.7")` is 12 — one of those silently stores a
                   count nobody entered. */
                const n = Number(draft.trim());
                if (!draft.trim() || !Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
                  setError(t("rec.correct.badCount"));
                  return;
                }
                setSaving(true);
                const ok = await correctFootageCount(f.id, n, why);
                setSaving(false);
                if (ok) { setOpen(false); setWhy(""); }
                else setError(t("rec.correct.failed"));
              }}
            >
              {saving ? t("rec.correct.saving") : t("rec.correct.save")}
            </Button>
            <button
              onClick={() => { setOpen(false); setError(null); }}
              className="text-2xs text-ink3 hover:text-ink transition-colors"
            >
              {t("btn.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
