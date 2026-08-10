"use client";
/**
 * SeasonMode — Карта. The season, on the coast it was measured on.
 *
 * This is the mode the product opens in, and it answers one question: how many
 * seals are standing on this coastline right now, and how much of that answer
 * can be trusted. Everything on screen serves that and nothing else.
 *
 *   the strip   The season's own reading, along the top: the standing estimate
 *               with its band, then the three qualifications that decide what
 *               the estimate is worth — how many places it covers, how much
 *               ground was actually photographed, how many sorties are behind
 *               it — and, on the right, the two trust lights in words: how much
 *               a person has reviewed, and whether the scale was measured or
 *               assumed. This used to be a 340px column of stats beside the map
 *               and a second copy of the same figures inside the analytics
 *               panel. One statement now, in one place, from the shared helpers.
 *   the map     Full bleed, with ONE CHIP PER SITE. Three visits to one beach
 *               are one chip carrying that beach's standing count — which is
 *               what the estimate is actually made of — with a spark under the
 *               figure when the place has been flown more than once.
 *   the card    A chip opens the site: its name (editable), its standing count,
 *               every visit plotted and written out, its История, its notes.
 *
 * There is no permanent list here. The list of sorties is the ARCHIVE's job
 * (Съёмки), and a sortie's own detail is the inspector the shell puts up when
 * something is selected — clicking a visit inside the site card is what selects
 * it. Карта is about places; Съёмки is about flights.
 *
 * Two things this file is deliberately careful about, because both touch the
 * headline number:
 *
 *  - The chip partition is `groupIntoSites` over exactly the sorties
 *    `seasonEstimate` sums — live, with a result, placed. Any private
 *    clustering here would eventually print a map that disagreed with the
 *    figure above it.
 *  - Retired sorties are attached to their site for the RECORD (История) and
 *    are in no figure at all. Withdrawn evidence is still evidence.
 */
import { useEffect, useMemo, useState } from "react";
import CaspianMap, { type SiteChip } from "@/components/map/CaspianMap";
import SiteCard from "@/components/map/SiteCard";
import PinBar from "@/components/map/PinBar";
import Icon from "@/components/ui/Icon";
import { formatArea, totalAreaM2 } from "@/lib/analytics/area";

import { footagesInRange } from "@/lib/analytics/brush";
import { countOf } from "@/lib/analytics/count";
import { seasonEstimate } from "@/lib/analytics/estimate";
import { seasonReviewStats } from "@/lib/analytics/review";
import {
  SITE_RADIUS_M,
  groupIntoSites,
  hasResult,
  isPlaced,
  siteSeries,
  type Site,
} from "@/lib/analytics/surveys";
import { useT } from "@/lib/i18n";
import { setMode, useMode } from "@/lib/modes";
import { Button } from "@/components/ui/primitives";
import type { Footage } from "@/lib/types";
import { useFootageStore } from "@/store/useFootageStore";

/** A site's identity for the chip and the card. Its assigned id when somebody
 *  named it; its centroid otherwise — which is stable for as long as the
 *  cluster is, and is the only other thing that is true about the place. */
const siteKey = (s: Site<Footage>): string =>
  s.siteId ?? `${s.centroid.lat.toFixed(4)},${s.centroid.lng.toFixed(4)}`;

/** Metres between two coordinates — equirectangular, cos-corrected, the same
 *  approximation the clustering itself uses. Only ever asked at cluster scale. */
function metresBetween(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const mPerDeg = 111320;
  const cos = Math.max(Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180), 0.01);
  return Math.hypot((a.lng - b.lng) * cos * mPerDeg, (a.lat - b.lat) * mPerDeg);
}

export default function SeasonMode() {
  const { t, tp, lang } = useT();
  const [, setMode] = useMode();
  const footages = useFootageStore((s) => s.footages);
  const timeRange = useFootageStore((s) => s.timeRange);
  const hydrating = useFootageStore((s) => s.hydrating);

  /* Which site's card is open, held as one of ITS SORTIES rather than as the
     site's key. A key is derived — it is the assigned site id, or the centroid
     — so naming a place changes it, and an open card keyed on it would vanish
     at the exact moment somebody finished typing the name. A sortie id is
     durable: the card follows its site through a rename, a re-cluster and a
     move of the timeline brush, and closes only when that sortie genuinely
     leaves the season. */
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(true);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("sealv-season-summary-open");
      if (saved != null) setSummaryOpen(saved !== "0");
    } catch {
      /* A privacy-restricted browser simply keeps the default open state. */
    }
  }, []);

  const toggleSummary = () => {
    setSummaryOpen((open) => {
      const next = !open;
      try {
        window.localStorage.setItem("sealv-season-summary-open", next ? "1" : "0");
      } catch {
        /* Persistence is a convenience, not a reason to disable the control. */
      }
      return next;
    });
  };

  /* ------------------------------------------------------------ the season */
  /* Three sets, and keeping them apart is the whole point. A FAILED ingest is a
     Footage with a filename and nothing else — counted as a sortie it inflates
     every per-sortie figure and then appears in the "no scale" tally as a
     survey that neglected to record one. A RETIRED sortie is real evidence that
     has been withdrawn: in no figure either, but a different claim, and it
     keeps its place in the record. */
  const season = useMemo(() => {
    const inWindow = footagesInRange(footages, timeRange);
    const retired = inWindow.filter((f) => (f.retiredAt ?? "").trim() !== "");
    const live = inWindow.filter((f) => (f.retiredAt ?? "").trim() === "");
    const counted = live.filter(hasResult);
    return { retired, live, counted };
  }, [footages, timeRange]);

  const est = useMemo(() => seasonEstimate(season.counted), [season.counted]);
  const review = useMemo(() => seasonReviewStats(season.counted), [season.counted]);

  /* Surveyed ground — what the sorties actually photographed. A ground count
     photographed nothing, so it is not a sortie "without a scale": counting it
     as one blames a person on a beach for not carrying a sensor. */
  const area = useMemo(
    () => totalAreaM2(season.counted.filter((f) => f.engine !== "manual")),
    [season.counted],
  );

  /* The sites the estimate is a sum over. Same helper, same inputs, same
     partition — the map cannot drift from the headline because it is not
     allowed its own opinion about what a site is. */
  const sites = useMemo(
    () => groupIntoSites(season.counted.filter(isPlaced)),
    [season.counted],
  );

  /* Withdrawn flights, attached to the place they were flown over. Nearest
     site inside the clustering radius wins; anything further out belongs to no
     site on this map and stays in the archive, which is where a withdrawn
     flight over untouched water is findable. This attach is read-only — it
     cannot move a sortie into a figure, because no figure reads it. */
  const retiredBySite = useMemo(() => {
    const out = new Map<string, Footage[]>();
    if (sites.length === 0) return out;
    for (const f of season.retired) {
      if (!isPlaced(f) || !hasResult(f)) continue;
      let best: { key: string; d: number } | null = null;
      for (const s of sites) {
        const d = metresBetween(f.center, s.centroid);
        if (d > SITE_RADIUS_M) continue;
        if (!best || d < best.d) best = { key: siteKey(s), d };
      }
      if (!best) continue;
      const bucket = out.get(best.key);
      if (bucket) bucket.push(f);
      else out.set(best.key, [f]);
    }
    return out;
  }, [sites, season.retired]);

  /* One chip per site, and the season band under the hero, from one pass — the
     two are the same arithmetic read at two scales, and computing them apart is
     how a card comes to say 218 while the strip is summing 214.

     The band is a sum over the STANDING visits, so it brackets exactly the
     figure the hero prints. A visit whose engine gave no low–high contributes
     its best to both ends and is counted as degenerate, which the strip then
     states out loud — a range that silently hardens on half the sites is worse
     than no range. */
  const { chips, band } = useMemo(() => {
    const chips: SiteChip[] = [];
    let low = 0;
    let high = 0;
    let contributing = 0;
    let degenerate = 0;

    for (const site of sites) {
      const key = siteKey(site);
      const series = siteSeries(site);
      const spark: number[] = [];
      for (const e of series) if (e.best != null && Number.isFinite(e.best)) spark.push(e.best);

      let standing: (typeof series)[number] | null = null;
      for (let i = series.length - 1; i >= 0; i--) {
        const e = series[i];
        if (e.best != null && Number.isFinite(e.best)) { standing = e; break; }
      }

      const b = standing?.band ?? null;
      const range = !!b && b.low != null && b.high != null && b.high > b.low;
      if (standing?.best != null) {
        contributing += 1;
        if (range) { low += b!.low as number; high += b!.high as number; }
        else { low += standing.best; high += standing.best; degenerate += 1; }
      }

      const attached = retiredBySite.get(key) ?? [];
      chips.push({
        key,
        lat: site.centroid.lat,
        lng: site.centroid.lng,
        name: site.name,
        count: standing?.best ?? null,
        low: range ? (b!.low as number) : null,
        high: range ? (b!.high as number) : null,
        spark,
        visits: site.footages.length + attached.length,
        retired: standing == null,
        footageIds: site.footages.map((f) => f.id),
      });
    }

    /* Counts with no coordinate. They are in the estimate — dropping a measured
       animal because the flight logged no track would be dishonesty in the
       other direction — so they are in the band too, degenerately, and the
       sorties readout says how many of them there are. They have no chip
       because they have no place to put one. */
    for (const f of season.counted) {
      if (isPlaced(f)) continue;
      /* countOf, not band.best — that is the term seasonEstimate adds for a
         stray, and a band that bracketed a different definition of the count
         than the hero prints would not be a band at all. */
      const c = countOf(f);
      if (!Number.isFinite(c)) continue;
      low += c;
      high += c;
      contributing += 1;
      degenerate += 1;
    }

    return { chips, band: { low, high, contributing, degenerate } };
  }, [sites, retiredBySite, season.counted]);

  const openSite = useMemo(
    () => (anchorId ? sites.find((s) => s.footages.some((f) => f.id === anchorId)) ?? null : null),
    [sites, anchorId],
  );
  const openKey = openSite ? siteKey(openSite) : null;
  /* The chip hands back a key; the anchor is the first sortie behind it. */
  const openFromChip = (key: string) => {
    const chip = chips.find((c) => c.key === key);
    setAnchorId(chip?.footageIds[0] ?? null);
  };

  /* ------------------------------------------------------------- the strip */
  const areaText = area.known ? `${formatArea(area.m2, lang)} ${t("unit.ha")}` : "—";
  /* No sub-line: the missing/assumed-GSD counts are exactly what the scale
     trust light on the right states, with the long argument in its tooltip.
     One strip must not print one caveat twice. */

  const unplaced = season.counted.filter((f) => !isPlaced(f)).length;
  const reviewPct = Math.round(review.pct ?? 0);
  /* Sites the estimate could actually take a number from. Every site here has
     one by construction — it was built out of sorties that produced a count —
     but the ratio is printed rather than assumed, because the day it stops
     being N of N is the day something is wrong and the strip should say so. */
  const sitesWithCount = chips.filter((c) => c.count != null).length;
  /* Scale, from the same pass that produced the area total, so the caveat and
     the figure can never describe different seasons. */
  const noScale = area.unknown + area.assumed === 0;

  const bandText =
    band.contributing === 0
      ? null
      /* No band anywhere is a caveat, not a figure — each site's card says it
         as a chip. A sentence permanently under the hero taught readers to
         skip that line, which is fatal the day it holds a real range. */
      : band.degenerate === band.contributing
        ? null
        : band.degenerate > 0
          ? t("season.bandPartial", {
              low: band.low, high: band.high, n: band.degenerate, m: band.contributing,
            })
          : t("season.bandRange", { low: band.low, high: band.high });

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* ─────────────────────────────────────────────── the season's reading */}
      <div className={`shrink-0 border-b border-line bg-bg ${summaryOpen ? "flex items-center gap-10 px-5 pt-3.5 pb-4 overflow-x-auto" : "px-5 py-1.5"}`}>
        {summaryOpen ? <>
        {/* The hero, and the only place the season total is stated on Карта.
            One number in the signal colour; everything beside it is a
            qualification of it and is set as one. */}
        <div className="min-w-[186px] shrink-0">
          <div
            className="tnum text-accent"
            style={{ fontSize: 50, lineHeight: 0.9, fontWeight: 500, letterSpacing: "-0.038em" }}
          >
            {est.current}
          </div>
          <div className="text-2xs text-ink2 mt-2">{t("season.heroCaption")}</div>
          {bandText && <div className="text-2xs text-ink3 tnum mt-0.5">{bandText}</div>}
          {/* The sum over sorties, demoted to what it honestly is. Flying one
              haul-out twice contributes twice, so it measures EFFORT, not a
              population — and it is stated in those words rather than deleted,
              because it is the number a repeat-survey delta is computed from. */}
          {/* Only when it DIFFERS from the estimate: equal, it restates the
              hero and the sortie readout at once. Different, it is the repeat-
              survey effort figure and earns its line. */}
          {season.counted.length > 0 && est.observed !== est.current && (
            <div className="text-2xs text-ink4 tnum mt-1 leading-relaxed">
              {t("est.observedSub", { n: est.observed, m: season.counted.length })}
            </div>
          )}
        </div>

        {/* Three readouts, aligned in columns and separated by nothing but the
            grid. Label, figure, and the caveat that belongs to that figure —
            a hectare total with an assumed scale inside it must never print
            like a measured one. */}
        <dl className="m-0 shrink-0">
          <Readout
            label={t("season.sites")}
            /* All counted is the DEFAULT and prints as the bare total; the
               ratio and its explanation appear only when they deviate from it.
               "2 из 2 · все в зачёте" said one thing three ways. */
            value={
              sitesWithCount < chips.length
                ? t("season.sitesOf", { n: sitesWithCount, m: chips.length })
                : String(chips.length)
            }
            sub={
              sitesWithCount < chips.length
                ? t("season.sitesRetired", { n: chips.length - sitesWithCount })
                : null
            }
            /* What makes two flights one site, on the figure that depends on
               it. The 2 km rule is the reason the estimate does not rise when
               a beach is flown again, and a reader shown a site count has to
               be told it. */
            title={t("est.basis", { km: SITE_RADIUS_M / 1000 })}
          />
          <Readout label={t("stat.surveyed")} value={areaText} sub={null} />
          <Readout
            label={t("stat.sorties")}
            value={String(season.live.length)}
            /* Quiet zeros: "2 с подсчётом · 0 без координат" under "2" carried
               no information. Each part prints only when it deviates — fewer
               counted than flown, or anything unplaced. */
            sub={
              [
                season.counted.length < season.live.length
                  ? t("season.sortiesCounted", { n: season.counted.length })
                  : null,
                unplaced > 0 ? t("season.sortiesNoCoord", { m: unplaced }) : null,
              ].filter(Boolean).join(" · ") || null
            }
          />
        </dl>

        {/* The two trust lights, in words. A dotted underline and a title,
            because the short form is the reading and the long form is the
            argument behind it. */}
        <div className="ml-auto shrink-0 text-right flex flex-col gap-1.5 pl-6">
          {review.reviewable > 0 && (
            <p
              className="text-2xs text-ink3 self-end"
              style={{ borderBottom: "1px dotted var(--ink-4)", paddingBottom: 2, cursor: "help" }}
              title={t("season.trustReviewLong", {
                n: review.ruled, r: review.reviewable,
                v: review.verified, x: review.rejected,
              })}
            >
              {t("season.trustReview", { pct: reviewPct })}
            </p>
          )}
          <p
            className="text-2xs text-ink3 self-end"
            style={{ borderBottom: "1px dotted var(--ink-4)", paddingBottom: 2, cursor: "help" }}
            title={
              noScale
                ? t("season.trustScaleAllLong")
                : t("season.trustScaleLong", { a: area.assumed, u: area.unknown })
            }
          >
            {/* A zero cohort is not said: "предположен у 0" reads as a fact
                about nothing. Each half prints only when it has members. */}
            {noScale
              ? t("season.trustScaleAll")
              : area.assumed > 0 && area.unknown > 0
                ? t("season.trustScale", { a: area.assumed, u: area.unknown })
                : area.assumed > 0
                  ? t("season.trustScaleAssumed", { a: area.assumed })
                  : t("season.trustScaleUnknown", { u: area.unknown })}
          </p>
        </div>
        {/* The door for footage, on the screen people actually stand at.
            Drag-and-drop anywhere already routes to Загрузка; this is the
            same door for a reader with a mouse and a clip of seals. */}
        <Button icon="upload" variant="primary" className="shrink-0 self-center" onClick={() => setMode("ingest")}>
          {t("page.ingest")}
        </Button>
        <button
          type="button"
          onClick={toggleSummary}
          title={t("season.collapseSummary")}
          aria-label={t("season.collapseSummary")}
          aria-expanded="true"
          className="shrink-0 inline-flex items-center justify-center w-7 h-7 border border-line text-ink3 hover:text-ink hover:border-ink3 transition-colors"
        >
          <Icon name="chevronUp" size={15} />
        </button>
        </> : (
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="text-sm tnum text-accent font-medium">{est.current}</span>
              <span className="text-2xs text-ink3 truncate">{t("season.heroCaption")}</span>
            </div>
            <Button icon="upload" variant="primary" className="shrink-0" onClick={() => setMode("ingest")}>
              {t("page.ingest")}
            </Button>
            <button
              type="button"
              onClick={toggleSummary}
              title={t("season.expandSummary")}
              aria-label={t("season.expandSummary")}
              aria-expanded="false"
              className="shrink-0 inline-flex items-center justify-center w-7 h-7 border border-line text-ink3 hover:text-ink hover:border-ink3 transition-colors"
            >
              <Icon name="chevronDown" size={15} />
            </button>
          </div>
        )}
      </div>

      {/* ────────────────────────────────────────────────────────────── the map */}
      <div className="flex-1 min-h-0 relative">
        <CaspianMap
          siteChips={chips}
          selectedSiteKey={openKey}
          onSiteClick={openFromChip}
        />

        {/* Nothing to show yet — said over the chart rather than in place of it,
            so the coast the season will be measured on is still on screen. */}
        {footages.length === 0 && (
          <div className="absolute inset-0 z-[8] grid place-items-center pointer-events-none">
            <div className="plate px-4 py-3 max-w-[300px] text-center">
              <p className="text-sm text-ink2">
                {hydrating ? t("est.restoring") : t("season.empty")}
              </p>
              {!hydrating && (
                <>
                  <p className="text-2xs text-ink3 mt-1.5 leading-relaxed">{t("season.emptyHint")}</p>
                  {/* An empty chart has to offer the one thing that fills it.
                      The rail carries Загрузка, but a first-time reader is
                      looking at the middle of the screen, not at an icon
                      column — so the call to action stands where the emptiness
                      is. `pointer-events-auto` because the whole overlay is
                      transparent to the map behind it. */}
                  <div className="mt-3 pointer-events-auto">
                    <Button variant="primary" icon="plus" onClick={() => setMode("ingest")}>
                      {t("nav.ingest")}
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* The pin flow's confirm/cancel, on the screen where the pinning
            happens. Without it, walking here from Загрузка to place a point
            left an armed crosshair and no way to finish or leave. */}
        <PinBar />

        {openSite && (
          <SiteCard
            site={openSite}
            retired={retiredBySite.get(siteKey(openSite)) ?? []}
            onClose={() => setAnchorId(null)}
          />
        )}
      </div>
    </div>
  );
}

/** One line of the strip's readout: label, figure, and the qualification that
 *  belongs to that figure. A fixed grid so three of them read as a column of
 *  numbers rather than three unrelated sentences. */
function Readout({
  label,
  value,
  sub,
  title,
}: {
  label: string;
  value: string;
  sub?: string | null;
  /** The rule behind the figure, on hover. Long enough to be a sentence, so it
   *  belongs on the label rather than crowding the strip. */
  title?: string;
}) {
  return (
    <div className="grid grid-cols-[92px_88px_1fr] items-baseline gap-x-4" style={{ minHeight: 22 }}>
      <dt
        className="text-2xs text-ink3"
        title={title}
        style={title ? { borderBottom: "1px dotted var(--ink-4)", cursor: "help", width: "fit-content" } : undefined}
      >
        {label}
      </dt>
      <dd className="m-0 tnum text-sm text-ink truncate" title={value}>{value}</dd>
      <dd className="m-0 text-2xs text-ink4 truncate" title={sub ?? undefined}>{sub ?? ""}</dd>
    </div>
  );
}
