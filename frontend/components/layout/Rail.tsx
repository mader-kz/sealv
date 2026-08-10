"use client";
import { useEffect, useState } from "react";
import Icon, { type IconName } from "@/components/ui/Icon";
import { useT } from "@/lib/i18n";
import pkg from "@/package.json";

/* Icons alone don't explain themselves to a first-time user, so the rail
   expands into icon+label rows. The preference persists; the default stays
   compact so the map keeps the space. */
const STORAGE_KEY = "sealv-rail-open";

export default function Rail({ onWorkbench, onToggleLeft, onToggleAnalytics, leftOpen, rightAnalytics }: { onWorkbench?: ()=>void; onToggleLeft?: ()=>void; onToggleAnalytics?: ()=>void; leftOpen?: boolean; rightAnalytics?: boolean }){
  const { t } = useT();
  const [open, setOpen] = useState(false);
  /* restore after mount — the static export must hydrate deterministically */
  useEffect(()=>{ try { if (localStorage.getItem(STORAGE_KEY) === "1") setOpen(true); } catch {} }, []);
  const toggle = ()=> setOpen(o=>{ const v = !o; try { localStorage.setItem(STORAGE_KEY, v ? "1" : "0"); } catch {} return v; });

  const items: { icon: IconName; label: string; active: boolean; onClick?: ()=>void }[] = [
    { icon: "map", label: t("nav.map"), active: true },
    { icon: "list", label: t("nav.footage"), active: !!leftOpen, onClick: onToggleLeft },
    { icon: "chart", label: t("nav.analytics"), active: !!rightAnalytics, onClick: onToggleAnalytics },
    { icon: "table", label: t("nav.detections"), active: false, onClick: onWorkbench },
  ];

  /* A row is a line of text on the rail's own gutter, not a filled tab. The
     one you are on is stated three ways at once — full ink, the icon at full
     strength, and a 2px rule on the rail's edge — and none of them is the
     signal colour: green here is the standing estimate, not "you clicked
     this". No hover fill either; the colour step is the hover. */
  const row = (active?: boolean) =>
    `relative h-8 flex items-center transition-colors shrink-0 ${
      open ? "px-5 gap-2.5 justify-start" : "w-8 mx-auto justify-center"
    } ${active ? "text-ink" : "text-ink3 hover:text-ink2"}`;

  return (
    <div className={`${open ? "w-44" : "w-12"} shrink-0 bg-bg border-r border-hair flex flex-col py-3 overflow-hidden transition-[width] duration-150`}>
      {items.map(it=>(
        <button
          key={it.icon}
          onClick={it.onClick}
          title={open ? undefined : it.label}
          aria-label={it.label}
          className={row(it.active)}
        >
          {it.active && <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-ink" />}
          <Icon name={it.icon} size={15} className={`shrink-0 ${it.active ? "" : "opacity-50"}`} />
          {open && <span className="text-base truncate">{it.label}</span>}
        </button>
      ))}

      <div className="flex-1" />

      <button
        onClick={toggle}
        title={open ? t("rail.collapse") : t("rail.expand")}
        aria-label={open ? t("rail.collapse") : t("rail.expand")}
        aria-expanded={open}
        className={row(false)}
      >
        <Icon name={open ? "chevronLeft" : "chevronRight"} size={15} className="shrink-0 opacity-50" />
        {open && <span className="text-base truncate">{t("rail.collapse")}</span>}
      </button>

      {/* single source of truth: package.json, gated against the git tag at release */}
      {/* nowrap: collapsed, the rule is 40px wide and "v0.3.0" is ~34 — one
          more digit in the version and it would break across two lines inside
          an `overflow-hidden` rail, i.e. disappear. */}
      <span className={`text-2xs text-ink3 tnum whitespace-nowrap mt-3 pt-2.5 shrink-0 border-t border-hair ${open ? "mx-5" : "mx-1 text-center"}`}>v{pkg.version}</span>
    </div>
  );
}
