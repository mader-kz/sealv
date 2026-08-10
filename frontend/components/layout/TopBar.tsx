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

  /* The instrument's top edge: a hairline, not a bar. Nothing here is a box —
     the wordmark sits on the same 20px gutter as the rail below it, the
     operator is a ruled line, and the language is three plain words. */
  return (
    <div className="h-9 shrink-0 bg-bg border-b border-hair flex items-center px-5 gap-4">
      <div className="flex items-baseline gap-2.5 select-none min-w-0">
        <span className="text-base font-semibold tracking-tight">SEALv</span>
        <span className="text-xs text-ink3 truncate">{t("brand.sub")}</span>
      </div>

      <div className="flex-1" />

      {/* A ruled line, not an input box. The focus widening is kept — it is the
          only way a long name is readable in a 128px slot — but the border no
          longer draws a rectangle round an empty field, and the keyboard focus
          ring from globals.css is no longer suppressed for looks. */}
      <input
        value={operator ?? ""}
        onChange={(e)=> setOperator(e.target.value)}
        maxLength={OPERATOR_MAX}
        placeholder={t("rec.operator.placeholder")}
        aria-label={t("rec.operator.who")}
        title={t("rec.operator.title")}
        className="w-[128px] h-6 bg-transparent border-b border-line px-0 text-xs text-ink placeholder:text-ink4 focus:border-ink2 focus:w-[180px] transition-all"
      />

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
