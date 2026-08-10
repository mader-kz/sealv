"use client";
/* TriageBar — the control strip of a review walk.
 *
 * It carries the four things a reviewer ruling on a thousand animals needs in
 * front of them at all times: where they are in the queue, what the model said
 * about the animal under the cursor, the keys that write a verdict, and
 * whether those verdicts are reaching the archive. Nothing here decides
 * anything; it renders the walk's state and calls back.
 *
 * The legend is always visible, never a tooltip. A keyboard interface nobody
 * is told about is a keyboard interface nobody uses.
 */
import { Button, Pill } from "@/components/ui/primitives";
import { useT } from "@/lib/i18n";

export type TriageBarProps = {
  /** 1-based position in the walk. */
  index: number;
  total: number;
  score: number | null;
  status: "auto" | "validated" | "false_positive" | string;
  /** A verdict written here can actually be persisted. False when the point
   *  has no per-animal record behind it — then the buttons are inert and say
   *  why, rather than pretending to save. */
  canRule: boolean;
  /** Verdicts are in flight to the service. */
  saving: boolean;
  /** The walk has visited every point. */
  atEnd: boolean;
  onValidate: () => void;
  onFalse: () => void;
  onSkip: () => void;
  onPrev: () => void;
  onNext: () => void;
  onExit: () => void;
};

/* Keycap. Small enough not to shout, distinct enough that the binding reads as
   a key and not as decoration.

   Square and in the same face as everything else. It was a rounded monospace
   chip — the two costumes this design retired: a keycap is a word, and the
   typewriter face is reserved for run/survey id hashes. What makes it read as
   a key is the hairline around it, not a border radius. It sits on ink3 and
   not ink4, because the binding is a fact the reviewer has to be able to
   read, not an echo of one printed elsewhere. */
function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="ml-1 px-1 border border-line text-2xs leading-[14px] text-ink3">
      {children}
    </kbd>
  );
}

export default function TriageBar({
  index,
  total,
  score,
  status,
  canRule,
  saving,
  atEnd,
  onValidate,
  onFalse,
  onSkip,
  onPrev,
  onNext,
  onExit,
}: TriageBarProps) {
  const { t } = useT();

  /* No progress meter. The strip used to open with a 2px accent bar filling
     left to right, and it was three things this direction rejects at once: a
     decorative meter restating a number printed two centimetres below it in
     words ("3 / 1473"), the signal colour spent on that restatement rather
     than on a standing estimate or a live state, and a filled strip implying a
     target being approached — a reviewer is not obliged to walk every animal.
     The position is the sentence; nothing was measured that the sentence does
     not already say. */
  return (
    /* Chrome over the frame, so it stays chrome: no fill. The strip was a
       grey `surface2` band, the uniform panel this design replaced with a
       hairline and an alignment. */
    <div className="shrink-0 border-b border-line bg-surface">
      <div className="px-4 py-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-xs text-ink tnum" role="status" aria-live="polite">
          {t("rev.progress", { i: index, n: total })}
        </span>
        {/* Both readings sit on one step and separate by colour, not by a
            pixel of size: where the reviewer is, in ink; what the model said,
            one shade down. */}
        <span className="text-xs text-ink3 tnum" title={t("rev.walkAll")}>
          {score == null ? t("ev.noScore") : t("ev.score", { n: score.toFixed(2) })}
        </span>
        <Pill tone={status === "validated" ? "good" : status === "false_positive" ? "bad" : "neutral"}>
          {status === "validated"
            ? t("status.validatedL")
            : status === "false_positive"
              ? t("status.falseShort")
              : t("status.autoL")}
        </Pill>

        <div className="flex items-center gap-1">
          {/* A verdict button wears its verdict's colour, and only under the
              cursor — at rest the strip is monochrome, the same treatment the
              review table gives the same two verdicts. The important modifier
              is load-bearing: the shared Button already declares a
              `hover:text-ink`, and which of two same-specificity rules wins
              would otherwise depend on Tailwind's emit order. */}
          <Button
            icon="check"
            onClick={onValidate}
            disabled={!canRule}
            title={t("wb.markVerifiedWhy")}
            className="hover:!text-good hover:!border-good"
          >
            {t("rev.verify")}
            <Key>V</Key>
          </Button>
          <Button
            icon="close"
            onClick={onFalse}
            disabled={!canRule}
            title={t("wb.markFalseWhy")}
            className="hover:!text-bad hover:!border-bad"
          >
            {t("rev.false")}
            <Key>X</Key>
          </Button>
          <Button variant="ghost" onClick={onSkip}>
            {t("rev.skip")}
            <Key>␣</Key>
          </Button>
          <Button variant="ghost" onClick={onPrev} title={t("rev.prev")}>
            ←
          </Button>
          <Button variant="ghost" onClick={onNext} title={t("rev.next")}>
            →
          </Button>
        </div>

        <div className="flex-1" />
        {/* The batch PATCH is fire-and-forget by design — a reviewer must not
            wait a round trip per animal — so this is the only signal that
            closing the tab right now would lose something. */}
        {saving && <span className="text-xs text-ink3">{t("wb.saving")}</span>}
        <Button onClick={onExit} title={t("rev.exit")}>
          {t("rev.exit")}
          <Key>Esc</Key>
        </Button>
      </div>

      {/* The two standing hints stay on the footer step — they are always
          true and always there. The two STATE messages next to them are not:
          "this point has no record to write to" and "you have reached the end"
          are things that just became true about this pass, so they sit on the
          label step where the reviewer will actually catch them. Size by what
          a line means, not by which row it happens to be on. */}
      <div className="px-4 pb-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-2xs text-ink3">{t("rev.legend")}</span>
        <span className="text-2xs text-ink3">{t("rev.panOff")}</span>
        {!canRule && <span className="text-xs text-bad">{t("rev.noRecord")}</span>}
        {atEnd && <span className="text-xs text-ink2">{t("rev.endOfPass")}</span>}
      </div>
    </div>
  );
}
