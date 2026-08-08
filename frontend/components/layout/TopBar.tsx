"use client";
import { useEffect } from "react";
import { OPERATOR_MAX } from "@/lib/api";
import { initOperator, useOperator } from "@/lib/identity";
import { LANGS, initLang, useLang, useT, type Lang } from "@/lib/i18n";

/* The switcher shows each language in its own name — these are not
   translated strings, they ARE the languages. Kazakh leads: state
   language first, default first. */
const LANG_LABELS: Record<Lang, string> = { kk: "ҚАЗ", ru: "РУС", en: "ENG" };

export default function TopBar(){
  const { t } = useT();
  const [lang, setLang] = useLang();
  /* Who is at the keyboard. Every verdict, note, correction and ground count
     is stored against this name; until this release the client sent the
     literal string "platform" on every edit, so the service's append-only
     audit log answered "the software did it" for work a person did. An empty
     field sends NULL — an anonymous edit, visibly anonymous, which is a true
     record and the only honest alternative to a name. */
  const [operator, setOperator] = useOperator();

  /* Restore the persisted language AFTER hydration: the exported HTML is
     Kazakh (the default), and switching post-mount avoids a hydration
     mismatch for returning ru/en users. The operator is read from
     localStorage the same way and for the same reason. */
  useEffect(()=>{ initLang(); initOperator(); },[]);

  return (
    <div className="h-11 shrink-0 bg-bg border-b border-line flex items-center px-3 gap-3">
      <div className="flex items-baseline gap-2.5 select-none">
        <span className="text-base font-medium tracking-tight">SEALv</span>
        <span className="text-xs text-ink3">{t("brand.sub")}</span>
      </div>

      <div className="flex-1" />

      <input
        value={operator ?? ""}
        onChange={(e)=> setOperator(e.target.value)}
        maxLength={OPERATOR_MAX}
        placeholder={t("rec.operator.placeholder")}
        aria-label={t("rec.operator.who")}
        title={t("rec.operator.title")}
        className="w-[128px] h-6 bg-surface border border-line rounded px-2 text-2xs text-ink placeholder:text-ink3 focus:outline-none focus:border-ink3 focus:w-[180px] transition-all"
      />

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
    </div>
  );
}
