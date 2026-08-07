"use client";
import Icon from "@/components/ui/Icon";

export default function TopBar({ onCmdK }: { onCmdK: ()=>void }){
  return (
    <div className="h-11 shrink-0 bg-bg border-b border-line flex items-center px-3 gap-3">
      <div className="flex items-baseline gap-2.5 select-none">
        <span className="text-base font-medium tracking-tight">SEALv</span>
        <span className="text-xs text-ink3">Caspian seal survey</span>
      </div>

      <div className="flex-1" />

      <button
        onClick={onCmdK}
        className="hidden sm:flex items-center gap-2 h-7 bg-surface border border-line rounded pl-2.5 pr-1.5 text-xs text-ink3 hover:text-ink2 hover:border-ink3 transition-colors"
      >
        <Icon name="search" size={13} />
        <span>Search</span>
        <kbd className="font-mono text-2xs text-ink3 border border-line rounded px-1 py-0.5 leading-none ml-4">⌘K</kbd>
      </button>
    </div>
  );
}
