"use client";
import { useEffect } from "react";
import { initOperator } from "@/lib/identity";
import { LANGS, initLang, useLang, useT, type Lang } from "@/lib/i18n";

/* The switcher shows each language in its own name — these are not
   translated strings, they ARE the languages. Kazakh leads: state
   language first, default first. */
const LANG_LABELS: Record<Lang, string> = { kk: "ҚАЗ", ru: "РУС", en: "ENG" };

export default function TopBar(){
  const { t } = useT();
  const [lang, setLang] = useLang();
  /* Restore the persisted language AFTER hydration: the exported HTML is
     Kazakh (the default), and switching post-mount avoids a hydration
     mismatch for returning ru/en users. */
  useEffect(()=>{ initLang(); initOperator(); },[]);

  /* The instrument's top edge: a hairline, not a bar. Nothing here is a box —
     the wordmark sits on the same 20px gutter as the rail below it, and the
     language is three plain words. */
  return (
    <div className="h-9 shrink-0 bg-bg border-b border-hair flex items-center px-5 gap-4">
      <div className="flex items-baseline gap-2.5 select-none min-w-0">
        <span className="text-base font-semibold tracking-tight">SEALv</span>
        <span className="text-xs text-ink3 truncate">{t("brand.sub")}</span>
      </div>

      <div className="flex-1" />

      {/* Three words, not a segmented capsule. The current language is the one
          in full ink with a rule under it — the same marker the rail and the
          list rows use for "this is the one you are on". */}
      <div className="flex items-baseline gap-3 shrink-0">
        {LANGS.map(l=>(
          <button
            key={l}
            onClick={()=> setLang(l)}
            aria-pressed={lang===l}
            className={`text-2xs pb-0.5 border-b transition-colors ${
              lang===l ? "text-ink border-ink" : "text-ink3 border-transparent hover:text-ink2"
            }`}
          >
            {LANG_LABELS[l]}
          </button>
        ))}
      </div>
    </div>
  );
}
