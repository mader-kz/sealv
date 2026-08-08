"use client";
import { useEffect } from "react";
import Icon from "@/components/ui/Icon";
import { LANGS, initLang, useLang, useT, type Lang } from "@/lib/i18n";

/* The switcher shows each language in its own name — these are not
   translated strings, they ARE the languages. Kazakh leads: state
   language first, default first. */
const LANG_LABELS: Record<Lang, string> = { kk: "ҚАЗ", ru: "РУС", en: "ENG" };

export default function TopBar({ onCmdK }: { onCmdK: ()=>void }){
  const { t } = useT();
  const [lang, setLang] = useLang();

  /* Restore the persisted language AFTER hydration: the exported HTML is
     Kazakh (the default), and switching post-mount avoids a hydration
     mismatch for returning ru/en users. */
  useEffect(()=>{ initLang(); },[]);

  return (
    <div className="h-11 shrink-0 bg-bg border-b border-line flex items-center px-3 gap-3">
      <div className="flex items-baseline gap-2.5 select-none">
        <span className="text-base font-medium tracking-tight">SEALv</span>
        <span className="text-xs text-ink3">{t("brand.sub")}</span>
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-0.5 bg-surface border border-line rounded p-0.5">
        {LANGS.map(l=>(
          <button
            key={l}
            onClick={()=> setLang(l)}
            aria-pressed={lang===l}
            className={`px-1.5 h-6 rounded text-2xs tracking-wide transition-colors ${
              lang===l ? "bg-surface2 text-ink" : "text-ink3 hover:text-ink2"
            }`}
          >
            {LANG_LABELS[l]}
          </button>
        ))}
      </div>

      <button
        onClick={onCmdK}
        className="hidden sm:flex items-center gap-2 h-7 bg-surface border border-line rounded pl-2.5 pr-1.5 text-xs text-ink3 hover:text-ink2 hover:border-ink3 transition-colors"
      >
        <Icon name="search" size={13} />
        <span>{t("topbar.search")}</span>
        <kbd className="font-mono text-2xs text-ink3 border border-line rounded px-1 py-0.5 leading-none ml-4">⌘K</kbd>
      </button>
    </div>
  );
}
