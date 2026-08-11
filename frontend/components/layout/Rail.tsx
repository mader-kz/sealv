"use client";
import { useEffect, useMemo, useState } from "react";
import Icon, { type IconName } from "@/components/ui/Icon";
import { useT } from "@/lib/i18n";
import { MODE_LABEL_KEY, MODE_ORDER, useMode, type Mode } from "@/lib/modes";
import { useFootageStore } from "@/store/useFootageStore";
import { isRunning, isWaiting, useIngestStore } from "@/store/useIngestStore";
import { seasonReviewStats } from "@/lib/analytics/review";
import pkg from "@/package.json";

/* Icons alone don't explain themselves to a first-time user, so the rail
   expands into icon+label rows. The preference persists; the default stays
   compact so the map keeps the space. */
const STORAGE_KEY = "sealv-rail-open";

/* No file/document glyph in the icon set, and `download` is the honest one
   anyway: the report mode exists to leave the building as a PDF. */
const MODE_ICON: Record<Mode, IconName> = {
  map: "map",
  review: "search",
  ingest: "upload",
  archive: "list",
  report: "download",
  manage: "settings",
};

/* A count on a rail row is a claim about work, so only numbers with exactly
   one source get one. Съёмки counts rows in the archive, Загрузка counts the
   queue in front of you, Проверка counts points nobody has ruled on. The map
   deliberately has none: the season strip inside Карта states the site count
   and the standing estimate in full, and a second, smaller copy of a number
   4px from the edge of the screen is an invitation to check two totals against
   each other. */
type Badge = { n: number; attention?: boolean; title: string } | null;

export default function Rail() {
  const { t } = useT();
  const [mode, setMode] = useMode();
  const [open, setOpen] = useState(false);
  /* restore after mount — the static export must hydrate deterministically */
  useEffect(() => { try { if (localStorage.getItem(STORAGE_KEY) === "1") setOpen(true); } catch {} }, []);
  const toggle = () => setOpen(o => { const v = !o; try { localStorage.setItem(STORAGE_KEY, v ? "1" : "0"); } catch {} return v; });

  const footages = useFootageStore(s => s.footages);
  const ingestItems = useIngestStore(s => s.items);

  /* Over the whole store, not the brushed range: the rail is a place to go,
     and hiding a queue of unreviewed points because the date brush happens to
     exclude them would be the rail lying about what is left to do. */
  const awaitingReview = useMemo(() => {
    const s = seasonReviewStats(footages);
    return Math.max(0, s.reviewable - s.ruled);
  }, [footages]);

  const ingestBusy = useMemo(
    () => ingestItems.filter(i => isRunning(i.phase) || i.phase === "queued").length,
    [ingestItems],
  );
  /* A card that has stopped and is waiting on a person — a duplicate to rule
     on, a location to pin, a frame to pick, a failure to look at. It reads
     differently from "running", so it is counted separately and drawn in ink
     rather than in the signal colour. */
  const ingestNeedsYou = useMemo(
    () => ingestItems.filter(i => isWaiting(i.phase) || i.phase === "failed").length,
    [ingestItems],
  );

  const badgeOf = (m: Mode): Badge => {
    if (m === "review") {
      return awaitingReview > 0
        ? { n: awaitingReview, title: t("rail.tipReview", { n: awaitingReview }) }
        : null;
    }
    if (m === "ingest") {
      if (ingestNeedsYou > 0)
        return { n: ingestNeedsYou, attention: true, title: t("ingest.needsYou", { n: ingestNeedsYou }) };
      return ingestBusy > 0 ? { n: ingestBusy, title: t("rail.tipQueue", { n: ingestBusy }) } : null;
    }
    if (m === "archive") {
      return footages.length > 0
        ? { n: footages.length, title: t("rail.tipSorties", { n: footages.length }) }
        : null;
    }
    return null;
  };

  /* A row is a line of text on the rail's own gutter, not a filled tab. The
     one you are on is stated three ways at once — full ink, the icon at full
     strength, and a 2px rule on the rail's edge — and none of them is the
     signal colour: green here is the standing estimate, not "you clicked
     this". No hover fill either; the colour step is the hover. */
  /* Two shapes, one row. On a phone the rail is a bottom bar, so a row is a
     full-height column of icon-over-label that fills its share of the width -
     a 56px target a thumb can hit without aiming. From `sm:` up it is the line
     of text it has always been. */
  const row = (active?: boolean) =>
    `relative flex shrink-0 items-center transition-colors ` +
    `min-w-0 flex-1 flex-col justify-center gap-1 px-0.5 py-1 ` +
    `sm:h-8 sm:flex-none sm:flex-row sm:gap-0 sm:py-0 ${
      open ? "sm:px-5 sm:gap-2.5 sm:justify-start" : "sm:w-8 sm:mx-auto sm:justify-center"
    } ${active ? "text-ink" : "text-ink3 hover:text-ink2"}`;

  return (
    /* Bottom bar on a phone, side rail from `sm:` up. Fixed rather than in
       flow at the bottom so the map keeps the full height under it, and padded
       for the home indicator on a notched device. */
    <nav
      aria-label={t("rail.nav")}
      className={`fixed inset-x-0 bottom-0 z-30 flex h-[52px] flex-row items-stretch border-t border-line bg-bg pb-[env(safe-area-inset-bottom)] overflow-hidden
        sm:static sm:h-auto sm:flex-col sm:items-stretch sm:border-t-0 sm:border-r sm:pb-0 sm:py-3 sm:shrink-0 sm:transition-[width] sm:duration-150
        ${open ? "sm:w-44" : "sm:w-12"}`}
    >
      {MODE_ORDER.map(m => {
        const active = mode === m;
        const label = t(MODE_LABEL_KEY[m]);
        const badge = badgeOf(m);
        return (
          <button
            key={m}
            onClick={() => setMode(m)}
            aria-current={active ? "page" : undefined}
            title={badge ? `${label} · ${badge.title}` : open ? undefined : label}
            aria-label={badge ? `${label} · ${badge.title}` : label}
            className={row(active)}
          >
            {/* The active mark follows the bar's own axis. A 2px rule on the
                LEFT edge is what a vertical rail wants; in a horizontal bottom
                bar the same rule reads as a stray white stick beside the label,
                so on a phone it lies along the top edge of the item instead. */}
            {active && (
              <span
                aria-hidden="true"
                className="absolute inset-x-3 top-0 h-0.5 bg-ink sm:inset-x-auto sm:left-0 sm:top-1 sm:bottom-1 sm:h-auto sm:w-0.5"
              />
            )}
            <Icon
              name={MODE_ICON[m]}
              size={18}
              className={`shrink-0 sm:!h-[15px] sm:!w-[15px] ${active ? "" : "opacity-60 sm:opacity-50"}`}
            />
            <span className="w-full truncate text-center text-[10px] leading-none tracking-tight sm:hidden">{label}</span>
            {open && <span className="hidden text-base truncate sm:inline">{label}</span>}
            {open && badge && (
              /* Running work takes the signal colour; work waiting on a person
                 is plain ink in italic — the same two states every queue in
                 this design already distinguishes. */
              <span className={`ml-auto text-2xs tnum shrink-0 ${badge.attention ? "text-ink italic" : "text-accent"}`}>
                {badge.n}
              </span>
            )}
            {/* Collapsed there is no room for a numeral, so the badge shrinks
                to the fact that there IS one — a 4px mark on the icon's
                shoulder. The count itself stays in the title. */}
            {!open && badge && (
              <span
                /* On the icon's shoulder. Pinned to the button's corner it
                   floated above the row on the bottom bar, reading as a stray
                   dot rather than as this item's badge. */
                className={`absolute right-[22%] top-1.5 h-1 w-1 rounded-full sm:right-0.5 sm:top-0.5 ${badge.attention ? "bg-ink" : "bg-accent"}`}
                aria-hidden="true"
              />
            )}
          </button>
        );
      })}

      <div className="hidden flex-1 sm:block" />

      <button
        onClick={toggle}
        title={open ? t("rail.collapse") : t("rail.expand")}
        aria-label={open ? t("rail.collapse") : t("rail.expand")}
        aria-expanded={open}
        /* Collapsing is a desktop affordance: the bottom bar has one shape. */
        className={`hidden sm:flex ${row(false)}`}
      >
        <Icon name={open ? "chevronLeft" : "chevronRight"} size={15} className="shrink-0 opacity-50" />
        {open && <span className="text-base truncate">{t("rail.collapse")}</span>}
      </button>

      {/* single source of truth: package.json, gated against the git tag at release */}
      {/* nowrap: collapsed, the rule is 40px wide and "v0.3.0" is ~34 — one
          more digit in the version and it would break across two lines inside
          an `overflow-hidden` rail, i.e. disappear. */}
      <span className={`hidden sm:block text-2xs text-ink3 tnum whitespace-nowrap mt-3 pt-2.5 shrink-0 border-t border-hair ${open ? "mx-5" : "mx-1 text-center"}`}>v{pkg.version}</span>
    </nav>
  );
}
