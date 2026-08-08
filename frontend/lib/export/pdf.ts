/* The survey report — акт учёта, not an ops console printout.
   Every figure on the page traces to something the engine measured: the count
   band with the basis that produced it, the reviewed share, the photographed
   area, the coordinates. There is no forecast, no anomaly, no sector
   codename and no KPI here, because none of those were measured.

   Strings come from the shared dictionary by plain index: this module runs
   outside React (no hooks) and is deliberately free of runtime imports from
   lib/i18n, so it stays loadable in a bare node smoke test. */
import type { Footage } from "../types";
import { formatArea, totalAreaM2 } from "../analytics/area";
import { formatDate, localeForLang } from "../analytics/brush";
import { countOf } from "../analytics/count";
import { seasonEstimate } from "../analytics/estimate";
import { SITE_RADIUS_M } from "../analytics/surveys";
import dict from "../i18n.dict.json";

export type ReportLang = "kk" | "ru" | "en";
type Key = keyof typeof dict.en;

function tr(lang: ReportLang, key: Key, vars?: Record<string, string | number>): string {
  const table = dict[lang] as unknown as Record<string, string>;
  let s = table[key] ?? (dict.en as unknown as Record<string, string>)[key] ?? key;
  if (vars) for (const k of Object.keys(vars)) s = s.split(`{${k}}`).join(String(vars[k]));
  return s;
}

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

/** low–best–high, or the single number when the engine offered no range. */
function countText(lang: ReportLang, f: Footage): string {
  const b = f.band;
  if (b && typeof b.low === "number" && typeof b.high === "number" && typeof b.best === "number")
    return `${fmtInt(lang, b.low)}–${fmtInt(lang, b.best)}–${fmtInt(lang, b.high)}`;
  if (b && typeof b.best === "number") return fmtInt(lang, b.best);
  return fmtInt(lang, countOf(f));
}

/** validated ÷ (validated + auto). False positives are in neither term. */
function verifiedText(lang: ReportLang, f: Footage): string {
  const v = f.detections.filter((d) => d.status === "validated").length;
  const a = f.detections.filter((d) => d.status === "auto").length;
  const total = v + a;
  if (total === 0) return "—";
  return `${Math.round((v / total) * 100)}% (${v}/${total})`;
}


/** The document itself. Split out from the download so the report can be
 *  built — and its Cyrillic/Kazakh text read back — outside a browser. */
export async function buildReportDoc(footages: Footage[], lang: ReportLang) {
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

  doc.setFont(font, "normal");

  // Title
  ink();
  doc.setFontSize(15);
  put(tr(lang, "rep.title"), L, 20);
  doc.setFontSize(8);
  soft();
  put(tr(lang, "rep.generated", { date: clean(new Date().toLocaleString(localeFor(lang))) }), L, 26);
  rule(30);

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

  let y = 41;
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
      for (const line of doc.splitTextToSize(clean(note), W) as string[]) { put(line, L, y); y += 3.2; }
    }
    y += 2;
  }

  // Per-sortie table
  const tableHead = (top: number) => {
    soft();
    doc.setFontSize(6.5);
    put(tr(lang, "sec.sortie"), L, top);
    put(tr(lang, "rep.colDate"), 78, top);
    put(tr(lang, "rep.colCount"), 100, top);
    put(tr(lang, "rep.colVerified"), 134, top);
    put(tr(lang, "rep.colArea"), 166, top);
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
    if (y > 262) { doc.addPage(); y = tableHead(20); }
    const sortieArea = f.areaM2;
    ink();
    doc.setFontSize(8);
    put(fit(f.filename, 62), L, y);
    put(fmtDate(lang, f.uploadedAt), 78, y);
    put(countText(lang, f), 100, y);
    put(verifiedText(lang, f), 134, y);
    // No GSD, no area — a dash, never a 0 that would read as "nothing there".
    put(typeof sortieArea === "number" && Number.isFinite(sortieArea) ? fmtArea(lang, sortieArea) : "—", 166, y);

    // The provenance line: what produced the number, and where it was taken.
    soft();
    doc.setFontSize(6.5);
    const parts = [
      `${tr(lang, "rep.basis")}: ${f.band?.basis ? basisLabel(lang, f.band.basis) : tr(lang, "rep.basisNone")}`,
      `${tr(lang, "rep.coords")}: ${f.center.lat.toFixed(5)}, ${f.center.lng.toFixed(5)}`,
    ];
    if (f.unplaced) parts.push(tr(lang, "insp.withoutCoords", { n: f.unplaced }));
    put(fit(parts.join("  ·  "), W), L + 1, y + 3.4);
    y += 8.5;
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
        const lines: string[] = doc.splitTextToSize(clean(`${f.filename}: ${c}`), W - 4);
        for (const line of lines) { put(line, L + 3, y); y += 3.6; }
        y += 1.2;
      }
    }
  }

  // Method — how every number above was produced
  if (y > 258) { doc.addPage(); y = 20; }
  y += 6;
  rule(y);
  y += 4.5;
  soft();
  doc.setFontSize(6.5);
  for (const line of doc.splitTextToSize(clean(tr(lang, "rep.method")), W) as string[]) {
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

export async function exportReport(footages: Footage[], lang: ReportLang): Promise<void> {
  const doc = await buildReportDoc(footages, lang);
  doc.save(`sealv-report-${new Date().toISOString().slice(0, 10)}.pdf`);
}
