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

  const row = (active?: boolean) =>
    `relative h-9 rounded flex items-center transition-colors shrink-0 ${
      open ? "mx-1.5 px-2.5 gap-2.5 justify-start" : "w-9 mx-auto justify-center"
    } ${active ? "text-ink bg-surface2" : "text-ink3 hover:text-ink2 hover:bg-surface"}`;

  return (
    <div className={`${open ? "w-44" : "w-12"} shrink-0 bg-bg border-r border-line flex flex-col py-2 gap-0.5 overflow-hidden transition-[width] duration-150`}>
      {items.map(it=>(
        <button
          key={it.icon}
          onClick={it.onClick}
          title={open ? undefined : it.label}
          aria-label={it.label}
          className={row(it.active)}
        >
          {it.active && <span className="absolute left-0 top-2 bottom-2 w-px bg-accent" />}
          <Icon name={it.icon} size={16} className="shrink-0" />
          {open && <span className="text-sm truncate">{it.label}</span>}
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
        <Icon name={open ? "chevronLeft" : "chevronRight"} size={16} className="shrink-0" />
        {open && <span className="text-sm truncate">{t("rail.collapse")}</span>}
      </button>

      {/* single source of truth: package.json, gated against the git tag at release */}
      <span className={`text-2xs text-ink3 pt-1 pb-0.5 shrink-0 ${open ? "px-4" : "text-center"}`}>v{pkg.version}</span>
    </div>
  );
}
