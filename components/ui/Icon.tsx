"use client";

/**
 * One icon set, one stroke weight. Replaces the glyph soup (◈ ▦ ◐ ≡ ⌕ ✕ ＋)
 * that rendered at different optical weights in every font fallback.
 */

export type IconName =
  | "map"
  | "table"
  | "chart"
  | "list"
  | "search"
  | "close"
  | "plus"
  | "upload"
  | "download"
  | "pin"
  | "layers"
  | "target"
  | "chevronLeft"
  | "chevronRight"
  | "check"
  | "alert"
  | "copy"
  | "trash";

const paths: Record<IconName, React.ReactNode> = {
  map: <><path d="M2 4.5 6 3l4 1.5L14 3v8.5L10 13 6 11.5 2 13z" /><path d="M6 3v8.5M10 4.5V13" /></>,
  table: <><rect x="2" y="3" width="12" height="10" rx="1" /><path d="M2 6.5h12M6.5 6.5V13" /></>,
  chart: <><path d="M2.5 13V9M6.5 13V4M10.5 13V7M14 13V2.5" /></>,
  list: <><path d="M2.5 4h11M2.5 8h11M2.5 12h7" /></>,
  search: <><circle cx="7.2" cy="7.2" r="4.2" /><path d="m10.4 10.4 3 3" /></>,
  close: <><path d="m4 4 8 8M12 4l-8 8" /></>,
  plus: <><path d="M8 3.5v9M3.5 8h9" /></>,
  upload: <><path d="M8 11V3M5 6l3-3 3 3" /><path d="M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2" /></>,
  download: <><path d="M8 3v8M5 8l3 3 3-3" /><path d="M2.5 12.5h11" /></>,
  pin: <><path d="M8 14s4.5-4.2 4.5-7.5a4.5 4.5 0 1 0-9 0C3.5 9.8 8 14 8 14z" /><circle cx="8" cy="6.5" r="1.6" /></>,
  layers: <><path d="m8 2 6 3-6 3-6-3z" /><path d="m2 8.5 6 3 6-3" /></>,
  target: <><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="1.5" /></>,
  chevronLeft: <><path d="m9.5 3.5-5 4.5 5 4.5" /></>,
  chevronRight: <><path d="m6.5 3.5 5 4.5-5 4.5" /></>,
  check: <><path d="m3 8.5 3.2 3L13 4.5" /></>,
  alert: <><path d="M8 2.5 14.5 13.5h-13z" /><path d="M8 6.5v3M8 11.6v.01" /></>,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1" /><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></>,
  trash: <><path d="M3 4.5h10M6.5 4.5v-1a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1" /><path d="M4.5 4.5 5 13a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-8.5" /></>,
};

export default function Icon({
  name,
  size = 14,
  className = "",
  strokeWidth = 1.3,
}: {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
