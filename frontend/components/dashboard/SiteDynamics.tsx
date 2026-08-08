"use client";
/**
 * SiteDynamics — every visit to one haul-out, in order, with its band.
 *
 * `siteSeries()` has always computed the whole ordered series; the repeat-survey
 * row printed the last delta and threw the rest away. This is the rest: one dot
 * per visit at its best count, a low–high whisker where the band has one, and
 * the visit's date, basis and reviewed share written out underneath.
 *
 * What it deliberately does not draw:
 *
 *   - No line between the dots, no regression, no forecast. Two counts of one
 *     haul-out are two measurements, and joining them asserts a path between
 *     them that nobody observed.
 *   - No zero for a visit that produced no count. `best === null` is UNKNOWN,
 *     and a dot on the baseline would report a flight that measured nothing as
 *     a haul-out that had emptied. It renders as a marked gap instead.
 *
 * Hand-rolled SVG in the panel's own idiom (the per-sortie bars are divs with
 * the same tokens) — no chart library, and none is warranted for dots and
 * whiskers over a handful of visits.
 */
import { formatDate } from "@/lib/analytics/brush";
import { reviewStats } from "@/lib/analytics/review";
import type { SeriesEntry, Site } from "@/lib/analytics/surveys";
import { basisText, useT } from "@/lib/i18n";
import type { Footage } from "@/lib/types";

/** A ground count has no engine basis to translate — it has a person. */
const isManual = (f: Footage): boolean => f.band?.basis === "manual" || f.engine === "manual";

/* One 380px column. The SVG scales with the container; the coordinate space is
   fixed so the dots stay round and the whiskers stay hairlines. */
const CHART_W = 320;
const CHART_H = 76;
const PAD = { l: 7, r: 7, t: 10, b: 8 };

export default function SiteDynamics({
  site,
  series,
  onPick,
}: {
  site: Site<Footage>;
  series: SeriesEntry<Footage>[];
  onPick?: (f: Footage) => void;
}) {
  const { t, lang } = useT();
  if (series.length === 0) return null;

  /* `name` is null both when nobody has named the place and when two named
     sites were merged by proximity — groupIntoSites refuses to pick a winner,
     and so does this. Either way the centroid is the thing that is true. */
  const name = site.name;

  /* Which clock the x axis is on. `uploadedAt` is what siteSeries ordered by,
     so it is what gets plotted — and hydrate fills it from the flight date
     where the survey recorded one and from the count job's clock where it did
     not. The reader is told which, and how many of each, because a timeline
     built out of processing times is a different claim from a timeline built
     out of flight dates. */
  const flown = series.filter((e) => (e.footage.capturedAt ?? "").trim() !== "").length;
  const clockNote =
    flown === series.length
      ? t("dyn.datesFlown")
      : flown === 0
        ? t("dyn.datesJob")
        : t("dyn.datesMixed", { n: flown, m: series.length });

  const times = series.map((e) => Date.parse(e.uploadedAt));
  const finite = times.filter((n) => Number.isFinite(n));
  const tMin = finite.length ? Math.min(...finite) : 0;
  const tMax = finite.length ? Math.max(...finite) : 0;
  const span = tMax - tMin;
  /* Real time spacing when every visit has a readable date and they are not
     all the same instant; otherwise even spacing, because a made-up interval
     is the one thing a dynamics chart must not draw. */
  const timeAxis = span > 0 && finite.length === series.length;
  const inner = CHART_W - PAD.l - PAD.r;
  const xOf = (i: number) => {
    if (series.length === 1) return PAD.l + inner / 2;
    if (timeAxis) return PAD.l + ((times[i] - tMin) / span) * inner;
    return PAD.l + (i / (series.length - 1)) * inner;
  };

  const top = Math.max(
    1,
    ...series.map((e) => Math.max(e.band?.high ?? 0, e.best ?? 0)),
  );
  const yOf = (v: number) => CHART_H - PAD.b - (v / top) * (CHART_H - PAD.t - PAD.b);

  const day = (iso: string) => formatDate(iso, lang, { day: "numeric", month: "short" });

  return (
    <div className="mt-2 pl-2 border-l border-line-soft">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-2xs text-ink3">{t("dyn.allVisits")}</span>
        <span className="text-2xs tnum text-ink3" title={t("dyn.axisTopTitle")}>
          {t("dyn.axisTop", { n: top })}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="w-full mt-1.5"
        role="img"
        aria-label={t("dyn.chartAlt")}
      >
        {/* Baseline only. No gridlines behind measured points — the numbers are
            written out below, so a grid would be decoration. */}
        <line
          x1={PAD.l}
          x2={CHART_W - PAD.r}
          y1={CHART_H - PAD.b}
          y2={CHART_H - PAD.b}
          className="stroke-line-soft"
          strokeWidth={1}
        />
        {series.map((e, i) => {
          const x = xOf(i);
          const when = day(e.uploadedAt);
          if (e.best == null) {
            /* A gap, drawn as an absence: a dashed hairline where a dot would
               have been, never a dot at zero. */
            return (
              <g key={e.footage.id}>
                <line
                  x1={x}
                  x2={x}
                  y1={PAD.t}
                  y2={CHART_H - PAD.b}
                  className="stroke-ink3"
                  strokeWidth={1}
                  strokeDasharray="2 3"
                  opacity={0.7}
                />
                <title>{`${when} · ${t("dyn.noCount")}`}</title>
              </g>
            );
          }
          const low = e.band?.low;
          const high = e.band?.high;
          const hasRange = low != null && high != null && high > low;
          const manual = isManual(e.footage);
          return (
            <g key={e.footage.id}>
              {hasRange && (
                <>
                  <line
                    x1={x}
                    x2={x}
                    y1={yOf(high as number)}
                    y2={yOf(low as number)}
                    className="stroke-ink3"
                    strokeWidth={1}
                  />
                  <line x1={x - 2.5} x2={x + 2.5} y1={yOf(high as number)} y2={yOf(high as number)} className="stroke-ink3" strokeWidth={1} />
                  <line x1={x - 2.5} x2={x + 2.5} y1={yOf(low as number)} y2={yOf(low as number)} className="stroke-ink3" strokeWidth={1} />
                </>
              )}
              {/* A ground count is a hollow dot — a shape difference, not a
                  colour one, so the manual/machine distinction survives a
                  greyscale print and a colour-blind reader. */}
              <circle
                cx={x}
                cy={yOf(e.best)}
                r={3}
                className={manual ? "fill-none stroke-ink2" : "fill-ink2 stroke-none"}
                strokeWidth={1.2}
              />
              <title>
                {`${when} · ${e.best}${hasRange ? ` (${low}–${high})` : ""}${manual ? ` · ${t("pill.manual")}` : ""}`}
              </title>
            </g>
          );
        })}
      </svg>

      <div className="flex items-baseline justify-between text-2xs text-ink3 mt-1">
        <span>{day(series[0].uploadedAt)}</span>
        <span>{day(series[series.length - 1].uploadedAt)}</span>
      </div>
      <p className="text-2xs text-ink3 mt-1.5 leading-relaxed">{clockNote}</p>
      {series.some((e) => e.best == null) && (
        <p className="text-2xs text-ink3 mt-1 leading-relaxed">{t("dyn.gapNote")}</p>
      )}

      {/* Every visit written out. The chart is the shape; this is the record,
          and it is the half a reader can check. */}
      <ul className="mt-2.5 space-y-1.5">
        {series.map((e) => {
          const f = e.footage;
          const rs = reviewStats(f);
          const manual = isManual(f);
          const b = e.band;
          const count =
            e.best == null
              ? t("dyn.noCount")
              : b && b.low != null && b.high != null && b.high > b.low
                ? `${b.low}–${e.best}–${b.high}`
                : String(e.best);
          const basis = b?.basis
            ? manual
              ? t("basis.manual")
              : basisText(lang, b.basis)
            : t("rep.basisNone");
          return (
            <li key={f.id}>
              <button
                type="button"
                onClick={() => onPick?.(f)}
                className="w-full text-left rounded px-1 -mx-1 py-0.5 hover:bg-surface2"
                title={f.filename}
              >
                <span className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="text-ink2 truncate">
                    {formatDate(e.uploadedAt, lang, { day: "numeric", month: "short", year: "numeric" })}
                  </span>
                  <span className="tnum text-ink shrink-0">
                    {count}
                    {e.delta && (
                      <span className="text-ink3 ml-1.5">
                        {e.delta.abs >= 0 ? "+" : ""}
                        {e.delta.abs}
                      </span>
                    )}
                  </span>
                </span>
                <span className="block text-2xs text-ink3 mt-0.5 leading-tight">
                  {manual && <span className="text-ink2">{t("pill.manual")} · </span>}
                  {basis}
                  {rs.reviewable > 0
                    ? ` · ${t("dyn.reviewed", { v: rs.ruled, r: rs.reviewable })}`
                    : ""}
                  {rs.unreviewable > 0 ? ` · ${t("dyn.unreviewable", { n: rs.unreviewable })}` : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {/* The measured thing the name stands for. A named site still prints its
          centroid, so a reader can check what was named; an unnamed one says
          plainly that nobody has named it, rather than looking unfinished. */}
      <p className="text-2xs text-ink3 mt-2 leading-relaxed">
        <span className="font-mono tnum">
          {t("dyn.centroid", {
            lat: site.centroid.lat.toFixed(4),
            lng: site.centroid.lng.toFixed(4),
          })}
        </span>
        {name === null && <> · {t("dyn.unnamed")}</>}
      </p>
    </div>
  );
}
