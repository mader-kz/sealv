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
   a key and not as decoration. */
function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="ml-1 px-1 rounded border border-line text-2xs leading-[14px] text-ink3 font-mono">
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
  const done = total > 0 ? Math.min(100, (index / total) * 100) : 0;

  return (
    <div className="shrink-0 border-b border-line bg-surface2">
      {/* Position in the queue as a line, so progress through 1473 animals is
          readable without arithmetic. */}
      <div className="h-0.5 bg-line-soft">
        <div className="h-full bg-accent transition-[width] duration-150" style={{ width: `${done}%` }} />
      </div>

      <div className="px-4 py-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-xs text-ink tnum" role="status" aria-live="polite">
          {t("rev.progress", { i: index, n: total })}
        </span>
        <span className="text-2xs text-ink3 tnum" title={t("rev.walkAll")}>
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
          <Button icon="check" onClick={onValidate} disabled={!canRule} title={t("wb.markVerifiedWhy")}>
            {t("rev.verify")}
            <Key>V</Key>
          </Button>
          <Button icon="close" onClick={onFalse} disabled={!canRule} title={t("wb.markFalseWhy")}>
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
        {saving && <span className="text-2xs text-ink3">{t("wb.saving")}</span>}
        <Button onClick={onExit} title={t("rev.exit")}>
          {t("rev.exit")}
          <Key>Esc</Key>
        </Button>
      </div>

      <div className="px-4 pb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-2xs text-ink3">{t("rev.legend")}</span>
        <span className="text-2xs text-ink3">{t("rev.panOff")}</span>
        {!canRule && <span className="text-2xs text-bad">{t("rev.noRecord")}</span>}
        {atEnd && <span className="text-2xs text-ink2">{t("rev.endOfPass")}</span>}
      </div>
    </div>
  );
}
