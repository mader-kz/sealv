"use client";
/* Who is at the keyboard.

   Not authentication - there is none, and pretending otherwise would be worse
   than nothing. This is the name that goes into `edit.operator` when somebody
   validates a detection, into `survey.operator` when they file a ground count,
   and into `retired_by` when they withdraw a sortie. It is the difference
   between "43 detections were rejected" and "43 detections were rejected by
   a.n on 6 August", which is the whole of what makes a corrected count
   defensible a year later.

   Nobody having said who they are is a truthful record, and it is the default.
   The client used to send the string "platform" for every edit in the archive -
   a name that identifies no one, dressed as if it identified somebody. `null`
   is the honest value and the API stores it as such.

   Same shape as the language store in lib/i18n.ts: zustand plus localStorage,
   default empty, restored from a client effect so the static export hydrates
   deterministically instead of tearing when the saved value differs. */
import { create } from "zustand";

export const OPERATOR_KEY = "sealv-operator";

/* The service's own cap on `survey.operator` and `retired_by`
   (service/api.py OPERATOR_MAX). Enforced here too, so a name that types fine
   cannot 400 on save. */
export const OPERATOR_MAX = 120;

type OperatorState = { operator: string | null; setOperator: (v: string) => void };

/** Trim, cap, and treat blank as nobody. One place, so the store, the getter
 *  and the restore path can never disagree about what "no operator" is. */
function normalise(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim().slice(0, OPERATOR_MAX);
  return text || null;
}

export const useOperatorStore = create<OperatorState>((set) => ({
  operator: null,
  setOperator: (v) => {
    const operator = normalise(v);
    set({ operator });
    try {
      if (operator) localStorage.setItem(OPERATOR_KEY, operator);
      else localStorage.removeItem(OPERATOR_KEY);
    } catch {
      /* private mode, or storage full - the name still holds for this session */
    }
  },
}));

/** The current operator, or null when nobody has said. Callable outside React
 *  (lib/api.ts reads it on every write) — hence the store's getState, not a
 *  hook. */
export function getOperator(): string | null {
  return useOperatorStore.getState().operator;
}

/** Set it from anywhere. Blank clears it, rather than storing "". */
export function setOperator(v: string): void {
  useOperatorStore.getState().setOperator(v);
}

/** Restore the persisted name. Called once from a client effect (TopBar), for
 *  the reason initLang is: the statically-exported HTML is rendered with the
 *  default, and reading localStorage during render would make the first paint
 *  disagree with the markup React is hydrating against. */
export function initOperator(): void {
  try {
    const saved = normalise(localStorage.getItem(OPERATOR_KEY));
    if (saved) useOperatorStore.setState({ operator: saved });
  } catch {
    /* no storage - the session simply starts anonymous */
  }
}

/** [operator, setOperator] — for the field in the top bar. Components
 *  re-render on a change because the hook subscribes to the store. */
export function useOperator(): [string | null, (v: string) => void] {
  const operator = useOperatorStore((s) => s.operator);
  const set = useOperatorStore((s) => s.setOperator);
  return [operator, set];
}
