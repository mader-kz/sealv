/* Trilingual UI: Kazakh is the default (the state language — this is a
   Kazakhstani Caspian product), Russian is the working language of the
   sector, English is the record. Terminology is shared with the webapp
   half of the product (итбалық = seal, ұшу = sortie, жатақ = haul-out,
   аралық = range), so the two halves speak one language.

   The dictionary lives in i18n.dict.json — JSON, not TS, so
   scripts/check-i18n.mjs can parse it as data and fail on any drift
   between the three languages. Keys are typed off the English table:
   a typo in a component is a compile error, not a silent fallback. */
import { useMemo } from "react";
import { create } from "zustand";
import dict from "./i18n.dict.json";

export type Lang = keyof typeof dict; // "kk" | "ru" | "en"
export type I18nKey = keyof (typeof dict)["en"];

export const LANGS: readonly Lang[] = ["kk", "ru", "en"];
const DEFAULT_LANG: Lang = "kk";
const STORAGE_KEY = "sealv-lang";

type Vars = Record<string, string | number>;

type LangState = { lang: Lang; setLang: (lang: Lang) => void };

export const useLangStore = create<LangState>((set) => ({
  lang: DEFAULT_LANG,
  setLang: (lang) => {
    set({ lang });
    try { localStorage.setItem(STORAGE_KEY, lang); } catch {}
    if (typeof document !== "undefined") document.documentElement.lang = lang;
  },
}));

/** Restore the persisted language. Called from a client effect (TopBar) so
 *  the statically-exported HTML hydrates as Kazakh — the default — and only
 *  then switches, instead of tearing during hydration. */
export function initLang() {
  try {
    const requested = new URLSearchParams(window.location.search).get("lang");
    if (requested && (LANGS as readonly string[]).includes(requested)) {
      useLangStore.getState().setLang(requested as Lang);
      return;
    }
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && (LANGS as readonly string[]).includes(saved)) {
      useLangStore.setState({ lang: saved as Lang });
    }
  } catch {}
  if (typeof document !== "undefined") {
    document.documentElement.lang = useLangStore.getState().lang;
  }
}

/** Translate. Falls back to English, then to the key itself, so a missing
 *  string is visible in review rather than rendering as blank. */
export function translate(lang: Lang, key: I18nKey, vars?: Vars): string {
  const table = dict[lang] as Record<string, string>;
  let s = table[key] ?? (dict.en as Record<string, string>)[key] ?? key;
  if (vars) {
    for (const k of Object.keys(vars)) s = s.split(`{${k}}`).join(String(vars[k]));
  }
  return s;
}

/* Russian declines nouns after numerals (1/2–4/5+, forms joined by "|");
   Kazakh nouns do not inflect after a numeral at all, so Kazakh keys hold a
   single form and pass through untouched. English keys hold "one|many". */
export function plural(lang: Lang, n: number, key: I18nKey): string {
  const forms = translate(lang, key).split("|");
  if (forms.length === 1) return forms[0];
  if (lang !== "ru") return forms[n === 1 ? 0 : forms.length - 1];
  const a = Math.abs(n ?? 0) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[forms.length - 1];
  if (b === 1) return forms[0];
  if (b >= 2 && b <= 4) return forms[1] ?? forms[forms.length - 1];
  return forms[forms.length - 1];
}

/** The engine's `basis` arrives as a machine word (union_4_frames). Render it
 *  through the dictionary; the raw value is the fallback, so a new server-side
 *  enum degrades to visible-but-ugly rather than to a lie. */
export function basisText(lang: Lang, basis: string): string {
  let m: RegExpMatchArray | null;
  if ((m = basis.match(/^union_(\d+)_frames$/))) return translate(lang, "basis.union", { n: m[1] });
  if ((m = basis.match(/^consensus_(\d+)_frames$/))) return translate(lang, "basis.consensus", { n: m[1] });
  if ((m = basis.match(/^single_image_(\d+)_of_(\d+)_tiles$/)))
    return translate(lang, "basis.singleTiles", { n: m[1], total: m[2] });
  if (basis === "single_image") return translate(lang, "basis.single");
  return basis.replace(/_/g, " ");
}

/** Job stages are machine words too (sampling, detect, …). */
export function stageText(lang: Lang, stage: string | null | undefined): string {
  if (!stage) return translate(lang, "stage.working");
  const key = `stage.${stage}` as I18nKey;
  const s = translate(lang, key);
  return s === key ? String(stage) : s;
}

/** BCP-47 locale for Intl date/month formatting in the current language. */
export function localeFor(lang: Lang): string {
  return lang === "kk" ? "kk-KZ" : lang === "ru" ? "ru-RU" : "en";
}

/** [lang, setLang] — for the switcher. */
export function useLang(): [Lang, (lang: Lang) => void] {
  const lang = useLangStore((s) => s.lang);
  const setLang = useLangStore((s) => s.setLang);
  return [lang, setLang];
}

/** The translator bound to the current language. Components re-render on a
 *  language switch because the hook subscribes to the store. */
export function useT() {
  const lang = useLangStore((s) => s.lang);
  return useMemo(
    () => ({
      lang,
      t: (key: I18nKey, vars?: Vars) => translate(lang, key, vars),
      tp: (n: number, key: I18nKey) => plural(lang, n, key),
    }),
    [lang],
  );
}
