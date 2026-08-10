"use client";
/* Field notes — the thing a count cannot say.
 *
 * "1014 animals" is the whole of what the engine knows about a sortie. It does
 * not know that a boat went through at 09:40, that half the haul-out was under
 * ice, or that the pilot flew the second pass lower because the first was
 * blurred. Those are the facts that make a number interpretable a year later,
 * and until this component there was nowhere in the product to put them —
 * which is why the ecologist named it as the gap.
 *
 * Three rules the implementation is built around:
 *
 *   1. It is DATA, not markup. The note is rendered as the value of a
 *      <textarea> and, everywhere else, as a text node. No markdown, no
 *      dangerouslySetInnerHTML, ever — an operator typing <script> into a
 *      field note must produce a field note that says "<script>".
 *   2. It says whether it saved. A note that looks written and is not stored
 *      is worse than no notes field at all, so the four states (saved,
 *      saving, not saved yet, could not save) are all rendered, in the same
 *      vocabulary the detection pills use for an unsaved verdict.
 *   3. The cap is enforced here, before the request. The column's limit is
 *      NOTES_MAX; a note the service would silently truncate is a note the
 *      author believes they wrote in full.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { NOTES_MAX } from "@/lib/api";
import { useT } from "@/lib/i18n";
import type { Footage } from "@/lib/types";
import { useFootageStore } from "@/store/useFootageStore";
import { SectionHead } from "@/components/ui/primitives";

/** Quiet debounce. Long enough that ordinary typing is one request, short
 *  enough that the reviewer sees "saved" before they look away. */
const DEBOUNCE_MS = 600;
/** Characters left at which the counter starts warning. */
const NEAR_CAP = 200;

export default function SortieNotes({ f }: { f: Footage }) {
  const { t } = useT();
  const saveNotes = useFootageStore((s) => s.saveNotes);
  const markNotesDirty = useFootageStore((s) => s.markNotesDirty);
  const state = useFootageStore((s) => s.notesState[f.id]);

  const stored = f.notes ?? "";
  const [text, setText] = useState(stored);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* The last value handed to the store. Read by the flush-on-unmount path,
     which runs after the component has stopped re-rendering. */
  const pending = useRef<string | null>(null);
  const save = useRef(saveNotes);
  save.current = saveNotes;
  const idRef = useRef(f.id);

  /* A different sortie is a different note. */
  useEffect(() => {
    idRef.current = f.id;
    setText(stored);
    pending.current = null;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    // `stored` is read for the initial value only — see the effect below for
    // why adopting later changes to it is conditional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.id]);

  /* The archive changed this note under us — a save landing, a hydrate, work
     from another tab. Adopted ONLY when nothing is pending: a save takes a
     round trip, and an operator who kept typing while it flew must not have
     their sentence replaced by the shorter one that just came back. The
     debounce timer is still holding the newer text and will save it. */
  useEffect(() => {
    if (pending.current !== null) return;
    setText(stored);
  }, [stored]);

  const flush = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const body = pending.current;
    if (body === null) return;
    pending.current = null;
    void save.current(idRef.current, body);
  }, []);

  /* Leaving the panel must not eat the sentence that was still in the debounce
     window. Switching sorties unmounts this component, so the flush belongs to
     the cleanup rather than to a blur handler on the textarea. */
  useEffect(() => flush, [flush]);

  const onChange = (v: string) => {
    /* Hard stop at the cap in the buffer as well as on the element: maxLength
       does not apply to a paste in every browser, and the store refuses an
       over-long note anyway — better to never build one. */
    const next = v.length > NOTES_MAX ? v.slice(0, NOTES_MAX) : v;
    setText(next);
    if (next === (f.notes ?? "")) {
      /* Typed back to what is already stored. Nothing to save, and claiming
         "not saved yet" over an unchanged note would be a false alarm. */
      pending.current = null;
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      return;
    }
    pending.current = next;
    markNotesDirty(f.id);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, DEBOUNCE_MS);
  };

  const left = NOTES_MAX - text.length;
  const status =
    state === "saving" ? { text: t("rec.notes.saving"), tone: "text-ink3" }
    : state === "unsaved" ? { text: t("rec.notes.unsaved"), tone: "text-ink3" }
    : state === "error" ? { text: t("rec.notes.error"), tone: "text-bad" }
    : state === "saved" ? { text: t("rec.notes.saved"), tone: "text-good" }
    : null;

  return (
    <div className="px-4 py-3 border-b border-line">
      <SectionHead
        title={t("rec.notes.title")}
        className="mb-1.5"
        right={
          /* Running out of room is not a live state and not a failure, so it
             steps UP the neutral ramp rather than reaching for a colour: the
             counter goes from quiet to plain the moment it starts to matter. */
          <span className={`text-2xs tnum ${left <= NEAR_CAP ? "text-ink" : "text-ink3"}`}>
            {t("rec.notes.count", { n: text.length, max: NOTES_MAX })}
          </span>
        }
      />
      <textarea
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onBlur={flush}
        maxLength={NOTES_MAX}
        rows={4}
        spellCheck={false}
        placeholder={t("rec.notes.placeholder")}
        aria-label={t("rec.notes.title")}
        /* Ruled, not boxed — and ruled on all four sides would be a box, so it
           is one line under the writing, the way a field notebook is ruled. */
        className="w-full bg-transparent border-0 border-b border-line px-0 py-2 text-sm leading-relaxed text-ink placeholder:text-ink4 focus:border-ink2 transition-colors resize-y min-h-[72px]"
      />
      <div className="flex items-baseline justify-between gap-2 mt-1">
        {/* Attribution, and only the attribution the data supports. The survey
            row has ONE operator column — whoever the sortie is recorded to —
            so this says "attributed to", not "written by": the store fills the
            column when it is empty and never overwrites a name already on it. */}
        <span className="text-2xs text-ink3 truncate">
          {f.operator
            ? t("rec.notes.by", { who: f.operator })
            : t("rec.notes.byNobody")}
        </span>
        {status && (
          <span className={`text-2xs shrink-0 ${status.tone}`} role="status" aria-live="polite">
            {status.text}
            {state === "error" && (
              <button
                onClick={() => void saveNotes(f.id, text)}
                className="ml-1.5 underline hover:text-ink transition-colors"
              >
                {t("rec.notes.retry")}
              </button>
            )}
          </span>
        )}
      </div>
      {!f.surveyId && (
        <p className="text-2xs text-ink3 mt-1.5 leading-relaxed">{t("rec.notes.noSurvey")}</p>
      )}
    </div>
  );
}
