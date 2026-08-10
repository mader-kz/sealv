"use client";
import Icon, { type IconName } from "./Icon";

/* Shared controls. Every button/label/stat in the app comes from here so the
   visual language can't drift again.

   Direction «Прибор»: flat, square, near-monochrome. Structure comes from
   alignment and hairlines — no filled panels, no pills, no small-caps
   micro-labels, no decorative meters. The one signal colour (--accent) is
   spent on standing-estimate figures and live/primary states only. */

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
  /* Square, hairline-bordered, no fill at rest. A disabled control greys to
     the decorative step instead of going translucent: at 40% opacity over a
     near-black background the label stopped being legible at all, which reads
     as "missing" rather than "not available yet". */
  const base =
    "h-7 inline-flex items-center justify-center gap-2 px-3 text-sm transition-colors " +
    "disabled:pointer-events-none disabled:text-ink4 disabled:border-hair";
  const variants: Record<BtnVariant, string> = {
    // The only place a button is allowed the signal colour.
    primary: "border border-accent text-accent hover:bg-accent hover:text-accent-ink",
    default: "border border-line text-ink2 hover:bg-surface2 hover:text-ink hover:border-ink4",
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
      className={`w-7 h-7 grid place-items-center transition-colors ${
        active ? "text-ink bg-surface2" : "text-ink3 hover:text-ink hover:bg-surface2"
      } ${className}`}
    >
      <Icon name={name} size={14} />
    </button>
  );
}

/** Section header. Plain case, carried by weight — never letter-spaced caps. */
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
      <span className="hd">{title}</span>
      {right}
    </div>
  );
}

/** A number that matters. Large, quiet, tabular; a small plain-case label
    under it, or none at all when the figure speaks for itself. */
export function Stat({
  label,
  value,
  sub,
  size = "md",
  tone = "ink",
}: {
  /* Optional on purpose: a figure whose meaning is obvious from where it sits
     does not need a word repeating it. */
  label?: string;
  value: string | number;
  sub?: string;
  size?: "md" | "lg";
  /* `accent` is the standing estimate — the figure the survey stands behind.
     Everything else stays ink; the signal colour is not for emphasis. */
  tone?: "ink" | "accent";
}) {
  return (
    <div className="min-w-0">
      {/* The VALUE truncates too, and it is the one thing on the panel that
          must never be guessable: "1…" where the season counted 1175. It still
          clips when the column is too narrow, but the full figure is one hover
          away instead of gone. */}
      <div
        className={`tnum font-medium leading-none truncate ${
          size === "lg" ? "text-hero" : "text-fig"
        } ${tone === "accent" ? "text-accent" : "text-ink"}`}
        title={String(value)}
      >
        {value}
      </div>
      {label && <div className="label mt-2 truncate">{label}</div>}
      {/* The sub-line is where a figure's qualification lives ("5 sorties rest
          on an assumed scale"), so a narrow column must not be the only place
          it exists. It used to truncate to ONE line and rely on a hover title,
          which on today's data clipped "…rest on an assumed scale, not a
          measured one" to "…assumed sca" — the whole caveat behind a hover
          nobody performs, next to a hectare figure that is entirely built on
          it. It wraps to three lines now and still carries the title. */}
      {sub && <div className="text-xs text-ink3 mt-1 leading-tight line-clamp-3" title={sub}>{sub}</div>}
    </div>
  );
}

/** A block of content. A hairline above it and its own alignment — the
    rounded grey panel is gone, it was drawing a box around nothing. */
export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`border-t border-hair pt-3.5 pb-1 ${className}`}>{children}</div>;
}

/** A quiet inline marker. Reads as a word next to the thing it qualifies, not
    as a chip: no border, no fill, no capsule. Colour only where it is a real
    verdict — `good`/`bad` are semantic, `accent` is the old amber "worth
    noticing" and resolves to italic ink, because the signal colour belongs to
    the figures and to live states, not to labels. */
export function Pill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "accent" | "good" | "bad";
}) {
  const tones = {
    neutral: "text-ink3",
    accent: "italic text-ink2",
    good: "text-good",
    bad: "text-bad",
  };
  return <span className={`text-xs leading-none ${tones[tone]}`}>{children}</span>;
}

/** The one place a monospace face survives: run and survey id hashes, where
    comparing character by character is the actual task. */
export function Hash({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <span className={`hash text-ink3 ${className}`}>{children}</span>;
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
        <span className="absolute left-0 top-1/2 -translate-y-1/2 text-ink4 pointer-events-none">
          <Icon name={icon} size={13} />
        </span>
      )}
      {/* A ruled line, not a box. No `focus:outline-none` here: pointer focus
          is shown by the rule going bright, and the keyboard focus ring from
          globals.css is left intact rather than suppressed for looks. */}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full h-7 bg-transparent border-b border-line ${
          icon ? "pl-5" : "pl-0"
        } pr-0 text-base placeholder:text-ink4 focus:border-ink2 transition-colors`}
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
  /* Kept for the call sites, but it no longer means a typewriter face —
     filenames, coordinates, durations and timestamps are Inter now. What the
     flag still buys is what it was actually for: tabular figures, so a column
     of values lines up. Use <Hash> when the string really is an id. */
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-4 py-1.5 border-b border-hair last:border-0">
      {/* 96px, not 76: ru/kk labels (Длительность, Координаттар) need the
          extra column width — a fixed 76px clipped them mid-word. */}
      <span className="text-xs text-ink3 w-[96px] shrink-0">{label}</span>
      {/* Same rule as Stat: a truncated coordinate or filename with no way to
          read the rest is a value the panel is not actually reporting. */}
      <span
        className={`text-sm text-ink truncate ${mono ? "tnum" : ""}`}
        title={typeof value === "string" || typeof value === "number" ? String(value) : undefined}
      >
        {value}
      </span>
    </div>
  );
}
