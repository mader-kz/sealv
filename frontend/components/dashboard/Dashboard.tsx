"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Icon from "@/components/ui/Icon";
import { Button, IconButton, Pill } from "@/components/ui/primitives";
import { useFootageStore } from "@/store/useFootageStore";
import { footagesInRange, formatDate } from "@/lib/analytics/brush";
import { applyLinkReviews, trackSealGroups, type MatchConfidence } from "@/lib/analytics/tracking";
import { detectRegionAvoidance } from "@/lib/analytics/avoidance";
import { useT } from "@/lib/i18n";

type Readiness = "available" | "capture" | "model";

const readiness: Record<Readiness, { label: string; dot: string; text: string }> = {
  available: { label: "Available now", dot: "bg-good", text: "text-good" },
  capture: { label: "Needs field data", dot: "bg-accent", text: "text-accent" },
  model: { label: "Needs validation", dot: "bg-ink3", text: "text-ink3" },
};

const surveySeries = [
  { date: "03 Feb", value: 842, comparable: true },
  { date: "06 Feb", value: 906, comparable: true },
  { date: "10 Feb", value: 791, comparable: false },
  { date: "14 Feb", value: 1048, comparable: true },
  { date: "18 Feb", value: 1175, comparable: true },
];

const sites = [
  { name: "Kulaly Island", date: "18 Feb", count: 486, pups: 174, coverage: 94, delta: 8.4, comparable: true },
  { name: "Durneva Islands", date: "18 Feb", count: 312, pups: 128, coverage: 87, delta: -3.1, comparable: true },
  { name: "Komsomolets Bay", date: "14 Feb", count: 241, pups: 82, coverage: 71, delta: null, comparable: false },
  { name: "Prorva coast", date: "10 Feb", count: 136, pups: 48, coverage: 63, delta: null, comparable: false },
];

const metadata = [
  { label: "Exact start / end time", value: 100, detail: "5 / 5 surveys" },
  { label: "Survey-unit coverage", value: 60, detail: "3 / 5 surveys" },
  { label: "Wind, visibility, precipitation", value: 40, detail: "2 / 5 surveys" },
  { label: "Sea-ice concentration", value: 100, detail: "5 / 5 surveys" },
  { label: "Pup / adult class", value: 0, detail: "0 / 5 surveys" },
  { label: "Disturbance response", value: 20, detail: "1 / 5 surveys" },
];

function DataState({ state, compact = false }: { state: Readiness; compact?: boolean }) {
  const item = readiness[state];
  return (
    <span className={`inline-flex items-center gap-1.5 ${compact ? "text-2xs" : "text-xs"} ${item.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${item.dot}`} />
      {item.label}
    </span>
  );
}

function Metric({
  label,
  value,
  note,
  state,
}: {
  label: string;
  value: string;
  note: string;
  state: Readiness;
}) {
  return (
    <div className="min-w-0 px-4 py-3.5 border-r border-line-soft last:border-r-0">
      <div className="flex items-center justify-between gap-2">
        <span className="label truncate">{label}</span>
        <DataState state={state} compact />
      </div>
      <div className="text-hero leading-none font-medium tnum text-ink mt-3">{value}</div>
      <p className="text-xs text-ink3 mt-2 leading-relaxed max-w-[260px]">{note}</p>
    </div>
  );
}

function Panel({
  title,
  eyebrow,
  action,
  children,
  className = "",
}: {
  title: string;
  eyebrow?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-line bg-surface overflow-hidden ${className}`}>
      <div className="min-h-12 px-4 py-3 flex items-center justify-between gap-3 border-b border-line-soft">
        <div className="min-w-0">
          {eyebrow && <div className="label mb-1.5">{eyebrow}</div>}
          <h2 className="text-sm font-medium text-ink truncate">{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function SurveyTrend() {
  const W = 660;
  const H = 194;
  const PAD_X = 34;
  const PAD_TOP = 17;
  const PAD_BOTTOM = 34;
  const min = 700;
  const max = 1250;
  const x = (i: number) => PAD_X + (i * (W - PAD_X * 2)) / (surveySeries.length - 1);
  const y = (v: number) => PAD_TOP + ((max - v) * (H - PAD_TOP - PAD_BOTTOM)) / (max - min);
  const path = surveySeries.map((d, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(d.value)}`).join(" ");

  return (
    <div className="px-4 pt-4 pb-2">
      <div className="flex items-center justify-between gap-3 mb-1">
        <div>
          <div className="text-xs text-ink3">Raw hauled-out count by survey day</div>
          <div className="text-2xs text-ink3 mt-1">Solid points met the comparability rules; the hollow point did not.</div>
        </div>
        <DataState state="available" compact />
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[194px] mt-1" role="img" aria-label="Observed seal counts across five survey dates">
        {[750, 1000, 1250].map((tick) => (
          <g key={tick}>
            <line x1={PAD_X} x2={W - PAD_X} y1={y(tick)} y2={y(tick)} stroke="var(--line-soft)" />
            <text x={PAD_X - 8} y={y(tick) + 3} textAnchor="end" fill="var(--ink-3)" fontSize="9">{tick.toLocaleString()}</text>
          </g>
        ))}
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" />
        {surveySeries.map((d, i) => (
          <g key={d.date}>
            <circle cx={x(i)} cy={y(d.value)} r="4" fill={d.comparable ? "var(--accent)" : "var(--surface)"} stroke="var(--accent)" strokeWidth="2" />
            <text x={x(i)} y={H - 11} textAnchor="middle" fill="var(--ink-3)" fontSize="9">{d.date}</text>
            {i === surveySeries.length - 1 && (
              <text x={x(i) - 5} y={y(d.value) - 10} textAnchor="end" fill="var(--ink)" fontSize="10" fontWeight="500">1,175</text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}

function MissingEstimate() {
  return (
    <div className="p-4 h-full flex flex-col">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="label">Population estimate</div>
          <div className="text-fig text-ink mt-2 tnum">Not estimable yet</div>
        </div>
        <DataState state="model" compact />
      </div>
      <p className="text-xs text-ink2 leading-relaxed mt-2">
        The archive can report animals seen on the ice. It cannot yet infer animals missed by the camera or unavailable to be seen.
      </p>
      <div className="mt-4 space-y-2">
        {[
          { label: "Observed hauled-out count", value: "1,175", done: true },
          { label: "Coverage correction", value: "missing", done: false },
          { label: "Detection probability", value: "missing", done: false },
          { label: "Availability correction", value: "missing", done: false },
          { label: "Estimate + 95% CI / CV", value: "pending", done: false },
        ].map((row) => (
          <div key={row.label} className="flex items-center gap-2 text-xs">
            <span className={`w-4 h-4 rounded-full grid place-items-center border ${row.done ? "border-good/40 text-good" : "border-line text-ink3"}`}>
              {row.done ? <Icon name="check" size={10} /> : <span className="w-1 h-1 rounded-full bg-ink3" />}
            </span>
            <span className="text-ink2 flex-1">{row.label}</span>
            <span className={`tnum ${row.done ? "text-ink" : "text-ink3"}`}>{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SiteTable() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-xs">
        <thead>
          <tr className="text-left text-ink3 border-b border-line-soft">
            <th className="font-normal px-4 py-2.5">Survey unit</th>
            <th className="font-normal px-3 py-2.5">Latest survey</th>
            <th className="font-normal px-3 py-2.5 text-right">Observed</th>
            <th className="font-normal px-3 py-2.5 text-right">Pups</th>
            <th className="font-normal px-3 py-2.5 text-right">Coverage</th>
            <th className="font-normal px-3 py-2.5 text-right">vs previous</th>
            <th className="font-normal px-4 py-2.5">Comparability</th>
          </tr>
        </thead>
        <tbody>
          {sites.map((site) => (
            <tr key={site.name} className="border-b border-line-soft last:border-b-0 hover:bg-surface2/40">
              <td className="px-4 py-3 text-ink font-medium">{site.name}</td>
              <td className="px-3 py-3 text-ink3 tnum">{site.date}</td>
              <td className="px-3 py-3 text-right text-ink tnum">{site.count}</td>
              <td className="px-3 py-3 text-right text-ink tnum">{site.pups}</td>
              <td className="px-3 py-3 text-right text-ink tnum">{site.coverage}%</td>
              <td className={`px-3 py-3 text-right tnum ${site.delta == null ? "text-ink3" : site.delta >= 0 ? "text-good" : "text-bad"}`}>
                {site.delta == null ? "—" : `${site.delta > 0 ? "+" : ""}${site.delta}%`}
              </td>
              <td className="px-4 py-3">
                {site.comparable ? <Pill tone="good">Comparable</Pill> : <Pill>Baseline only</Pill>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Composition() {
  const groups = [
    { label: "Pups", value: 432, pct: 37, color: "bg-accent" },
    { label: "Adult females", value: 448, pct: 38, color: "bg-good" },
    { label: "Other adults", value: 207, pct: 18, color: "bg-ink2" },
    { label: "Unclassified", value: 88, pct: 7, color: "bg-ink3" },
  ];
  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs text-ink3">Latest comparable survey</span>
        <DataState state="capture" compact />
      </div>
      <div className="h-3 rounded-full overflow-hidden flex bg-surface2">
        {groups.map((group) => <div key={group.label} className={group.color} style={{ width: `${group.pct}%` }} />)}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 mt-4">
        {groups.map((group) => (
          <div key={group.label} className="flex items-center gap-2 min-w-0">
            <span className={`w-2 h-2 rounded-sm ${group.color}`} />
            <span className="text-xs text-ink3 truncate flex-1">{group.label}</span>
            <span className="text-xs text-ink tnum">{group.value}</span>
            <span className="text-2xs text-ink3 tnum w-7 text-right">{group.pct}%</span>
          </div>
        ))}
      </div>
      <p className="text-2xs text-ink3 leading-relaxed mt-4 pt-3 border-t border-line-soft">
        Illustrative until life-stage classes are stored per detection or independent counter record.
      </p>
    </div>
  );
}

function Coverage() {
  const units = [94, 87, 71, 63, 0, 0];
  return (
    <div className="p-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="text-fig text-ink tnum">4 / 6</div>
          <div className="text-xs text-ink3 mt-1">target survey units visited</div>
        </div>
        <DataState state="capture" compact />
      </div>
      <div className="grid grid-cols-6 gap-1.5 mt-4">
        {units.map((value, i) => (
          <div key={i} className="h-20 rounded bg-surface2 relative overflow-hidden" title={value ? `${value}% covered` : "Not surveyed"}>
            <div className={`absolute inset-x-0 bottom-0 ${value >= 80 ? "bg-good" : value ? "bg-accent" : "bg-line"}`} style={{ height: `${Math.max(value, 5)}%` }} />
            <span className="absolute inset-x-0 bottom-1.5 text-center text-2xs text-ink tnum">{value ? `${value}%` : "—"}</span>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 mt-4 pt-3 border-t border-line-soft">
        <div>
          <div className="label">Unique area</div>
          <div className="text-sm text-ink mt-1.5 tnum">18.4 km² <span className="text-2xs text-ink3">mock</span></div>
        </div>
        <div>
          <div className="label">Sampling fraction</div>
          <div className="text-sm text-ink mt-1.5 tnum">11% <span className="text-2xs text-ink3">target</span></div>
        </div>
      </div>
      <div className="text-2xs text-ink3 mt-3">5 surveys · 3 full · 2 partial · 2 comparable repeats</div>
    </div>
  );
}

function EcologicalIndicators() {
  const rows = [
    { label: "Pup : adult-female ratio", value: "0.96", state: "capture" as const },
    { label: "Observed density", value: "64 / km²", state: "capture" as const },
    { label: "Occupied survey units", value: "4 / 6", state: "capture" as const },
    { label: "Median haul-out shift", value: "4.8 km", state: "capture" as const },
    { label: "Distance to ice edge", value: "18 km", state: "capture" as const },
    { label: "Human disturbance", value: "1 event", state: "capture" as const },
  ];
  return (
    <div className="divide-y divide-line-soft">
      {rows.map((row) => (
        <div key={row.label} className="px-4 py-2.5 flex items-center gap-3">
          <span className="text-xs text-ink2 min-w-0 flex-1">{row.label}</span>
          <span className="text-xs text-ink tnum shrink-0">{row.value}</span>
          <span className={`w-1.5 h-1.5 rounded-full ${readiness[row.state].dot}`} title={readiness[row.state].label} />
        </div>
      ))}
      <p className="px-4 py-3 text-2xs text-ink3 leading-relaxed">
        Density uses the matching unique footprint; movement and ice-edge distance need fixed site geometry and environmental layers.
      </p>
    </div>
  );
}

function MetadataCompleteness() {
  return (
    <div className="p-4 space-y-3">
      {metadata.map((item) => (
        <div key={item.label}>
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="text-ink2 truncate">{item.label}</span>
            <span className="text-ink3 tnum shrink-0">{item.detail}</span>
          </div>
          <div className="h-1.5 rounded-full bg-surface2 mt-1.5 overflow-hidden">
            <div className={`h-full rounded-full ${item.value === 100 ? "bg-good" : item.value === 0 ? "bg-line" : "bg-accent"}`} style={{ width: `${Math.max(item.value, 1)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function QualityGrid() {
  const cards = [
    { label: "Detection review", value: "84%", note: "1,103 / 1,313 points decided", state: "available" as const },
    { label: "False-positive rate", value: "4.8%", note: "On reviewed detections; not recall", state: "available" as const },
    { label: "Frames processed", value: "96%", note: "1,442 / 1,501 usable frames", state: "available" as const },
    { label: "Georeferenced animals", value: "91%", note: "Points with usable coordinates", state: "available" as const },
    { label: "Independent counters", value: "0 / 5", note: "Needed to measure observer agreement", state: "capture" as const },
    { label: "Detector recall", value: "Unknown", note: "Requires held-out human-labelled frames", state: "model" as const },
  ];
  return (
    <div className="grid sm:grid-cols-2 xl:grid-cols-3">
      {cards.map((card) => (
        <div key={card.label} className="p-4 border-r border-b border-line-soft last:border-b-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-ink3">{card.label}</span>
            <DataState state={card.state} compact />
          </div>
          <div className="text-lead font-medium text-ink tnum mt-2">{card.value}</div>
          <div className="text-2xs text-ink3 mt-1">{card.note}</div>
        </div>
      ))}
    </div>
  );
}

function DataGaps() {
  const items = [
    { title: "Define fixed survey units", note: "Name polygons/transects and record full, partial or reconnaissance coverage.", tag: "P0" },
    { title: "Capture observation conditions", note: "Exact time, wind, visibility, precipitation, ice, sea state and disturbance.", tag: "P0" },
    { title: "Classify animals", note: "Pup, adult female, other adult and unknown—without forcing a class.", tag: "P1" },
    { title: "Correct overlapping footprints", note: "Use unique covered area and flown transect length, not frame-area sums.", tag: "P1" },
    { title: "Run an independent count study", note: "Two counters plus adjudication when disagreement exceeds the protocol threshold.", tag: "P2" },
    { title: "Validate detection and availability", note: "Estimate precision, recall and missed animals before publishing adjusted abundance.", tag: "P2" },
  ];
  return (
    <div className="divide-y divide-line-soft">
      {items.map((item) => (
        <div key={item.title} className="px-4 py-3 flex items-start gap-3">
          <Pill tone={item.tag === "P0" ? "accent" : "neutral"}>{item.tag}</Pill>
          <div className="min-w-0">
            <div className="text-xs text-ink">{item.title}</div>
            <div className="text-2xs text-ink3 mt-0.5 leading-relaxed">{item.note}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function TrackedGroups({ onFocusMap }: { onFocusMap?: () => void }) {
  const { t, lang } = useT();
  const footages = useFootageStore((s) => s.footages);
  const timeRange = useFootageStore((s) => s.timeRange);
  const trackingOptions = useFootageStore((s) => s.trackingOptions);
  const setTrackingOption = useFootageStore((s) => s.setTrackingOption);
  const selectedPopulationId = useFootageStore((s) => s.selectedPopulationId);
  const selectPopulation = useFootageStore((s) => s.selectPopulation);
  const populations = useFootageStore((s) => s.populations);
  const populationReviews = useFootageStore((s) => s.populationReviews);
  const trackPopulationIds = useFootageStore((s) => s.trackPopulationIds);
  const populationSyncState = useFootageStore((s) => s.populationSyncState);
  const populationError = useFootageStore((s) => s.populationError);
  const syncTrackedPopulations = useFootageStore((s) => s.syncTrackedPopulations);
  const renameTrackedPopulation = useFootageStore((s) => s.renameTrackedPopulation);
  const reviewTrackedLink = useFootageStore((s) => s.reviewTrackedLink);
  const [expandedTrackId, setExpandedTrackId] = useState<string | null>(null);
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const { groupRadiusM: radiusM, sizeTolerancePct, maxSpeedKmPerDay, maxGapDays } = trackingOptions;

  const visible = useMemo(
    () => footagesInRange(footages, timeRange),
    [footages, timeRange],
  );
  const automaticResult = useMemo(
    () => trackSealGroups(visible, trackingOptions),
    [visible, trackingOptions],
  );
  const result = useMemo(
    () => applyLinkReviews(automaticResult, populationReviews),
    [automaticResult, populationReviews],
  );
  const persistableTracks = useMemo(() => {
    const realIds = new Set(visible.filter((footage) => footage.source !== "test").map((footage) => footage.id));
    return result.tracks.map((track) => ({
      id: track.id,
      observations: track.observations.filter((observation) => realIds.has(observation.surveyId)).map((observation) => ({
        id: observation.id,
        surveyId: observation.surveyId,
        observedAt: observation.observedAt,
        center: observation.center,
        size: observation.size,
        source: observation.source,
        memberIds: observation.memberIds,
      })),
    })).filter((track) => track.observations.length > 0);
  }, [result.tracks, visible]);
  const persistPayload = useMemo(
    () => persistableTracks.length > 0 ? JSON.stringify(persistableTracks) : "",
    [persistableTracks],
  );
  useEffect(() => {
    if (!persistPayload) return;
    void syncTrackedPopulations(JSON.parse(persistPayload));
  }, [persistPayload, syncTrackedPopulations]);
  const moving = useMemo(
    () => result.tracks
      .filter((track) => track.observations.length >= 2)
      .sort((a, b) =>
        b.observations.length - a.observations.length ||
        b.totalDistanceKm - a.totalDistanceKm ||
        a.ordinal - b.ordinal,
      ),
    [result.tracks],
  );

  const confidenceText = (value: MatchConfidence | null) =>
    value === "high" ? t("track.high") : value === "medium" ? t("track.medium") : t("track.low");
  const tone = (value: MatchConfidence | null) =>
    value === "high" ? "good" as const : value === "medium" ? "accent" as const : "neutral" as const;
  const anomalyText = (kind: "speed" | "sharp_turn" | "unusual_interval" | "route_deviation") =>
    kind === "speed" ? t("track.anomalySpeed")
      : kind === "sharp_turn" ? t("track.anomalySharpTurn")
        : kind === "unusual_interval" ? t("track.anomalyInterval") : t("track.anomalyRoute");
  const anomalyUnit = (kind: "speed" | "sharp_turn" | "unusual_interval" | "route_deviation") =>
    kind === "speed" ? "km/d" : kind === "sharp_turn" ? "°" : kind === "unusual_interval" ? "d" : "km";
  const fmt = useMemo(() => new Intl.NumberFormat(lang === "kk" ? "kk-KZ" : lang === "ru" ? "ru-RU" : "en", {
    maximumFractionDigits: 1,
  }), [lang]);

  const settings = [
    {
      label: t("track.radius"), value: radiusM, key: "groupRadiusM" as const,
      values: [3, 5, 10, 25], unit: "m",
    },
    {
      label: t("track.sizeTolerance"), value: sizeTolerancePct, key: "sizeTolerancePct" as const,
      values: [20, 40, 60, 100], unit: "%",
    },
    {
      label: t("track.maxSpeed"), value: maxSpeedKmPerDay, key: "maxSpeedKmPerDay" as const,
      values: [10, 32.6, 60, 100, 173], unit: "km/d",
    },
    {
      label: t("track.maxGap"), value: maxGapDays, key: "maxGapDays" as const,
      values: [7, 14, 30, 90], unit: "d",
    },
  ];

  return (
    <Panel
      title={t("track.title")}
      eyebrow={t("track.eyebrow")}
      action={
        <Pill tone={populationSyncState === "synced" ? "good" : "accent"}>
          {populationSyncState === "synced" ? t("track.persisted") : t("track.inferred")}
        </Pill>
      }
    >
      <div className="px-4 py-3 border-b border-line-soft">
        <p className="text-xs text-ink2 leading-relaxed max-w-[980px]">{t("track.explain")}</p>
        <div className="flex flex-wrap gap-2 mt-3">
          {settings.map((setting) => (
            <label key={setting.label} className="flex items-center gap-2 rounded border border-line bg-surface2 px-2 py-1.5">
              <span className="text-2xs text-ink3">{setting.label}</span>
              <select
                value={setting.value}
                onChange={(event) => setTrackingOption(setting.key, Number(event.target.value))}
                className="bg-transparent text-xs text-ink tnum focus:outline-none"
              >
                {setting.values.map((value) => <option key={value} value={value}>{value} {setting.unit}</option>)}
              </select>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-2xs text-ink3 tnum">
          <span>{t("track.routes", { n: moving.length })}</span>
          <span>{t("track.events", { n: result.events?.length ?? 0 })}</span>
          <span>{t("track.anomalies", { n: result.tracks.reduce((sum, track) => sum + (track.anomalies?.length ?? 0), 0) })}</span>
          {result.untrackedAnimals > 0 && <span>{t("track.singletons", { n: result.untrackedAnimals })}</span>}
          <span>{t("track.params", { r: radiusM, size: sizeTolerancePct, speed: maxSpeedKmPerDay, days: maxGapDays })}</span>
        </div>
        {populationError && persistableTracks.length > 0 && (
          <p className="text-2xs text-ink3 mt-2" title={populationError}>{t("track.notPersisted")}</p>
        )}
      </div>

      {(result.events?.length ?? 0) > 0 && (
        <div className="px-4 py-3 border-b border-line-soft bg-surface2/25">
          <div className="label mb-2">{t("track.eventDetails")}</div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {result.events.map((event) => (
              <div key={event.id} className="min-w-[210px] rounded border border-line bg-surface px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <Pill tone="accent">{event.type === "split" ? t("track.eventSplit") : t("track.eventMerge")}</Pill>
                  <span className="text-2xs text-ink3 tnum">
                    {formatDate(event.occurredAt, lang, { day: "numeric", month: "short", year: "numeric" })}
                  </span>
                </div>
                <div className="text-xs text-ink tnum mt-2">
                  {t("track.eventSizes", { before: event.sizeBefore, after: event.sizeAfter })}
                </div>
                <div className="text-2xs text-ink3 mt-1">
                  {confidenceText(event.confidence)} · Δ {fmt.format(event.sizeConservationPct)}%
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {moving.length === 0 ? (
        <p className="px-4 py-6 text-sm text-ink3">{t("track.empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-xs">
            <thead>
              <tr className="text-left text-ink3 border-b border-line-soft">
                <th className="font-normal px-4 py-2.5">{t("track.group")}</th>
                <th className="font-normal px-3 py-2.5 text-right">{t("track.sightings")}</th>
                <th className="font-normal px-3 py-2.5 text-right">{t("track.size")}</th>
                <th className="font-normal px-3 py-2.5 text-right">{t("track.distance")}</th>
                <th className="font-normal px-3 py-2.5">{t("track.lastSeen")}</th>
                <th className="font-normal px-4 py-2.5">{t("track.confidence")}</th>
              </tr>
            </thead>
            <tbody>
              {moving.slice(0, 20).map((track) => {
                const first = track.observations[0];
                const latest = track.observations[track.observations.length - 1];
                const populationId = trackPopulationIds[track.id];
                const population = populations.find((item) => item.id === populationId);
                const expanded = expandedTrackId === track.id;
                return (
                  <Fragment key={track.id}>
                    <tr
                      className={`border-b border-line-soft cursor-pointer hover:bg-surface2/40 ${selectedPopulationId === track.id ? "bg-accent-soft" : ""}`}
                      onClick={() => setExpandedTrackId(expanded ? null : track.id)}
                    >
                      <td className="px-4 py-3 text-ink font-medium">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          className="inline-flex items-center gap-1.5 text-left"
                          onClick={(event) => {
                            event.stopPropagation();
                            setExpandedTrackId(expanded ? null : track.id);
                          }}
                        >
                          <span className="text-ink3" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
                          <span>{population?.name ?? <span className="tnum">#{String(track.ordinal).padStart(2, "0")}</span>}</span>
                        </button>
                        {latest.source === "aggregate" && <span className="ml-2"><Pill>{t("track.aggregate")}</Pill></span>}
                      </td>
                      <td className="px-3 py-3 text-right text-ink tnum">{track.observations.length}</td>
                      <td className="px-3 py-3 text-right text-ink tnum">{first.size} → {latest.size}</td>
                      <td className="px-3 py-3 text-right text-ink tnum">{fmt.format(track.totalDistanceKm)} km</td>
                      <td className="px-3 py-3 text-ink3 tnum">
                        {formatDate(latest.observedAt, lang, { day: "numeric", month: "short", year: "numeric" })}
                      </td>
                      <td className="px-4 py-3">
                        <Pill tone={tone(track.confidence)}>{confidenceText(track.confidence)}</Pill>
                        {track.ambiguous && <span className="block text-2xs text-ink3 mt-1">{t("track.ambiguous")}</span>}
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="border-b border-line-soft bg-surface2/30">
                        <td colSpan={6} className="px-4 py-4">
                          <div className="flex flex-wrap items-end gap-3">
                            <label className="min-w-[220px]">
                              <span className="block text-2xs text-ink3 mb-1">{t("track.rename")}</span>
                              <input
                                value={nameDrafts[populationId] ?? population?.name ?? `#${String(track.ordinal).padStart(2, "0")}`}
                                disabled={!populationId}
                                onChange={(event) => populationId && setNameDrafts((drafts) => ({ ...drafts, [populationId]: event.target.value }))}
                                onBlur={(event) => {
                                  if (populationId && event.target.value.trim() && event.target.value.trim() !== population?.name) {
                                    void renameTrackedPopulation(populationId, event.target.value.trim());
                                  }
                                }}
                                className="h-8 w-full rounded border border-line bg-surface px-2 text-xs text-ink disabled:text-ink3"
                              />
                            </label>
                            <button
                              type="button"
                              onClick={() => {
                                selectPopulation(track.id, latest.id);
                                onFocusMap?.();
                              }}
                              className="h-8 rounded border border-line bg-surface px-3 text-xs text-ink hover:border-accent"
                            >
                              {t("track.focusMap")}
                            </button>
                            {track.prediction && (
                              <span className="text-xs text-ink3 tnum">
                                {t("track.prediction")}: {Math.round(track.prediction.bearingDeg)}° · {fmt.format(track.prediction.distanceKm)} km
                              </span>
                            )}
                            {(track.anomalies?.length ?? 0) > 0 && (
                              <Pill tone="accent">{t("track.anomalies", { n: track.anomalies?.length ?? 0 })}</Pill>
                            )}
                          </div>
                          <div className="mt-4">
                            <div className="label mb-2">{t("track.snapshots")}</div>
                            <div className="flex gap-2 overflow-x-auto pb-1">
                              {track.observations.map((observation, index) => {
                                const previous = index > 0 ? track.observations[index - 1] : null;
                                const review = previous ? populationReviews.find((item) =>
                                  item.from_observation_id === previous.id
                                  && item.to_observation_id === observation.id) : null;
                                return (
                                  <div key={observation.id} className="min-w-[190px] rounded border border-line bg-surface p-2.5">
                                    <button
                                      type="button"
                                      className="w-full text-left"
                                      onClick={() => {
                                        selectPopulation(track.id, observation.id);
                                        onFocusMap?.();
                                      }}
                                    >
                                      <div className="text-xs text-ink font-medium tnum">{t("track.size")}: {observation.size}</div>
                                      <div className="text-2xs text-ink3 mt-1 tnum">
                                        {formatDate(observation.observedAt, lang, { day: "numeric", month: "short", year: "numeric" })}
                                      </div>
                                    </button>
                                    {previous && (
                                      <div className="mt-2 pt-2 border-t border-line-soft flex items-center gap-1.5">
                                        {review ? (
                                          <Pill tone={review.decision === "confirmed" ? "good" : "neutral"}>
                                            {review.decision === "confirmed" ? t("track.confirmed") : t("track.rejected")}
                                          </Pill>
                                        ) : (
                                          <>
                                            <button
                                              type="button"
                                              disabled={!populationId}
                                              onClick={() => void reviewTrackedLink(previous.id, observation.id, "confirmed")}
                                              className="text-2xs text-good disabled:text-ink3"
                                            >{t("track.confirm")}</button>
                                            <span className="text-ink3">·</span>
                                            <button
                                              type="button"
                                              disabled={!populationId}
                                              onClick={() => void reviewTrackedLink(previous.id, observation.id, "rejected")}
                                              className="text-2xs text-accent disabled:text-ink3"
                                            >{t("track.reject")}</button>
                                          </>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                          {(track.anomalies?.length ?? 0) > 0 && (
                            <div className="mt-4">
                              <div className="label mb-2">{t("track.anomalyDetails")}</div>
                              <div className="grid sm:grid-cols-2 gap-2">
                                {track.anomalies?.map((anomaly) => {
                                  const unit = anomalyUnit(anomaly.kind);
                                  return (
                                    <div key={anomaly.id} className="rounded border border-accent/30 bg-accent-soft px-3 py-2">
                                      <div className="flex items-center justify-between gap-2">
                                        <span className="text-xs text-ink font-medium">{anomalyText(anomaly.kind)}</span>
                                        <Pill tone="accent">{anomaly.severity}</Pill>
                                      </div>
                                      <div className="text-2xs text-ink3 mt-1 tnum">
                                        {formatDate(anomaly.observedAt, lang, { day: "numeric", month: "short", year: "numeric" })}
                                      </div>
                                      <div className="text-2xs text-ink2 mt-1 tnum">
                                        {t("track.valueThreshold", {
                                          value: `${fmt.format(anomaly.value)} ${unit}`,
                                          threshold: `${fmt.format(anomaly.threshold)} ${unit}`,
                                        })}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function RegionalAvoidance() {
  const { t, lang } = useT();
  const footages = useFootageStore((s) => s.footages);
  const result = useMemo(() => detectRegionAvoidance(footages), [footages]);
  const fmt = useMemo(() => new Intl.NumberFormat(
    lang === "kk" ? "kk-KZ" : lang === "ru" ? "ru-RU" : "en",
    { maximumFractionDigits: 1 },
  ), [lang]);
  const statusText = (status: "normal" | "alert" | "insufficient_data") =>
    status === "alert" ? t("avoid.alert")
      : status === "normal" ? t("avoid.normal") : t("avoid.insufficient");

  return (
    <Panel
      title={t("avoid.title")}
      eyebrow={t("avoid.eyebrow")}
      action={result.alerts.length > 0
        ? <Pill tone="accent">{t("avoid.alert")}: {result.alerts.length}</Pill>
        : <Pill>{t("avoid.insufficient")}</Pill>}
    >
      <div className="px-4 py-3 border-b border-line-soft">
        <p className="text-xs text-ink2 leading-relaxed max-w-[980px]">{t("avoid.explain")}</p>
        {result.excludedWithoutEffort > 0 && (
          <p className="text-2xs text-ink3 mt-2">{t("avoid.excluded", { n: result.excludedWithoutEffort })}</p>
        )}
      </div>
      {result.assessments.length === 0 ? (
        <p className="px-4 py-6 text-sm text-ink3">{t("avoid.noRegions")}</p>
      ) : (
        <div className="divide-y divide-line-soft">
          {result.assessments.map((assessment) => (
            <div key={assessment.region} className="px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-2">
              <div className="min-w-[160px] flex-1">
                <div className="text-xs text-ink font-medium">{assessment.region}</div>
                <div className="text-2xs text-ink3 mt-1">{t("avoid.baseline", { n: assessment.baselineYears })}</div>
              </div>
              {assessment.latest && (
                <div className="text-xs text-ink3 tnum">
                  {fmt.format(assessment.latest.densityPerKm2)} / km²
                </div>
              )}
              {assessment.modifiedZ != null && (
                <div className="text-xs text-ink3 tnum">
                  z* {Number.isFinite(assessment.modifiedZ) ? fmt.format(assessment.modifiedZ) : "−∞"}
                </div>
              )}
              <Pill tone={assessment.status === "alert" ? "accent" : assessment.status === "normal" ? "good" : "neutral"}>
                {statusText(assessment.status)}
              </Pill>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** Live movement analytics retained from the former dashboard. The rest of
 *  that prototype was absorbed into ReportMode; these two sections continue
 *  to calculate from the current archive and therefore stay interactive. */
export function MovementAnalytics({ onFocusMap }: { onFocusMap?: () => void }) {
  return (
    <div className="space-y-4">
      <TrackedGroups onFocusMap={onFocusMap} />
      <RegionalAvoidance />
    </div>
  );
}

export default function Dashboard({ onClose }: { onClose?: () => void }) {
  const [season, setSeason] = useState("Winter 2026");

  return (
    <main className="flex-1 min-w-0 min-h-0 bg-bg flex flex-col overflow-hidden">
      <header className="shrink-0 min-h-[58px] px-5 py-3 border-b border-line bg-surface flex items-center justify-between gap-4">
        <div className="min-w-0 flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-accent-soft text-accent grid place-items-center shrink-0">
            <Icon name="chart" size={16} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-lead text-ink font-medium truncate">Survey analytics</h1>
              <Pill tone="accent">Target-state prototype</Pill>
            </div>
            <p className="text-2xs text-ink3 mt-0.5 truncate">North Caspian · illustrative data only · designed around defensible seal monitoring</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <label className="relative">
            <span className="sr-only">Survey season</span>
            <select value={season} onChange={(event) => setSeason(event.target.value)} className="h-7 appearance-none bg-surface2 border border-line rounded pl-2.5 pr-7 text-xs text-ink2 focus:outline-none">
              <option>Winter 2026</option>
              <option>Winter 2025</option>
              <option>Winter 2024</option>
            </select>
            <Icon name="chevronRight" size={11} className="absolute right-2 top-2 rotate-90 text-ink3 pointer-events-none" />
          </label>
          <Button icon="download" disabled title="Report design comes after metric definitions are approved">Report</Button>
          {onClose && <IconButton name="close" onClick={onClose} title="Back to map" />}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1440px] mx-auto p-4 lg:p-5 space-y-4">
          <div className="rounded-lg border border-accent/30 bg-accent-soft px-4 py-3 flex flex-col md:flex-row md:items-center gap-2 md:gap-5">
            <div className="flex items-center gap-2 text-xs text-ink font-medium shrink-0">
              <Icon name="alert" size={14} className="text-accent" />
              This is the proposed analytics model, not a scientific result.
            </div>
            <p className="text-xs text-ink2 leading-relaxed flex-1">
              Mock values show the intended hierarchy. The tracked-groups section is live and recalculates from the current archive; the remaining target-state metrics stay illustrative.
            </p>
            <div className="flex items-center gap-3 shrink-0">
              <DataState state="available" compact />
              <DataState state="capture" compact />
              <DataState state="model" compact />
            </div>
          </div>

          <section className="rounded-lg border border-line bg-surface overflow-hidden">
            <div className="grid sm:grid-cols-2 xl:grid-cols-5">
              <Metric label="Latest observed count" value="1,175" note="Animals visible during the latest comparable haul-out survey; raw, not population size." state="available" />
              <Metric label="Pups observed" value="432" note="Pup production indicator for the latest survey; illustrative until life stage is captured." state="capture" />
              <Metric label="Target-unit coverage" value="82%" note="Unique portion of the planned survey units reached under protocol." state="capture" />
              <Metric label="Comparable repeat sites" value="2 / 4" note="Repeated with matching timing, coverage and conditions." state="capture" />
              <Metric label="Adjusted abundance" value="—" note="Blocked until detection and availability corrections support a CI and CV." state="model" />
            </div>
          </section>

          <div className="grid xl:grid-cols-[minmax(0,1.8fr)_minmax(300px,0.8fr)] gap-4">
            <Panel title="Observed trend" eyebrow="Population & distribution" action={<Pill>Raw count</Pill>}>
              <SurveyTrend />
            </Panel>
            <Panel title="Why there is no population number" eyebrow="Uncertainty">
              <MissingEstimate />
            </Panel>
          </div>

          <Panel title="Haul-out survey units" eyebrow="Distribution" action={<span className="text-2xs text-ink3">Fixed units · latest comparable visit</span>}>
            <SiteTable />
          </Panel>

          <TrackedGroups onFocusMap={onClose} />

          <RegionalAvoidance />

          <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
            <Panel title="Life-stage composition" eyebrow="Population structure">
              <Composition />
            </Panel>
            <Panel title="Coverage by survey unit" eyebrow="Survey effort">
              <Coverage />
            </Panel>
            <Panel title="Ecological indicators" eyebrow="Derived · only when comparable">
              <EcologicalIndicators />
            </Panel>
            <Panel title="Condition snapshot" eyebrow="Comparability">
              <div className="p-4">
                <div className="grid grid-cols-2 gap-x-5 gap-y-4">
                  {[
                    ["Survey window", "08:15–10:40"],
                    ["Transect distance", "142 km"],
                    ["Wind", "4.2 m/s"],
                    ["Visibility", "12 km"],
                    ["Air temperature", "−8 °C"],
                    ["Sea ice", "74%"],
                    ["Precipitation", "None"],
                    ["Disturbance", "1 event"],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <div className="text-2xs text-ink3">{label}</div>
                      <div className="text-xs text-ink mt-1 tnum">{value}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-4 pt-3 border-t border-line-soft flex items-center justify-between gap-3">
                  <span className="text-xs text-ink2">Protocol window</span>
                  <Pill tone="good">Met</Pill>
                </div>
                <p className="text-2xs text-ink3 mt-2 leading-relaxed">Illustrative conditions; these fields are not consistently available in today&apos;s archive.</p>
              </div>
            </Panel>
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            <Panel title="Required metadata completeness" eyebrow="Survey comparability" action={<span className="text-2xs text-ink3 tnum">Current archive · mock audit</span>}>
              <MetadataCompleteness />
            </Panel>
            <Panel title="Detection and evidence quality" eyebrow="QA · secondary to ecology">
              <QualityGrid />
            </Panel>
          </div>

          <div className="grid lg:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)] gap-4">
            <Panel title="What SEALv must collect or validate next" eyebrow="Data gap register">
              <DataGaps />
            </Panel>
            <Panel title="Metric definitions" eyebrow="Rules this dashboard follows">
              <div className="p-4 space-y-3">
                {[
                  ["Observed count", "Animals visible and counted during one survey. Never labelled population."],
                  ["Comparable change", "Only between matching survey units, coverage, season window and conditions."],
                  ["Coverage", "Unique surveyed geometry ÷ target survey-unit geometry. Overlap counted once."],
                  ["Adjusted abundance", "Published only with documented corrections, 95% CI and CV."],
                  ["Density", "Shown only when the ecological numerator and unique-area denominator match."],
                ].map(([term, definition]) => (
                  <div key={term} className="pb-3 border-b border-line-soft last:border-0 last:pb-0">
                    <div className="text-xs text-ink">{term}</div>
                    <div className="text-2xs text-ink3 mt-0.5 leading-relaxed">{definition}</div>
                  </div>
                ))}
              </div>
            </Panel>
          </div>

          <p className="text-2xs text-ink3 text-center pb-2">
            Prototype scope: survey analytics and scientific readiness. Processing logs, determinism details and job failures should move to a dedicated QA view.
          </p>
        </div>
      </div>
    </main>
  );
}
