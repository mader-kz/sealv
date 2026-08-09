/* The survey report — акт учёта, not an ops console printout.
   Every figure on the page traces to something the engine measured or a person
   wrote down: the count band with the basis that produced it, the reviewed
   share, the photographed area, the coordinates, the field notes with the name
   of whoever left them. There is no forecast, no anomaly, no sector codename
   and no KPI here, because none of those were measured.

   An акт is a document someone else has to be able to CHECK, so it also states
   what it is a document OF: who compiled it, over which slice of the archive,
   and how much of the archive that slice is. A report built from a brushed,
   possibly truncated store that admits neither reads as the whole season.

   Strings come from the shared dictionary by plain index: this module runs
   outside React (no hooks) and is deliberately free of runtime imports from
   lib/i18n, so it stays loadable in a bare node smoke test. Every import below
   is a pure module for the same reason — no React, no DOM, no store. */
import type { Footage } from "../types";
import { formatArea, totalAreaM2 } from "../analytics/area";
import { formatDate, localeForLang, timeExtent } from "../analytics/brush";
import { countOf } from "../analytics/count";
import { seasonEstimate } from "../analytics/estimate";
import { reviewStats } from "../analytics/review";
import { SITE_RADIUS_M, isPlaced } from "../analytics/surveys";
import dict from "../i18n.dict.json";

export type ReportLang = "kk" | "ru" | "en";
type Key = keyof typeof dict.en;

/** What the caller knows about the document that the sorties cannot say for
 *  themselves. All optional: a field that was not supplied is stated as not
 *  recorded, never guessed. */
export type ReportMeta = {
  /** Whoever is compiling the report at this keyboard. */
  operator?: string | null;
  /** The timeline brush this document was exported through, as ISO instants.
   *  Without it a reader cannot tell a full season from a fortnight of it. */
  window?: { from: string; to: string } | null;
  /** Sorties the client has actually loaded, and how many the archive holds.
   *  `latest_runs_total` exists precisely so a truncated window can admit it. */
  loadedRuns?: number | null;
  totalRuns?: number | null;
};

/** Server-side cap on a note. Re-applied here so a row written before the cap
 *  existed cannot push a hundred pages of prose into the document. */
const NOTE_CAP = 4000;

function tr(lang: ReportLang, key: Key, vars?: Record<string, string | number>): string {
  const table = dict[lang] as unknown as Record<string, string>;
  let s = table[key] ?? (dict.en as unknown as Record<string, string>)[key] ?? key;
  if (vars) for (const k of Object.keys(vars)) s = s.split(`{${k}}`).join(String(vars[k]));
  return s;
}

/** A count a person made on the ground rather than one the engine derived. */
const isManual = (f: Footage): boolean => f.band?.basis === "manual" || f.engine === "manual";

/* Same grammar as basisText() in lib/i18n — kept local to keep this module
   import-free of React. A basis the dictionary does not know degrades to the
   raw engine word rather than to silence. */
function basisLabel(lang: ReportLang, basis: string): string {
  let m: RegExpMatchArray | null;
  if ((m = basis.match(/^union_(\d+)_frames$/))) return tr(lang, "basis.union", { n: m[1] });
  if ((m = basis.match(/^consensus_(\d+)_frames$/))) return tr(lang, "basis.consensus", { n: m[1] });
  if ((m = basis.match(/^single_image_(\d+)_of_(\d+)_tiles$/)))
    return tr(lang, "basis.singleTiles", { n: m[1], total: m[2] });
  if (basis === "single_image") return tr(lang, "basis.single");
  // A ground count has no frames and no tiles — it has a person.
  if (basis === "manual") return tr(lang, "basis.manual");
  return basis.replace(/_/g, " ");
}

/** Shared with the UI (lib/analytics/brush.ts) so the report and the screen it
 *  was exported from render one date the same way. */
const localeFor = localeForLang;

/* Intl groups thousands with U+00A0/U+202F; jsPDF draws whatever glyph the
   font has for them, and a missing one is a visible box. Normalise to a plain
   space — the only place in the app where that matters. */
const clean = (s: string) => s.replace(/[\u00A0\u202F\u2009]/g, " ");

const fmtInt = (lang: ReportLang, n: number) => clean(new Intl.NumberFormat(localeFor(lang)).format(n));

/** The shared formatter, plus this module's NBSP scrub. */
const fmtDate = (lang: ReportLang, iso: string) => clean(formatDate(iso, lang));

/** Hectares. The shared analytics formatter, not a third private copy of the
 *  same arithmetic: 150 ha must not print as "150 ha" in the report and
 *  "150.0 ha" on the panel that produced it. */
const fmtArea = (lang: ReportLang, m2: number) => `${formatArea(m2, lang)} ${tr(lang, "unit.ha")}`;

/** Free text out of the database, made safe for a PDF text run: control
 *  characters (including the newlines that would silently truncate a line)
 *  collapse to spaces, and the length cap is re-applied. It is drawn as text,
 *  never interpreted. */
function plain(s: unknown, cap = NOTE_CAP): string {
  if (typeof s !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const flat = s.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}

/** low–best–high, or the single number when the engine offered no range.
 *  A ground count is a number with a visible mark and NO band: equal bounds
 *  around a human's count would dress a person's word up as a measured
 *  interval. */
function countText(lang: ReportLang, f: Footage): string {
  if (isManual(f)) {
    const n = typeof f.band?.best === "number" ? f.band.best : countOf(f);
    return `${fmtInt(lang, n)} · ${tr(lang, "pill.manual")}`;
  }
  const b = f.band;
  if (b && typeof b.low === "number" && typeof b.high === "number" && typeof b.best === "number")
    return `${fmtInt(lang, b.low)}–${fmtInt(lang, b.best)}–${fmtInt(lang, b.high)}`;
  if (b && typeof b.best === "number") return fmtInt(lang, b.best);
  return fmtInt(lang, countOf(f));
}

/** How much of this sortie a human has ruled on.
 *
 *  The denominator is the rows a reviewer can actually open — not the length
 *  of the detection list. A run whose animals were never georeferenced carries
 *  ONE aggregate marker standing for five hundred and sixty-two of them, and
 *  the old arithmetic printed that as "0% (0/1)": a denominator of one for 562
 *  animals, and an accusation that someone had neglected work this build never
 *  offered them. Nothing to review says so, and the animals are named on the
 *  provenance line underneath.
 *
 *  Three outcomes, because there are three states. A dash where review does
 *  not apply at all — a ground count, an empty frame — because that is the
 *  table's word for "no data here". "Not reviewable" only where animals were
 *  counted and none of them has a row a reviewer could open: that is a claim
 *  about this build, and it should not be made about a sortie that simply
 *  counted nothing. */
function verifiedText(lang: ReportLang, f: Footage): string {
  const rs = reviewStats(f);
  /* A ground count is not unreviewed work; it is a different kind of evidence
     and the column has nothing to say about it. */
  if (rs.groundCount || rs.total === 0) return "—";
  if (rs.reviewable === 0) return tr(lang, "rep.notReviewable");
  /* Rulings over reachable rows. A rejection is a verdict and it is work done:
     scoring only confirmations printed a sortie whose animals were every one of
     them rejected as "0% (0/300)" — an accusation of neglect against the person
     who had just finished reviewing it. The split (how many of those rulings
     were confirmations) is on the provenance line below, where it does not have
     to fit a column. */
  return `${Math.round(rs.pct ?? 0)}% (${rs.ruled}/${rs.reviewable})`;
}

/** The tide as recorded, in the reader's language. An unrecognised token is
 *  printed as the service stored it rather than dropped. */
function tideLabel(lang: ReportLang, v: string): string {
  switch (v) {
    case "low": return tr(lang, "rec.tide.low");
    case "falling": return tr(lang, "rec.tide.falling");
    case "high": return tr(lang, "rec.tide.high");
    case "rising": return tr(lang, "rec.tide.rising");
    case "unknown": return tr(lang, "rec.tide.unknown");
    default: return v;
  }
}

/** How the sortie's coordinate was arrived at. Only stated when the archive
 *  recorded it: a pinned photo and a GPS-tracked transect both arrive here
 *  with one track point, so guessing between them would put an invented
 *  provenance under a coordinate printed to five decimals. */
function locationText(lang: ReportLang, f: Footage): string | null {
  switch (f.locationSource) {
    case "telemetry": return tr(lang, "rep.locMeasured");
    case "pinned": return tr(lang, "rep.locPinned");
    case "manual": return tr(lang, "rep.locManual");
    default: return null;
  }
}

/** Names recorded against these sorties, deduplicated and in first-seen order. */
function operatorsOf(footages: Footage[]): string[] {
  const seen: string[] = [];
  for (const f of footages) {
    const who = plain(f.operator, 80);
    if (who && !seen.includes(who)) seen.push(who);
  }
  return seen;
}

/** The document itself. Split out from the download so the report can be
 *  built — and its Cyrillic/Kazakh text read back — outside a browser.
 *
 *  `meta` is optional so every existing caller and the node smoke test keep
 *  working; what it does not supply is reported as not recorded. */
export async function buildReportDoc(footages: Footage[], lang: ReportLang, meta?: ReportMeta) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  /* jsPDF's built-in helvetica has no Cyrillic: Kazakh and Russian would come
     out as mojibake, which for this audience is worse than English. Noto Sans
     (OFL, lib/export/fonts/) is embedded instead — base64 alongside the .ttf,
     regenerated with:
       node -e 'const fs=require("fs");fs.writeFileSync("lib/export/fonts/notoSans.base64.json",JSON.stringify({ttf:fs.readFileSync("lib/export/fonts/NotoSans-Regular.ttf").toString("base64")})+"\n")'
     jsPDF subsets it, so the report itself stays around 100 KB. */
  type FontModule = { default?: { ttf?: string }; ttf?: string };
  const mod = (await import("./fonts/notoSans.base64.json")) as unknown as FontModule;
  const ttf = mod.default?.ttf ?? mod.ttf ?? "";
  let font = "helvetica";
  if (ttf) {
    doc.addFileToVFS("NotoSans-Regular.ttf", ttf);
    doc.addFont("NotoSans-Regular.ttf", "NotoSans", "normal"); // one weight; hierarchy is size and colour
    font = "NotoSans";
  }

  const L = 14, R = 196, W = R - L;
  const ink = () => doc.setTextColor(17, 24, 39);
  const soft = () => doc.setTextColor(107, 114, 128);
  const rule = (y: number) => { doc.setDrawColor(209, 213, 219); doc.setLineWidth(0.2); doc.line(L, y, R, y); };
  const put = (s: string, x: number, y: number, opts?: { align?: "left" | "right" }) => doc.text(clean(s), x, y, opts);
  /** Trim to a column width, with an ellipsis so nothing silently disappears. */
  const fit = (s: string, w: number) => {
    if (doc.getTextWidth(s) <= w) return s;
    let out = s;
    while (out.length > 1 && doc.getTextWidth(`${out}…`) > w) out = out.slice(0, -1);
    return `${out}…`;
  };
  const wrap = (s: string, w: number): string[] => doc.splitTextToSize(clean(s), w) as string[];

  doc.setFont(font, "normal");

  // Title
  ink();
  doc.setFontSize(15);
  put(tr(lang, "rep.title"), L, 20);
  doc.setFontSize(8);
  soft();
  put(tr(lang, "rep.generated", { date: clean(new Date().toLocaleString(localeFor(lang))) }), L, 26);

  /* What this document IS: who compiled it, whose surveys it holds, the dates
     it covers, the window it was exported through, and how much of the archive
     that window is. `latest_runs_total` exists in the API precisely so a
     truncated listing can admit it is truncated; this is the surface where a
     silent truncation would matter most. */
  let y = 30.5;
  doc.setFontSize(6.5);
  const head: string[] = [];
  const compiler = plain(meta?.operator, 80);
  head.push(compiler ? tr(lang, "rep.compiledBy", { who: compiler }) : tr(lang, "rep.compiledByNobody"));

  const recorded = operatorsOf(footages);
  if (recorded.length > 0) {
    const shown = recorded.slice(0, 3).join(", ");
    head.push(
      tr(lang, "rep.recordedBy", {
        who: recorded.length > 3 ? `${shown} +${recorded.length - 3}` : shown,
      }),
    );
  }

  const ext = timeExtent(footages);
  if (ext) {
    const from = fmtDate(lang, new Date(ext.min).toISOString());
    const to = fmtDate(lang, new Date(ext.max).toISOString());
    head.push(from === to ? tr(lang, "rep.periodOne", { date: from }) : tr(lang, "rep.period", { from, to }));
  }
  if (meta?.window) {
    head.push(
      tr(lang, "rep.window", {
        from: fmtDate(lang, meta.window.from),
        to: fmtDate(lang, meta.window.to),
      }),
    );
  }
  const total = typeof meta?.totalRuns === "number" ? meta.totalRuns : null;
  head.push(
    total === null
      ? tr(lang, "rep.scopeUnknown", { n: fmtInt(lang, footages.length) })
      : tr(lang, "rep.scope", { n: fmtInt(lang, footages.length), m: fmtInt(lang, total) }),
  );
  /* Two different subsets, and conflating them is how a partial archive gets
     published as a season: the report holds the sorties inside the brush, and
     the client held only as many as the hydrate had landed. Stated separately
     whenever the second one is short of the archive. */
  const loaded = typeof meta?.loadedRuns === "number" ? meta.loadedRuns : null;
  if (total !== null && loaded !== null && loaded < total)
    head.push(tr(lang, "rep.scopeTruncated", { loaded: fmtInt(lang, loaded), total: fmtInt(lang, total) }));

  for (const line of head) {
    for (const l of wrap(line, W)) { put(l, L, y); y += 3.2; }
  }
  y += 0.6;
  rule(y);
  y += 5;

  /* Totals — only figures that were measured. The headline is the standing
     estimate (the latest sortie at each site), not the sum over sorties: an
     акт учёта that adds up repeat visits reports more seals than exist. The
     sum is still in the document, under the table of figures, named for what
     it is. Same helper as every screen, so the printed report and the panel it
     was exported from cannot disagree. */
  const est = seasonEstimate(footages);
  const area = totalAreaM2(footages);
  const cells: Array<[string, string]> = [
    [fmtInt(lang, est.current), tr(lang, "rep.currentEstimate")],
    [fmtInt(lang, footages.length), tr(lang, "stat.sorties")],
  ];
  // Omitted entirely when no sortie knows its ground resolution: an area of 0
  // would read as "we surveyed nothing".
  if (area.known > 0) cells.push([fmtArea(lang, area.m2), tr(lang, "rep.totalArea")]);

  y += 6;
  cells.forEach(([value, label], i) => {
    const x = L + i * (W / 3);
    ink();
    doc.setFontSize(16);
    put(value, x, y);
    soft();
    doc.setFontSize(7);
    put(fit(label, W / 3 - 4), x, y + 5);
  });
  y += 10;

  /* What the figures above rest on, and the one they were promoted over. The
     estimate states its own rule (latest sortie per site) so a reader can
     check it; the raw sum follows, labelled as observations — the same
     haul-out flown twice contributes twice, and that line is what stops it
     being read as distinct animals. The area sum carries the same
     qualification plus what it rests on — a hectare figure summed over the
     sorties that HAVE a scale, some of it derived from a sensor width the
     service only guessed. */
  const notes: string[] = [];
  if (footages.length > 0) {
    notes.push(tr(lang, "est.basis", { km: SITE_RADIUS_M / 1000 }));
    notes.push(
      `${tr(lang, "est.observedSub", { n: fmtInt(lang, est.observed), m: fmtInt(lang, est.sorties) })} — ${tr(lang, "rep.totalNote")}`,
    );
  }
  if (area.known > 0) {
    notes.push([
      tr(lang, "rep.areaNote"),
      area.unknown ? tr(lang, "dash.noGsd", { n: area.unknown }) : "",
      area.assumed ? tr(lang, "dash.assumedGsd", { n: area.assumed }) : "",
    ].filter(Boolean).join(" · "));
  }
  if (notes.length > 0) {
    soft();
    doc.setFontSize(6.5);
    // Wrapped, not trimmed: an ellipsis here would eat the qualification.
    for (const note of notes) {
      for (const line of wrap(note, W)) { put(line, L, y); y += 3.2; }
    }
    y += 2;
  }

  /* Per-sortie table. The run id earns its column: three rows of the fixture
     are the same filename, uploaded three times, and without it the reader
     cannot tell which archive row a line refers to — nor look it up. A sortie
     with no run behind it (local or test data) leaves the cell empty, because
     there is no id to show, not because one is missing. */
  const X = { file: L, run: 66, date: 84, count: 106, verified: 138, area: 170 };
  const tableHead = (top: number) => {
    soft();
    doc.setFontSize(6.5);
    put(tr(lang, "sec.sortie"), X.file, top);
    put(tr(lang, "rep.colRun"), X.run, top);
    put(tr(lang, "rep.colDate"), X.date, top);
    put(tr(lang, "rep.colCount"), X.count, top);
    put(tr(lang, "rep.colVerified"), X.verified, top);
    put(tr(lang, "rep.colArea"), X.area, top);
    rule(top + 1.6);
    return top + 6;
  };

  ink();
  doc.setFontSize(9);
  put(tr(lang, "rep.perSortie"), L, y + 2);
  y = tableHead(y + 8);

  if (footages.length === 0) {
    soft();
    doc.setFontSize(8);
    put(tr(lang, "rep.noData"), L, y);
    y += 6;
  }

  for (const f of footages) {
    const rs = reviewStats(f);

    /* The provenance line: what produced the number, where it was taken, what
       the conditions were, and every qualification the row carries. Wrapped,
       not ellipsised — an акт that trims its own caveats to fit a column is
       the failure this document exists to avoid. */
    const parts: string[] = [
      `${tr(lang, "rep.basis")}: ${f.band?.basis ? basisLabel(lang, f.band.basis) : tr(lang, "rep.basisNone")}`,
    ];
    /* Only a sortie that HAS a position gets a coordinate line. A run that
       flew no track and georeferenced no animal carries a NaN centre by
       design; printing "NaN, NaN" to five decimal places in a published
       report is the worst place in this product for an invented number, so
       the line is omitted and the sortie is named as unplaced instead. */
    if (isPlaced(f)) {
      parts.push(`${tr(lang, "rep.coords")}: ${f.center.lat.toFixed(5)}, ${f.center.lng.toFixed(5)}`);
    } else {
      parts.push(`${tr(lang, "rep.coords")}: ${tr(lang, "misc.notPlaced")}`);
    }
    const loc = locationText(lang, f);
    if (loc) parts.push(loc);

    const site = plain(f.siteName, 120);
    if (site) parts.push(tr(lang, "rep.site", { name: site }));

    /* A quick count says which clip and which second, and says out loud what
       it traded away. `single_image` in the basis column is true but
       incomplete: it does not distinguish a photograph from one frame of a
       video that COULD have carried a cross-frame band and deliberately does
       not. A reader weighing this number needs the difference. */
    const clip = plain(f.quickCount?.fromVideo, 120);
    if (clip && typeof f.quickCount?.atSeconds === "number")
      parts.push(tr(lang, "rep.quickFrame", { name: clip, s: f.quickCount.atSeconds }));

    /* Survey conditions, when the survey recorded them. A haul-out count
       swings enormously with tide, so a count printed without the conditions
       it was made under is a number a reader cannot weigh. (Sea ice is in the
       service's survey table but is not carried on the archive row, so there
       is nothing here to print — an absent field, not a zero.) */
    const tide = plain(f.tideState, 40);
    if (tide) parts.push(tr(lang, "rep.tide", { v: tideLabel(lang, tide) }));
    if (typeof f.altitudeM === "number" && Number.isFinite(f.altitudeM))
      parts.push(tr(lang, "rep.altitude", { v: fmtInt(lang, Math.round(f.altitudeM)) }));

    /* The date in the Date column is whatever clock the row has. When the
       flight date was never recorded, that clock is the count job's, and a
       processing timestamp printed under a "Date" heading in an акт reads as
       the day the animals were seen. Said out loud instead. */
    if (!plain(f.capturedAt, 40))
      parts.push(tr(lang, "rep.dateNotRecorded", { date: fmtDate(lang, f.uploadedAt) }));

    if (f.unplaced) parts.push(tr(lang, "insp.withoutCoords", { n: f.unplaced }));
    /* What the review column's fraction is made of. A reader has to be able to
       tell "everything confirmed" from "everything rejected": both are 100%
       reviewed and they are opposite results. */
    if (rs.ruled > 0) parts.push(tr(lang, "rep.ruledSplit", { v: rs.verified, x: rs.rejected }));
    if (rs.reviewable === 0 && rs.unreviewable > 0)
      parts.push(tr(lang, "rep.notReviewableN", { n: rs.unreviewable }));

    doc.setFontSize(6.5);
    const provLines = wrap(parts.join("  ·  "), W - 2);

    /* The human half of the record. A machine sentence and a person's
       observation never share a block: this one is labelled, attributed, and
       drawn as text — the note is data, and it is never interpreted. */
    const noteText = plain(f.notes);
    const noteLines = noteText ? wrap(`${tr(lang, "rep.notes")}: ${noteText}`, W - 6) : [];
    const noteWho = plain(f.operator, 80);
    const attribution = noteText
      ? noteWho
        ? tr(lang, "rep.notesBy", { who: noteWho })
        : tr(lang, "rep.notesByNobody")
      : "";

    const need =
      5 + provLines.length * 3.4 + (noteLines.length ? noteLines.length * 3.2 + 3.6 : 0) + 2;
    if (y + need > 274) { doc.addPage(); y = tableHead(20); }

    ink();
    doc.setFontSize(8);
    put(fit(f.filename, X.run - X.file - 2), X.file, y);
    if (f.runId) { soft(); put(fit(f.runId, X.date - X.run - 2), X.run, y); ink(); }
    put(fmtDate(lang, f.uploadedAt), X.date, y);
    put(fit(countText(lang, f), X.verified - X.count - 2), X.count, y);
    put(verifiedText(lang, f), X.verified, y);
    // No GSD, no area — a dash, never a 0 that would read as "nothing there".
    const sortieArea = f.areaM2;
    put(typeof sortieArea === "number" && Number.isFinite(sortieArea) ? fmtArea(lang, sortieArea) : "—", X.area, y);
    y += 3.4;

    soft();
    doc.setFontSize(6.5);
    for (const line of provLines) { put(line, L + 1, y); y += 3.4; }

    if (noteLines.length > 0) {
      ink();
      for (const line of noteLines) { put(line, L + 3, y); y += 3.2; }
      soft();
      put(attribution, L + 3, y);
      y += 3.6;
    }
    y += 2;
  }

  // Caveats — the engine's own reservations, verbatim, not paraphrased
  const withCaveats = footages
    .map((f) => ({ f, caveats: (f.caveats ?? []).filter((c) => typeof c === "string" && c.trim() !== "") }))
    .filter((x) => x.caveats.length > 0);

  if (withCaveats.length > 0) {
    if (y > 240) { doc.addPage(); y = 20; }
    y += 4;
    ink();
    doc.setFontSize(9);
    put(tr(lang, "rep.caveats"), L, y);
    y += 5;
    doc.setFontSize(7);
    for (const { f, caveats } of withCaveats) {
      for (const c of caveats) {
        if (y > 275) { doc.addPage(); y = 20; }
        soft();
        for (const line of wrap(`${f.filename}: ${c}`, W - 4)) { put(line, L + 3, y); y += 3.6; }
        y += 1.2;
      }
    }
  }

  // Method — how every number above was produced
  if (y > 254) { doc.addPage(); y = 20; }
  y += 6;
  rule(y);
  y += 4.5;
  soft();
  doc.setFontSize(6.5);
  for (const line of wrap(tr(lang, "rep.method"), W)) {
    put(line, L, y);
    y += 3.2;
  }

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont(font, "normal");
    doc.setFontSize(6.5);
    soft();
    put("SEALv", L, 289);
    put(tr(lang, "rep.page", { n: i, total: pages }), R, 289, { align: "right" });
  }

  return doc;
}

export async function exportReport(
  footages: Footage[],
  lang: ReportLang,
  meta?: ReportMeta,
): Promise<void> {
  const doc = await buildReportDoc(footages, lang, meta);
  doc.save(`sealv-report-${new Date().toISOString().slice(0, 10)}.pdf`);
}
