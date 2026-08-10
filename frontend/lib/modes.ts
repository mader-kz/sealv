/**
 * modes.ts — the five places this instrument can be, and the one channel that
 * moves between them.
 *
 * The old shell had four booleans (list open, analytics open, inspector open,
 * workbench open) and a map that everything else floated over. Two of those
 * booleans could be true at once, one of them stole the column another was
 * rendering into, and the "where am I" question had 16 answers, none of them
 * addressable. This replaces the whole set with a single enum:
 *
 *   map      Карта      the season on the map, one chip per SITE
 *   review   Проверка   the full-screen review workspace
 *   ingest   Загрузка   the ingest experience, at full size
 *   archive  Съёмки     the flat one-line sortie archive
 *   report   Отчёт      period + sites → summary → PDF
 *
 * The mode lives in location.hash, both ways: setMode() pushes a history
 * entry, Back and a hand-typed #review both land in the store. That gives the
 * browser's own Back button a meaning ("the screen I was on"), makes a mode
 * linkable, and survives a reload — all without a router, which matters
 * because this app ships as a static export that has to open from a field
 * laptop's filesystem.
 *
 * Kept deliberately free of React-component imports: the rail, the shell and
 * any mode may import this, and a lib that imported back out of components
 * would make that a cycle.
 */
import { create } from "zustand";
import type { I18nKey } from "./i18n";

export type Mode = "map" | "review" | "ingest" | "archive" | "report";

/** Rail order, and the only place it is written down. */
export const MODE_ORDER: readonly Mode[] = ["map", "review", "ingest", "archive", "report"];

/** The mode a URL with no (or an unreadable) hash means. */
export const DEFAULT_MODE: Mode = "map";

/* The rail's own words. Карта and Съёмки reuse the keys the old nav already
   had — the naming was fixed in the prototype and the dictionary already
   agreed with it, so renaming the keys would have churned three languages to
   say the same thing. */
export const MODE_LABEL_KEY: Record<Mode, I18nKey> = {
  map: "nav.map",
  review: "nav.review",
  ingest: "nav.ingest",
  archive: "nav.footage",
  report: "nav.report",
};

/* Slugs that are not the canonical one but that a link in the wild may carry:
   the prototype's own data-view names, and the transliterated Russian a person
   would guess from the rail. Accepting them costs one lookup and stops a
   shared link from silently dumping somebody on the map. */
const ALIASES: Record<string, Mode> = {
  season: "map",
  karta: "map",
  analytics: "report",
  dashboard: "report",
  statistika: "report",
  proverka: "review",
  field: "ingest",
  zagruzka: "ingest",
  upload: "ingest",
  footage: "archive",
  semki: "archive",
  syomki: "archive",
  sorties: "archive",
  otchet: "report",
  otchyot: "report",
};

const isMode = (s: string): s is Mode => (MODE_ORDER as readonly string[]).includes(s);

/** Read a mode out of a hash. Null — not DEFAULT_MODE — when the hash says
 *  nothing: "no hash" and "hash we could not read" are answered differently at
 *  boot (one is written back, the other is not). */
export function modeFromHash(raw: string | null | undefined): Mode | null {
  const s = String(raw ?? "").replace(/^#/, "").trim().toLowerCase();
  if (!s) return null;
  if (isMode(s)) return s;
  return ALIASES[s] ?? null;
}

/** The canonical hash for a mode. Latin slugs, not Cyrillic: a percent-encoded
 *  `#%D0%9A%D0%B0%D1%80%D1%82%D0%B0` is not a link anybody can read out loud. */
export const hashForMode = (m: Mode): string => `#${m}`;

/* history.pushState throws on a file:// document in some browsers, and this
   app is expected to be opened that way in the field. The mode change must not
   depend on the URL write succeeding — the address bar is the log, not the
   state. */
function writeHash(m: Mode, how: "push" | "replace"): void {
  if (typeof window === "undefined") return;
  const url = `${window.location.pathname}${window.location.search}${hashForMode(m)}`;
  try {
    if (how === "push") window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
  } catch {
    try { window.location.hash = hashForMode(m); } catch {}
  }
}

type ModeState = {
  mode: Mode;
  /** Switch modes and push a history entry. A no-op when already there, so
   *  clicking the rail row you are already on cannot stack up Back steps. */
  setMode: (m: Mode) => void;
};

export const useModeStore = create<ModeState>((set, get) => ({
  mode: DEFAULT_MODE,
  setMode: (m) => {
    if (get().mode === m) return;
    set({ mode: m });
    writeHash(m, "push");
  },
}));

/** Adopt the mode the URL is asking for and keep the two in step. Called once
 *  from a client effect — never during render — because the statically
 *  exported HTML is DEFAULT_MODE and reading location during hydration is how
 *  the markup tears. Returns its own teardown. */
export function initMode(): () => void {
  if (typeof window === "undefined") return () => {};

  const fromUrl = modeFromHash(window.location.hash);
  if (fromUrl) useModeStore.setState({ mode: fromUrl });
  // No hash at all: state the mode we are actually in, without a history entry
  // to go Back to. An unreadable hash is left alone — rewriting the URL out
  // from under a person who typed it hides the typo from them.
  else if (!window.location.hash) writeHash(useModeStore.getState().mode, "replace");

  /* setState, NOT setMode: arriving here means the history already moved.
     Pushing again would make Back walk forward. */
  const sync = () => {
    const m = modeFromHash(window.location.hash) ?? DEFAULT_MODE;
    if (useModeStore.getState().mode !== m) useModeStore.setState({ mode: m });
  };
  window.addEventListener("popstate", sync);
  window.addEventListener("hashchange", sync);
  return () => {
    window.removeEventListener("popstate", sync);
    window.removeEventListener("hashchange", sync);
  };
}

/** `const [mode, setMode] = useMode()` — the hook every screen uses. */
export function useMode(): [Mode, (m: Mode) => void] {
  const mode = useModeStore((s) => s.mode);
  const set = useModeStore((s) => s.setMode);
  return [mode, set];
}

/** Just the current mode, for a component that never switches. */
export const useCurrentMode = (): Mode => useModeStore((s) => s.mode);

/** Switch modes from outside React — an event handler on `document`, a store
 *  action, a timer. Same function the hook hands back. */
export function setMode(m: Mode): void {
  useModeStore.getState().setMode(m);
}

/** The current mode without subscribing. For code that reads it inside an
 *  event handler and would otherwise need a ref to stay fresh. */
export const currentMode = (): Mode => useModeStore.getState().mode;
