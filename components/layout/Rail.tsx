"use client";
import Icon, { type IconName } from "@/components/ui/Icon";

export default function Rail({ onWorkbench, onToggleLeft, onToggleAnalytics, leftOpen, rightAnalytics }: { onWorkbench?: ()=>void; onToggleLeft?: ()=>void; onToggleAnalytics?: ()=>void; leftOpen?: boolean; rightAnalytics?: boolean }){
  const items: { icon: IconName; label: string; active: boolean; onClick?: ()=>void }[] = [
    { icon: "map", label: "Map", active: true },
    { icon: "list", label: "Footage", active: !!leftOpen, onClick: onToggleLeft },
    { icon: "chart", label: "Analytics", active: !!rightAnalytics, onClick: onToggleAnalytics },
    { icon: "table", label: "Detections", active: false, onClick: onWorkbench },
  ];
  return (
    <div className="w-12 shrink-0 bg-bg border-r border-line flex flex-col items-center py-2 gap-0.5">
      {items.map(it=>(
        <button
          key={it.label}
          onClick={it.onClick}
          title={it.label}
          aria-label={it.label}
          className={`relative w-9 h-9 rounded grid place-items-center transition-colors ${
            it.active ? "text-ink bg-surface2" : "text-ink3 hover:text-ink2 hover:bg-surface"
          }`}
        >
          {it.active && <span className="absolute left-0 top-2 bottom-2 w-px bg-accent" />}
          <Icon name={it.icon} size={16} />
        </button>
      ))}
      <div className="flex-1" />
      <span className="text-2xs text-ink3 pb-1">v0.1</span>
    </div>
  );
}
