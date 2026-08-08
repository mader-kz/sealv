"use client";
import Icon, { type IconName } from "./Icon";

/* Shared controls. Every button/label/stat in the app comes from here so the
   visual language can't drift again. */

type BtnVariant = "primary" | "default" | "ghost";

export function Button({
  children,
  onClick,
  variant = "default",
  icon,
  disabled,
  title,
  className = "",
  full,
}: {
  children?: React.ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  variant?: BtnVariant;
  icon?: IconName;
  disabled?: boolean;
  title?: string;
  className?: string;
  full?: boolean;
}) {
  const base =
    "h-7 inline-flex items-center justify-center gap-1.5 px-2.5 rounded text-xs transition-colors disabled:opacity-40 disabled:pointer-events-none";
  const variants: Record<BtnVariant, string> = {
    primary: "bg-ink text-bg hover:bg-white font-medium",
    default: "bg-surface2 text-ink2 border border-line hover:text-ink hover:border-ink3",
    ghost: "text-ink3 hover:text-ink hover:bg-surface2",
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${base} ${variants[variant]} ${full ? "w-full" : ""} ${className}`}
    >
      {icon && <Icon name={icon} size={13} />}
      {children}
    </button>
  );
}

export function IconButton({
  name,
  onClick,
  title,
  active,
  className = "",
}: {
  name: IconName;
  onClick?: () => void;
  title?: string;
  active?: boolean;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`w-7 h-7 grid place-items-center rounded transition-colors ${
        active ? "text-ink bg-surface2" : "text-ink3 hover:text-ink hover:bg-surface2"
      } ${className}`}
    >
      <Icon name={name} size={14} />
    </button>
  );
}

/** Section header — the only place uppercase tracking is allowed. */
export function SectionHead({
  title,
  right,
  className = "",
}: {
  title: string;
  right?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-center justify-between gap-2 ${className}`}>
      <span className="label">{title}</span>
      {right}
    </div>
  );
}

/** A number that matters. Figure first, label under it, no box. */
export function Stat({
  label,
  value,
  sub,
  size = "md",
}: {
  label: string;
  value: string | number;
  sub?: string;
  size?: "md" | "lg";
}) {
  return (
    <div className="min-w-0">
      <div
        className={`tnum font-medium text-ink leading-none truncate ${
          size === "lg" ? "text-hero" : "text-fig"
        }`}
      >
        {value}
      </div>
      <div className="label mt-1.5 truncate">{label}</div>
      {sub && <div className="text-2xs text-ink3 mt-1 truncate">{sub}</div>}
    </div>
  );
}

/** Quiet card. One border, one background, no tint stacking. */
export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded border border-line-soft bg-surface p-3 ${className}`}>{children}</div>
  );
}

/** Neutral status pill. Color only for genuine states, never decoration. */
export function Pill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "accent" | "good" | "bad";
}) {
  const tones = {
    neutral: "text-ink3 border-line",
    accent: "text-accent border-accent/30",
    good: "text-good border-good/30",
    bad: "text-bad border-bad/30",
  };
  return (
    <span className={`text-2xs px-1.5 py-0.5 rounded border leading-none ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function Field({
  value,
  onChange,
  placeholder,
  icon,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  icon?: IconName;
}) {
  return (
    <div className="relative flex-1">
      {icon && (
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink3 pointer-events-none">
          <Icon name={icon} size={13} />
        </span>
      )}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full h-7 bg-surface2 border border-line rounded ${
          icon ? "pl-7" : "pl-2.5"
        } pr-2.5 text-sm placeholder:text-ink3 focus:outline-none focus:border-ink3 transition-colors`}
      />
    </div>
  );
}

/** Label/value row used in the inspector. Aligned columns, no boxes-in-boxes. */
export function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-3 py-1.5 border-b border-line-soft last:border-0">
      {/* 96px, not 76: ru/kk labels (Длительность, Координаттар) need the
          extra column width — a fixed 76px clipped them mid-word. */}
      <span className="text-xs text-ink3 w-[96px] shrink-0">{label}</span>
      <span className={`text-sm text-ink truncate ${mono ? "font-mono tnum" : ""}`}>{value}</span>
    </div>
  );
}
