"use client";
/**
 * ReportMode — Отчёт. Two steps: choose a period and the sites, then read the
 * record you are about to sign and download it.
 *
 * This screen is where the Аналитика panel went. That panel was a drawer of
 * season-wide figures with an export button in its header — a place you looked
 * at numbers, and, if you happened to notice, a place a PDF came out of. The
 * numbers have not changed and not one of them was dropped; they are simply
 * stated where they are actually used, which is inside the document they are
 * the evidence for. Every section of the old Dashboard has a home below:
 *
 *   headline estimate + sorties + surveyed area  →  «Что попадёт в акт» and
 *                                                   the record's total row
 *   repeat surveys (the list, with Δ)            →  the per-site table's
 *                                                   Visits and Δ columns
 *                                                   (the per-site CHART is the
 *                                                   site card on Карта)
 *   counts per sortie (bars with the band)       →  §Подсчёты по вылетам
 *   group size histogram                         →  §Размер группы
 *   verification block                           →  §Проверка
 *   TrustPanel                                   →  mounted whole, unchanged
 *   derived summary                              →  §Сводка по данным
 *
 * The one thing the panel could not do and this screen can: the export is no
 * longer "whatever the timeline brush happens to be showing". A record is a
 * document about a stated period and a stated list of sites, and here it says
 * which — on screen, and in the PDF's own header, from the same two values.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useFootageStore } from "@/store/useFootageStore";
import { Button, SectionHead } from "@/components/ui/primitives";
import TrustPanel from "@/components/dashboard/TrustPanel";
import { formatArea, totalAreaM2 } from "@/lib/analytics/area";
import { detectionsFor, formatDate, timeExtent } from "@/lib/analytics/brush";
import { countOf } from "@/lib/analytics/count";
import { seasonEstimate } from "@/lib/analytics/estimate";
import { groupSizes, histogram } from "@/lib/analytics/groups";
import { seasonReviewStats } from "@/lib/analytics/review";
import {
  SITE_RADIUS_M,
  groupIntoSites,
  hasResult,
  isPlaced,
  siteSeries,
  type SeriesEntry,
} from "@/lib/analytics/surveys";
import { useOperator } from "@/lib/identity";
import { useT } from "@/lib/i18n";
import type { Footage } from "@/lib/types";

const GROUP_RADIUS_M = 5; // animals closer together than this are one group
const BARS = 20;          // more bars than this cannot be drawn honestly
const H = 64;             // bar chart height, px

/** The key for the row that holds every sortie with no coordinates. They form
 *  no site — there is nothing to cluster — but they counted real animals, and
 *  a record that quietly drops them is short by however many they found. */
const UNPLACED = "@@unplaced";

const isRetired = (f: Footage): boolean => (f.retiredAt ?? "").trim() !== "";

/* A date input speaks local calendar days; the archive speaks instants. These
   two convert between them explicitly rather than letting `new Date("2026-08-07")`
   decide — that parses as UTC midnight, which in Aktau is 05:00, so the first
   five hours of the first day of every period would fall outside it. */
function dayBounds(value: string, end: boolean): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  if (end) d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function toDayValue(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

type SiteRow = {
  key: string;
  /** The person's name for the place, when one has been typed. */
  name: string | null;
  centroid: { lat: number; lng: number } | null;
  footages: Footage[];
  /** The latest sortie that produced a count — what this site contributes. */
  latest: SeriesEntry<Footage> | null;
  /** Animals this site puts into the total. */
  contributes: number;
  low: number;
  high: number;
};

export default function ReportMode(){
  const { t, tp, lang } = useT();
  const footages = useFootageStore(s=>s.footages);
  const detections = useFootageStore(s=>s.detections);
  const loadedRuns = useFootageStore(s=>s.loadedRuns);
  const totalRuns = useFootageStore(s=>s.totalRuns);
  /* Who is at the keyboard, when anyone has said. Nobody having said is the
     default and a truthful record: the document prints "not recorded" rather
     than putting a name on a page nobody signed. */
  const [operator] = useOperator();

  const [step, setStep] = useState<1|2>(1);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [excluded, setExcluded] = useState<Set<string>>(()=> new Set());
  const [exporting, setExporting] = useState(false);

  /* The period defaults to the whole season, once there IS a season — the
     archive arrives over several hydrate passes, so the extent only becomes
     real some way into the session. Set once, and never again after the reader
     has touched either field: silently widening somebody's chosen fortnight
     back to the full season, mid-edit, would put six weeks of sorties into a
     document they thought they had scoped. */
  const touched = useRef(false);
  const extent = useMemo(()=> timeExtent(footages), [footages]);
  useEffect(()=>{
    if(touched.current || !extent) return;
    setFrom(toDayValue(extent.min));
    setTo(toDayValue(extent.max));
  },[extent]);

  const fromMs = dayBounds(from, false);
  const toMs = dayBounds(to, true);
  const periodBad = fromMs!=null && toMs!=null && toMs < fromMs;

  /* The period, applied. A sortie whose timestamp will not parse is KEPT: it
     is a real survey with a broken date, and hiding it would drop measured
     animals out of the record without saying so anywhere. */
  const inPeriod = useMemo(()=>{
    if(periodBad) return [] as Footage[];
    if(fromMs==null && toMs==null) return footages;
    return footages.filter(f=>{
      const ts = Date.parse(f?.uploadedAt ?? "");
      if(!Number.isFinite(ts)) return true;
      if(fromMs!=null && ts < fromMs) return false;
      if(toMs!=null && ts > toMs) return false;
      return true;
    });
  },[footages, fromMs, toMs, periodBad]);

  /* Three sets, kept apart on purpose. A WITHDRAWN sortie is evidence that has
     been retracted; a sortie WITHOUT A RESULT is a failed ingest that never
     became a survey. Neither belongs in a figure, and they are not the same
     claim, so each is counted and reported as its own line. */
  const retiredInPeriod = useMemo(()=> inPeriod.filter(isRetired), [inPeriod]);
  const livePeriod = useMemo(()=> inPeriod.filter(f=> !isRetired(f)), [inPeriod]);
  const counted = useMemo(()=> livePeriod.filter(hasResult), [livePeriod]);
  const withoutResult = livePeriod.length - counted.length;

  /* Sites, from the same clustering every other screen uses — the shared
     helper, so the record's site list and the map's chips cannot disagree
     about what counts as one haul-out. */
  const rows = useMemo<SiteRow[]>(()=>{
    const placed = counted.filter(isPlaced);
    const strays = counted.filter(f=> !isPlaced(f));
    const out: SiteRow[] = groupIntoSites(placed).map(site=>{
      const series = siteSeries(site);
      let latest: SeriesEntry<Footage> | null = null;
      for(let i=series.length-1; i>=0; i--){
        if(series[i].best!=null){ latest = series[i]; break; }
      }
      const best = latest?.best ?? 0;
      const band = latest?.band ?? null;
      return {
        key: site.siteId ?? `${site.centroid.lat.toFixed(4)},${site.centroid.lng.toFixed(4)}`,
        name: site.name,
        centroid: site.centroid,
        footages: site.footages,
        latest,
        contributes: best,
        low: band?.low ?? best,
        high: band?.high ?? best,
      };
    });
    if(strays.length){
      /* One row, and it is a SUM, not a latest: these sorties are not one
         place visited repeatedly — they are sorties with no place at all, so
         there is no "same haul-out counted twice" to protect against. This
         matches seasonEstimate(), which adds every unplaced count whole. */
      let sum = 0;
      for(const f of strays) sum += countOf(f);
      out.push({
        key: UNPLACED,
        name: null,
        centroid: null,
        footages: strays,
        latest: null,
        contributes: sum,
        low: sum,
        high: sum,
      });
    }
    return out;
  },[counted]);

  /* Selection is stored as what is OUT, not what is in: change the period and
     the sites that appear are in the record by default, which is what a person
     who just widened a date range means. A set of chosen keys would have
     silently excluded every newly-visible site. */
  const picked = useMemo(()=> rows.filter(r=> !excluded.has(r.key)), [rows, excluded]);
  const toggle = (key: string)=> setExcluded(prev=>{
    const next = new Set(prev);
    if(next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  /* The sorties the record actually stands on: every visit to every chosen
     site, which is what the PDF is handed and what every figure below counts.
     Not just the latest ones — the trust block is about the whole body of
     work, and the CSV-shaped question "how much flying is this" is the visits
     figure, not the sites figure. */
  const chosen = useMemo(()=> picked.flatMap(r=> r.footages), [picked]);

  /* The one estimate helper, so the total under the table is the same
     arithmetic as the season strip on Карта: one sortie per site, the latest
     that produced a count, plus every unplaced count whole. */
  const est = useMemo(()=> seasonEstimate(chosen), [chosen]);
  /* Sorties whose count is actually IN the total: one per placed site, and
     every unplaced sortie, because those are summed whole rather than reduced
     to a latest visit. Not `picked.length` — that would report the row count
     of a table whose last row stands for eleven flights. */
  const countedSorties = picked.reduce(
    (a,r)=> a + (r.key===UNPLACED ? r.footages.length : (r.latest ? 1 : 0)),
    0,
  );
  const low = picked.reduce((a,r)=> a + r.low, 0);
  const high = picked.reduce((a,r)=> a + r.high, 0);
  const degenerateBand = low===high;

  const review = useMemo(()=> seasonReviewStats(chosen), [chosen]);
  const reviewPct = Math.round(review.pct ?? 0);

  /* Surveyed ground. A sortie with no GSD has an UNKNOWN area, not a zero one,
     and a ground count has no footprint because nobody took a picture —
     counting either as "without GSD" blames it for a scale never applicable. */
  const area = useMemo(
    ()=> totalAreaM2(chosen.filter(f=> f.engine !== "manual")),
    [chosen],
  );
  const areaText = area.known ? formatArea(area.m2, lang) : null;
  const areaCaveat = [
    area.unknown ? t("dash.noGsd", { n: area.unknown }) : null,
    area.assumed ? t("dash.assumedGsd", { n: area.assumed }) : null,
  ].filter(Boolean).join(" · ") || undefined;

  /* ------------------------------------------------ absorbed from Dashboard */
  const shown = useMemo(
    ()=> detectionsFor(chosen, detections).filter(d=> d.status!=="false_positive"),
    [chosen, detections],
  );
  /* Group size is spatial: the engine counts one animal per point, so grouping
     comes from the coordinates. An aggregate marker (count !== 1) carries a
     whole run's band on ONE synthetic point and would render a haul-out of 562
     as a group of size 1 — it is excluded, and how many sorties could only
     contribute one is printed instead of swallowed. */
  const placedPoints = useMemo(
    ()=> shown.filter(d=> d.count===1 && Number.isFinite(d.lat) && Number.isFinite(d.lng)),
    [shown],
  );
  const aggregateOnly = useMemo(
    ()=> chosen.filter(f=> f.detections.some(d=> d.status!=="false_positive" && d.count>1)).length,
    [chosen],
  );
  const bins = useMemo(()=> histogram(groupSizes(placedPoints, GROUP_RADIUS_M)), [placedPoints]);
  const maxBin = Math.max(...bins.map(b=> b.count), 1);

  /* Chronological, one bar per sortie — the latest BARS of them. */
  const bars = useMemo(()=>{
    const list = [...chosen].sort((a,b)=> +new Date(a.uploadedAt) - +new Date(b.uploadedAt));
    return list.slice(-BARS).map(f=>({
      f,
      best: countOf(f),
      low: f.band?.low ?? null,
      high: f.band?.high ?? null,
    }));
  },[chosen]);
  const maxBar = Math.max(...bars.map(b=> Math.max(b.high ?? 0, b.best)), 1);
  const day = (iso: string) => formatDate(iso, lang, { day:"numeric", month:"short" });

  const largest = useMemo(()=>{
    let top: Footage | null = null;
    for(const f of chosen) if(!top || countOf(f)>countOf(top)) top = f;
    return top;
  },[chosen]);

  /* The engine's own reservations, verbatim and de-duplicated. Paraphrasing a
     caveat is editing evidence. */
  const engineCaveats = useMemo(()=>{
    const set = new Set<string>();
    for(const r of picked)
      for(const c of r.latest?.footage.caveats ?? [])
        if(typeof c==="string" && c.trim()) set.add(c.trim());
    return [...set];
  },[picked]);

  const degenerateSites = useMemo(
    ()=> picked.filter(r=> r.low===r.high).length,
    [picked],
  );
  const unplacedRow = rows.find(r=> r.key===UNPLACED);

  /* ------------------------------------------------------------- the export */
  /* jsPDF plus an embedded font is hundreds of kilobytes over the network
     before a page is drawn, and silence that long reads as a dead button. The
     rejection used to go nowhere at all — an offline export failed invisibly. */
  const onExportPDF = async ()=>{
    if(exporting || chosen.length===0) return;
    setExporting(true);
    try {
      const { exportReport } = await import("@/lib/export/pdf");
      await exportReport(chosen, lang, {
        operator,
        // The document's own stated period, not a brush position — the same
        // two dates the reader chose and the header prints.
        window: fromMs!=null && toMs!=null
          ? { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() }
          : null,
        loadedRuns,
        totalRuns,
      });
      toast.success(t("dash.exportOk"));
    } catch (e) {
      console.error("report export failed:", e);
      toast.error(t("dash.exportFail"));
    } finally {
      setExporting(false);
    }
  };

  const siteLabel = (r: SiteRow): string =>
    r.key===UNPLACED
      ? t("report.unplaced")
      : r.name ?? `${r.centroid?.lat.toFixed(2)}, ${r.centroid?.lng.toFixed(2)}`;

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-5 pb-14">
        <div className="flex items-baseline gap-4 min-w-0">
          <h1 className="text-page text-ink shrink-0">{t("nav.report")}</h1>
          <p className="text-xs text-ink3 min-w-0 leading-relaxed">{t("report.lead")}</p>
        </div>

        {/* Two steps, as tabs rather than a wizard that locks you forward:
            going back to change a date is the normal case, not a mistake. */}
        <div className="flex gap-7 border-b border-hair mt-4 mb-6">
          {([1,2] as const).map(n=>(
            <button
              key={n}
              type="button"
              onClick={()=> setStep(n)}
              aria-current={step===n || undefined}
              className={`pb-2.5 -mb-px text-sm border-b-2 transition-colors ${
                step===n ? "border-ink text-ink" : "border-transparent text-ink3 hover:text-ink2"
              }`}
            >
              <span className={`tnum mr-2 ${step===n ? "text-ink3" : "text-ink4"}`}>{n}</span>
              {/* Two literal t() calls, not one with a computed key: the i18n
                  checker walks `t("…")` call sites for real, and a key it
                  cannot see is a key nothing verifies. */}
              {n===1 ? t("report.step1") : t("report.step2")}
            </button>
          ))}
        </div>

        {/* ═════════════════════════════════════ step 1 — period and sites */}
        {step===1 && (
          <div className="grid grid-cols-1 xl:grid-cols-[340px_1fr] gap-9 items-start">
            <div className="min-w-0">
              <div className="pb-5">
                <SectionHead title={t("report.period")} />
                <div className="flex gap-4 mt-2.5">
                  <label className="flex-1 min-w-0">
                    <span className="label block mb-1">{t("report.from")}</span>
                    <input
                      type="date"
                      value={from}
                      onChange={e=>{ touched.current = true; setFrom(e.target.value); }}
                      className="w-full h-7 bg-transparent border-b border-line px-0 text-sm tnum focus:border-ink2 transition-colors"
                    />
                  </label>
                  <label className="flex-1 min-w-0">
                    <span className="label block mb-1">{t("report.to")}</span>
                    <input
                      type="date"
                      value={to}
                      onChange={e=>{ touched.current = true; setTo(e.target.value); }}
                      className="w-full h-7 bg-transparent border-b border-line px-0 text-sm tnum focus:border-ink2 transition-colors"
                    />
                  </label>
                </div>
                {periodBad
                  ? <p className="text-2xs text-bad mt-2.5">{t("report.periodBad")}</p>
                  : <p className="text-2xs text-ink3 mt-2.5 tnum">
                      {t("report.periodNote", { n: inPeriod.length, m: footages.length })}
                    </p>}
                <p className="text-2xs text-ink3 mt-1.5 leading-relaxed">{t("report.brushNote")}</p>
              </div>

              <div className="border-t border-hair pt-4">
                <SectionHead
                  title={t("report.sites")}
                  right={rows.length>0 ? (
                    <span className="flex items-baseline gap-3 text-2xs">
                      <button
                        onClick={()=> setExcluded(new Set())}
                        className="text-ink3 hover:text-ink transition-colors"
                      >
                        {t("report.selectAll")}
                      </button>
                      <button
                        onClick={()=> setExcluded(new Set(rows.map(r=> r.key)))}
                        className="text-ink3 hover:text-ink transition-colors"
                      >
                        {t("report.selectNone")}
                      </button>
                    </span>
                  ) : undefined}
                />
                {rows.length===0 ? (
                  <p className="text-sm text-ink3 mt-2.5">{t("report.sitesNone")}</p>
                ) : (
                  <div className="mt-2">
                    {rows.map(r=>(
                      <label
                        key={r.key}
                        className="flex items-baseline gap-2.5 px-2 -mx-2 py-1.5 cursor-pointer hover:bg-hover transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={!excluded.has(r.key)}
                          onChange={()=> toggle(r.key)}
                          className="relative top-0.5 w-3 h-3 accent-ink3"
                        />
                        <span className={`text-base truncate min-w-0 ${r.name || r.key===UNPLACED ? "" : "tnum"}`}>
                          {siteLabel(r)}
                        </span>
                        <span className="flex-1" />
                        <span className="tnum text-2xs text-ink3 shrink-0">
                          {r.footages.length>1 && (
                            <span className="text-ink4 mr-2">
                              {r.footages.length} {tp(r.footages.length, "unit.sorties")}
                            </span>
                          )}
                          {r.contributes}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
                {retiredInPeriod.length>0 && (
                  <p className="text-2xs text-ink3 mt-2.5 leading-relaxed">
                    {t("report.retiredNote", { n: retiredInPeriod.length })}
                  </p>
                )}
                {withoutResult>0 && (
                  <p className="text-2xs text-ink3 mt-1.5 leading-relaxed">
                    {t("report.noResultNote", { n: withoutResult })}
                  </p>
                )}
              </div>

              <div className="mt-5">
                <Button
                  variant="primary"
                  onClick={()=> setStep(2)}
                  disabled={picked.length===0}
                >
                  {t("report.build")}
                </Button>
                {picked.length===0 && (
                  <p className="text-2xs text-ink3 mt-2">{t("report.nothingPicked")}</p>
                )}
              </div>
            </div>

            {/* What the choices on the left add up to, before the document is
                built. The standing estimate is the one figure in the signal
                colour here, as everywhere else in the instrument. */}
            <div className="min-w-0 xl:border-l xl:border-hair xl:pl-9">
              <SectionHead title={t("report.whatIn")} />
              <dl className="mt-3">
                <Kv label={t("report.kvSites")} value={picked.length} />
                <Kv label={t("report.kvCounted")} value={countedSorties} />
                <Kv label={t("report.kvVisits")} value={chosen.length} />
                <Kv label={t("est.current")} value={est.current} tone="accent" />
                <Kv label={t("report.kvRange")} value={degenerateBand ? "—" : `${low}–${high}`} />
                <Kv
                  label={t("stat.area")}
                  value={areaText ? t("dash.areaHa", { v: areaText }) : "—"}
                  sub={areaCaveat}
                />
                <Kv
                  label={t("report.kvReviewed")}
                  value={review.reviewable>0 ? `${reviewPct}%` : "—"}
                />
              </dl>
              <p className="text-2xs text-ink3 leading-relaxed mt-4 pt-3.5 border-t border-hair">
                {t("report.oneVisit")}
              </p>
              <p className="text-2xs text-ink3 leading-relaxed mt-2">
                {t("est.basis", { km: SITE_RADIUS_M/1000 })}
              </p>
            </div>
          </div>
        )}

        {/* ═════════════════════════════════════════ step 2 — the record */}
        {step===2 && (
          <div className="min-w-0">
            <div className="flex items-center gap-3 mb-5">
              <Button onClick={()=> setStep(1)}>{t("report.back")}</Button>
              <Button
                variant="primary"
                icon="download"
                onClick={onExportPDF}
                disabled={exporting || chosen.length===0}
              >
                {exporting ? `${t("dash.exporting")}…` : t("report.download")}
              </Button>
              <span className="flex-1" />
              <span className="text-2xs text-ink3">{t("report.preview")}</span>
            </div>

            {picked.length===0 ? (
              <p className="text-sm text-ink3">{t("report.nothingPicked")}</p>
            ) : (
              <>
                {/* ------------------------------------------ the document */}
                <div className="max-w-[820px]">
                  <h2 className="text-title text-ink">{t("rep.title")}</h2>
                  <p className="text-xs text-ink3 tnum mt-1">
                    {t("report.aktSub", {
                      from: fromMs!=null ? formatDate(new Date(fromMs).toISOString(), lang) : "—",
                      to: toMs!=null ? formatDate(new Date(toMs).toISOString(), lang) : "—",
                      now: formatDate(new Date().toISOString(), lang),
                    })}
                  </p>
                  <p className="text-xs text-ink3 mt-0.5">
                    {operator ? t("rep.compiledBy", { who: operator }) : t("rep.compiledByNobody")}
                    {/* A document built from a partly-loaded archive that does
                        not admit it reads as the whole season. */}
                    {totalRuns!=null && totalRuns>loadedRuns && (
                      <> · <span className="tnum">{t("report.loaded", { n: loadedRuns, m: totalRuns })}</span></>
                    )}
                  </p>

                  <div className="mt-6 overflow-x-auto">
                    <table className="w-full border-collapse text-sm">
                      <thead>
                        <tr>
                          <Th>{t("report.colSite")}</Th>
                          <Th>{t("report.colCoords")}</Th>
                          <Th>{t("rep.colDate")}</Th>
                          <Th>{t("report.colMaterial")}</Th>
                          <Th right>{t("report.colVisits")}</Th>
                          <Th right title={t("report.colDelta")}>Δ</Th>
                          <Th right>{t("rep.colCount")}</Th>
                          <Th right>{t("report.colRange")}</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {picked.map(r=>{
                          const f = r.latest?.footage ?? null;
                          const d = r.latest?.delta ?? null;
                          const name = f?.engine==="manual" ? t("rec.manual.title") : (f?.filename || t("report.noFile"));
                          return (
                            <tr key={r.key} className="border-b border-hair align-top">
                              <Td>
                                <span className={r.name || r.key===UNPLACED ? "" : "tnum"}>{siteLabel(r)}</span>
                              </Td>
                              <Td num>
                                {r.centroid
                                  ? `${r.centroid.lat.toFixed(3)} / ${r.centroid.lng.toFixed(3)}`
                                  : "—"}
                              </Td>
                              <Td num>
                                {r.latest ? formatDate(r.latest.uploadedAt, lang) : "—"}
                              </Td>
                              <Td num>
                                <span className="block max-w-[190px] truncate" title={name}>
                                  {r.key===UNPLACED
                                    ? `${r.footages.length} ${tp(r.footages.length, "unit.sorties")}`
                                    : name}
                                </span>
                              </Td>
                              <Td num right>{r.footages.length}</Td>
                              {/* No delta when either side has no count — a gap
                                  is not a zero, and a Δ across one is invented. */}
                              <Td num right>
                                {d
                                  ? <span className="text-ink">{d.abs>=0 ? "+" : ""}{d.abs}</span>
                                  : <span className="text-ink4">—</span>}
                              </Td>
                              <Td num right>
                                <span className="text-ink">{r.contributes}</span>
                              </Td>
                              <Td num right>
                                {r.low===r.high ? <span className="text-ink4">—</span> : `${r.low}–${r.high}`}
                              </Td>
                            </tr>
                          );
                        })}
                        <tr className="border-t border-line">
                          <td colSpan={6} className="pt-3 pr-4 text-sm text-ink2">
                            {t("report.totalRow", { n: picked.length })}
                          </td>
                          <td className="pt-3 pr-4 text-right">
                            <span className="tnum text-fig text-accent leading-none">{est.current}</span>
                          </td>
                          <td className="pt-3 text-right">
                            <span className="tnum text-lead text-ink">
                              {degenerateBand ? "—" : `${low}–${high}`}
                            </span>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  {/* Caveats — every reservation that applies to the figures
                      directly above, in the same document rather than in a
                      panel somebody may not have opened. */}
                  <div className="mt-8 pt-6 border-t border-hair">
                    <SectionHead title={t("rep.caveats")} />
                    <ul className="mt-2.5 pl-4 list-disc space-y-1.5 text-xs text-ink2 leading-relaxed marker:text-ink4">
                      {engineCaveats.map(c=> <li key={c}>{c}</li>)}
                      {areaCaveat && <li>{areaCaveat}</li>}
                      {review.reviewable>0 && (
                        <li>
                          {t("dash.verifiedOf", { n: review.ruled, r: review.reviewable, pct: reviewPct })}
                          {" "}
                          {t("dash.ruledSplit", { v: review.verified, x: review.rejected })}
                        </li>
                      )}
                      {review.unreviewable>0 && (
                        <li>{t("dash.plusUnreviewable", { n: review.unreviewable })}</li>
                      )}
                      {degenerateSites>0 && (
                        <li>{t("report.degenerate", { n: degenerateSites, m: picked.length })}</li>
                      )}
                      {unplacedRow && (
                        <li>{t("report.unplacedNote", { n: unplacedRow.footages.length })}</li>
                      )}
                      {retiredInPeriod.length>0 && (
                        <li>{t("report.retiredNote", { n: retiredInPeriod.length })}</li>
                      )}
                      {withoutResult>0 && <li>{t("report.noResultNote", { n: withoutResult })}</li>}
                    </ul>
                    <p className="text-2xs text-ink3 leading-relaxed mt-4">{t("report.oneVisit")}</p>
                  </div>
                </div>

                {/* ------------ what the record rests on, measured, in full.
                    Everything below this line is the old Аналитика panel,
                    scoped to the selection instead of to a brush. */}
                <div className="mt-10 pt-6 border-t border-line max-w-[820px]">
                  {/* One bar per sortie, with the band's low–high as a whisker */}
                  <div className="pb-7">
                    <SectionHead
                      title={t("dash.perSortie")}
                      right={chosen.length>BARS
                        ? <span className="text-2xs text-ink3">{t("dash.lastN", { n: BARS })}</span>
                        : undefined}
                    />
                    {bars.length===0
                      ? <p className="text-sm text-ink3 mt-2.5">{t("dash.noSorties")}</p>
                      : (
                        <>
                          <div className="flex items-end gap-1 mt-3" style={{ height: H }}>
                            {bars.map(b=>{
                              const hasRange = b.low!=null && b.high!=null && b.high>b.low;
                              return (
                                <div
                                  key={b.f.id}
                                  title={`${b.f.filename || t("report.noFile")} · ${b.best}${hasRange ? ` (${b.low}–${b.high})` : ""}`}
                                  className="group flex-1 relative h-full flex items-end min-w-[3px]"
                                >
                                  {/* An echo of a number the table already
                                      prints, so the column sits on the
                                      decorative step; the whisker carries the
                                      band, which IS a fact, so it stays at the
                                      floor rather than below it. */}
                                  <div
                                    className="w-full bg-ink4 group-hover:bg-ink3 transition-colors"
                                    style={{ height: Math.max(2, (b.best/maxBar)*H) }}
                                  />
                                  {hasRange && (
                                    <div
                                      className="absolute left-1/2 -translate-x-1/2 w-px bg-ink3"
                                      style={{
                                        bottom: ((b.low as number)/maxBar)*H,
                                        height: Math.max(1, (((b.high as number)-(b.low as number))/maxBar)*H),
                                      }}
                                    />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          <div className="flex items-baseline justify-between text-2xs text-ink3 tnum mt-1.5">
                            <span>{day(bars[0].f.uploadedAt)}</span>
                            <span>{day(bars[bars.length-1].f.uploadedAt)}</span>
                          </div>
                        </>
                      )}
                  </div>

                  {/* Group size — measured off the coordinates, not off a
                      count field the engine never wrote. */}
                  <div className="py-7 border-t border-hair">
                    <SectionHead
                      title={t("dash.groupSize")}
                      right={<span className="text-2xs text-ink3">{t("dash.groupSizeHint", { r: GROUP_RADIUS_M })}</span>}
                    />
                    {placedPoints.length===0
                      ? (
                        <p className="text-sm text-ink3 mt-2.5">
                          {t("dash.noPlaced")}
                          {aggregateOnly>0 && <> {t("dash.aggregateOnly", { n: aggregateOnly })}</>}
                        </p>
                      )
                      : (
                        <div className="mt-3 flex gap-2 max-w-[420px]">
                          {bins.map(b=>(
                            <div key={b.label} className="flex-1 flex flex-col items-center gap-1.5">
                              <div className="h-12 w-full flex items-end">
                                <div
                                  className={`w-full ${b.count ? "bg-ink4" : "bg-hair"}`}
                                  style={{ height: Math.max(2, (b.count/maxBin)*48) }}
                                />
                              </div>
                              <span className={`text-2xs tnum ${b.count ? "text-ink" : "text-ink3"}`}>{b.count}</span>
                              <span className="text-2xs text-ink3">{b.label}</span>
                            </div>
                          ))}
                        </div>
                      )}
                  </div>

                  {/* Verification. 0% over points that exist is a fact worth
                      printing; 0% over NO points is a different claim, and
                      animals with no reviewable row at all are a third. */}
                  <div className="py-7 border-t border-hair">
                    <SectionHead title={t("dash.verification")} />
                    {review.total===0
                      ? <p className="text-sm text-ink3 mt-2.5">{t("dash.nothingToVerify")}</p>
                      : review.reviewable===0
                        ? <p className="text-sm text-ink3 mt-2.5">{t("dash.onlyUnreviewable", { n: review.unreviewable })}</p>
                        : <>
                            <p className="text-sm text-ink2 tnum mt-2.5">
                              {t("dash.verifiedOf", { n: review.ruled, r: review.reviewable, pct: reviewPct })}
                            </p>
                            <p className="text-2xs text-ink3 tnum mt-1.5 leading-relaxed">
                              {t("dash.ruledSplit", { v: review.verified, x: review.rejected })}
                            </p>
                            {review.unreviewable>0 && (
                              <p className="text-2xs text-ink3 tnum mt-1.5 leading-relaxed">
                                {t("dash.plusUnreviewable", { n: review.unreviewable })}
                              </p>
                            )}
                          </>}
                  </div>

                  {/* How far any of the above can be trusted, in measured terms
                      only. Mounted whole — the honesty machinery is not
                      re-implemented for a new home. */}
                  <div className="-mx-4 border-t border-hair">
                    <TrustPanel
                      footages={chosen}
                      retired={retiredInPeriod}
                      withoutResult={withoutResult}
                    />
                  </div>

                  {/* Derived summary — sentences the app assembled out of the
                      figures above. NOT "Notes": a field note is a person's
                      observation and lives on the sortie that person flew. */}
                  <div className="py-7">
                    <SectionHead title={t("dash.derivedTitle")} />
                    <p className="text-sm text-ink2 mt-2.5 leading-relaxed">
                      {chosen.length===0
                        ? t("dash.notesEmpty")
                        : <>
                            {areaText ? t("dash.notesArea", { a: areaText }) : t("dash.notesNoArea")}
                            {review.reviewable>0 && <> {t("dash.notesVerifiedPct", { n: review.ruled, total: review.reviewable, pct: reviewPct })}</>}
                            {review.unreviewable>0 && <> {t("dash.notesUnreviewable", { n: review.unreviewable })}</>}
                            {largest && <> {t("dash.notesLargestSortie", { x: countOf(largest), sortie: largest.filename || t("report.noFile") })}</>}
                          </>}
                    </p>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Label left, figure right, hairline above — the instrument's one readout
 *  row. `sub` is where a figure's qualification lives, and it wraps rather
 *  than hiding behind a hover: an assumed scale under a hectare total is the
 *  whole meaning of that total. */
function Kv({
  label, value, sub, tone = "ink",
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: "ink" | "accent";
}){
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 py-1.5 border-t border-hair">
      <dt className="text-xs text-ink3 min-w-0">{label}</dt>
      <dd className={`tnum text-lead text-right ${tone==="accent" ? "text-accent" : "text-ink"}`}>
        {value}
      </dd>
      {sub && <dd className="col-span-2 text-2xs text-ink3 leading-tight mt-0.5">{sub}</dd>}
    </div>
  );
}

function Th({ children, right, title }: { children: React.ReactNode; right?: boolean; title?: string }){
  return (
    <th
      title={title}
      className={`label font-normal pb-2 pr-4 last:pr-0 border-b border-line whitespace-nowrap ${
        right ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function Td({
  children, num, right,
}: {
  children: React.ReactNode;
  num?: boolean;
  right?: boolean;
}){
  return (
    <td
      className={`py-2 pr-4 last:pr-0 ${right ? "text-right" : ""} ${
        num ? "tnum text-xs text-ink2" : "text-sm text-ink"
      }`}
    >
      {children}
    </td>
  );
}
