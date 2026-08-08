"use client";
/**
 * TrustPanel — how far the numbers on this panel can be trusted, in the only
 * terms that are measurable.
 *
 * Everything here is either a count of rows or a sentence the service itself
 * recorded. Nothing is scored, weighted, or turned into a confidence figure,
 * because none of those were measured.
 *
 * The one place this deliberately departs from the brief it was built to:
 * "engine repeatability from the fixture's three runs of one photo". Those
 * three runs are the same bytes, at the same scale, through a deterministic
 * pipeline — their spread is exactly 0, and "the engine repeats within 0%"
 * would be the first number in this product that nobody measured. What WAS
 * measured is stated instead, in two parts and labelled for what each one is:
 *
 *   determinism   — same file, same settings, N runs, identical result.
 *                   A property of the pipeline, not of the animals.
 *   cross-frame   — (high − low) on a video band: how far the frames of one
 *     spread       sortie disagreed with each other. This is the real
 *                   variability, and the band has been carrying it all along.
 *
 * Note the fixture also holds two runs of ONE video at DIFFERENT scales
 * (575 against 562). Same file, different settings — that is not a repeat of
 * the same measurement, and it is reported as its own line rather than folded
 * into either figure.
 *
 * Both halves of the determinism claim are weaker than they sound and both say
 * so on the panel: "same file" is a filename match (the archive row carries no
 * content hash) and "same settings" covers only the basis and the scale, which
 * are the two the archive keeps.
 */
import { useEffect, useMemo, useState } from "react";
import { isAssumedGsd } from "@/lib/analytics/area";
import { reviewStats, seasonReviewStats } from "@/lib/analytics/review";
import { fetchJobs, type JobRow } from "@/lib/api";
import { SectionHead } from "@/components/ui/primitives";
import { useT } from "@/lib/i18n";
import { ARCHIVED_FILENAME } from "@/store/useFootageStore";
import type { Footage } from "@/lib/types";

/** The engine's own note on how its false-positive risk was measured. */
function fpBasisOf(f: Footage): string[] {
  return (f.falsePositiveBasis ?? [])
    .filter((s) => typeof s === "string" && s.trim() !== "")
    .map((s) => s.trim());
}

/** The settings a count was produced under, as far as the client can see them:
 *  the basis the engine reported and the scale it worked at. Two runs of one
 *  file at different scales tile differently and are not a repeat. */
function paramKeyOf(f: Footage): string {
  const gsd = typeof f.gsdCmPx === "number" && Number.isFinite(f.gsdCmPx) ? f.gsdCmPx.toFixed(4) : "—";
  return `${f.band?.basis ?? ""}|${gsd}|${f.gsdSource ?? ""}`;
}

type Repeat =
  | { kind: "identical"; file: string; n: number; value: number }
  | { kind: "differ"; file: string; n: number; lo: number; hi: number }
  | { kind: "params"; file: string; n: number; k: number };

/** Number of items to print before the list says how much it is not showing. */
const LIST_CAP = 8;

export default function TrustPanel({
  footages,
  retired,
  withoutResult,
}: {
  /** In-window sorties that produced a count and have not been withdrawn. */
  footages: Footage[];
  /** In-window sorties withdrawn from the archive. */
  retired: Footage[];
  /** In-window sorties that produced no count at all. */
  withoutResult: number;
}) {
  const { t, tp } = useT();

  const season = useMemo(() => seasonReviewStats(footages), [footages]);

  /* Where each sortie's scale came from. explicit/optics were given or derived
     from real optics; anything prefixed assumed_ had a term guessed; the rest
     have no scale at all, which is why they have no area either. */
  const scale = useMemo(() => {
    let measured = 0;
    let assumed = 0;
    let unknown = 0;
    for (const f of footages) {
      const s = f.gsdSource;
      if (s === "explicit" || s === "optics") measured++;
      else if (isAssumedGsd(s)) assumed++;
      else unknown++;
    }
    return { measured, assumed, unknown };
  }, [footages]);

  const caveated = useMemo(
    () =>
      footages
        .map((f) => ({
          f,
          list: (f.caveats ?? []).filter((c) => typeof c === "string" && c.trim() !== ""),
        }))
        .filter((x) => x.list.length > 0),
    [footages],
  );

  /* Every run in the fixture records the same false-positive sentence, so the
     honest compact form is the sentence once with the number of sorties that
     recorded it — not the same paragraph printed six times. */
  const fpGroups = useMemo(() => {
    const by = new Map<string, number>();
    for (const f of footages) for (const s of fpBasisOf(f)) by.set(s, (by.get(s) ?? 0) + 1);
    return [...by.entries()].map(([text, n]) => ({ text, n })).sort((a, b) => b.n - a.n);
  }, [footages]);

  /* Determinism, and the honest non-answer where the parameters moved.

     "The same file" is the same FILENAME: the archive row carries no content
     hash, so this is a weaker test than it sounds and the panel says so
     underneath rather than letting a name match read as a byte match. */
  const repeats = useMemo(() => {
    const byFile = new Map<string, { name: string; items: Footage[] }>();
    for (const f of footages) {
      /* Only a run that actually went through the engine, under a name that
         identifies one file.

         A ground count hydrates with an empty filename and a `manual` basis,
         so every shore count in the season collapsed into one group and two
         independent counts at different beaches printed as "— 2 runs at the
         same settings gave different results: 41 to 55": a determinism claim
         about a pipeline that never ran, with an empty file name, in the one
         panel whose whole job is to be checkable. A run whose media row is
         gone is the same failure with a different label — every one of them
         carries the identical "(archived survey)" placeholder. A name that
         identifies nothing cannot support an identity claim, and a ground
         count has no repeatability to measure; both say nothing instead. */
      if (f.engine === "manual" || f.band?.basis === "manual") continue;
      if (f.filename === "" || f.filename === ARCHIVED_FILENAME) continue;
      let e = byFile.get(f.filename);
      if (!e) { e = { name: f.filename, items: [] }; byFile.set(f.filename, e); }
      e.items.push(f);
    }
    const out: Repeat[] = [];
    for (const entry of byFile.values()) {
      if (entry.items.length < 2) continue;
      const byParams = new Map<string, Footage[]>();
      for (const f of entry.items) {
        const k = paramKeyOf(f);
        byParams.set(k, [...(byParams.get(k) ?? []), f]);
      }
      for (const group of byParams.values()) {
        if (group.length < 2) continue;
        const values = group
          .map((f) => f.band?.best)
          .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
        if (values.length < 2) continue;
        const lo = Math.min(...values);
        const hi = Math.max(...values);
        if (lo === hi) out.push({ kind: "identical", file: entry.name, n: group.length, value: lo });
        else out.push({ kind: "differ", file: entry.name, n: group.length, lo, hi });
      }
      /* Always, not only when nothing else was said about this file. The
         fixture holds one video counted three times — twice at one scale
         (562 both times) and once at another (575) — and a bare "2 runs,
         identical" next to it would let a reader believe the file had been
         counted twice in all. The total and the number of distinct settings
         are what make the scope of the claim above checkable. */
      if (byParams.size > 1)
        out.push({ kind: "params", file: entry.name, n: entry.items.length, k: byParams.size });
    }
    return out;
  }, [footages]);

  /* The variability the band already carries: how far the frames of one sortie
     disagreed. Sorties without a range are counted rather than dropped, and
     reported as exactly that — "produced a single number" — without asserting
     WHY, since a still, a ground count and a video whose frames happened to
     agree all land here and only the first two have a reason worth stating. */
  const spread = useMemo(() => {
    const rows: Array<{ id: string; name: string; width: number; pct: number | null }> = [];
    let noRange = 0;
    for (const f of footages) {
      const b = f.band;
      if (!b || b.low == null || b.high == null || !(b.high > b.low)) { noRange++; continue; }
      const width = b.high - b.low;
      const best = typeof b.best === "number" && b.best > 0 ? b.best : null;
      rows.push({ id: f.id, name: f.filename, width, pct: best === null ? null : (width / best) * 100 });
    }
    rows.sort((a, b) => b.width - a.width);
    return { rows, noRange };
  }, [footages]);

  /* Ingests that never became a survey. They live in the job table, not in the
     store, so nothing on this dashboard would otherwise admit they happened. */
  const [failed, setFailed] = useState<JobRow[] | null>(null);
  const [failedError, setFailedError] = useState(false);
  useEffect(() => {
    let live = true;
    setFailedError(false);
    fetchJobs({ status: "failed" })
      .then((rows) => { if (live) setFailed(rows ?? []); })
      // A service that cannot be reached has not told us there were none.
      .catch(() => { if (live) { setFailed(null); setFailedError(true); } });
    return () => { live = false; };
  }, []);

  const perSortie = footages.slice(0, LIST_CAP);

  return (
    <div className="px-4 py-4 border-b border-line">
      <SectionHead title={t("trust.title")} />
      <p className="text-2xs text-ink3 mt-1 leading-relaxed">{t("trust.intro")}</p>

      {/* Verification — three numbers, because one share hides the third. */}
      <div className="mt-3">
        <div className="text-2xs text-ink3">{t("trust.verification")}</div>
        <div className="flex gap-3 mt-1.5">
          {/* Four, not one. A single share hides two of them: 562 animals of
              this season have no row a reviewer can open, and a rejection is
              work done that a "verified" figure never shows. A share that
              leaves either out reports them as neither done nor outstanding —
              as though the reviewer had not been there. */}
          <Figure value={season.verified} label={t("trust.verified")} />
          <Figure value={season.rejected} label={t("trust.rejected")} />
          <Figure
            value={Math.max(0, season.reviewable - season.ruled)}
            label={t("trust.unreviewed")}
          />
          <Figure value={season.unreviewable} label={t("trust.notReviewable")} />
        </div>
        <p className="text-2xs text-ink3 mt-1.5 leading-relaxed">{t("trust.notReviewableWhy")}</p>
        {/* What the per-sortie fraction counts, said once. Its numerator is
            rulings of either kind, so a sortie whose animals were all rejected
            reads as finished rather than as untouched. */}
        {perSortie.length > 0 && (
          <p className="text-2xs text-ink3 mt-1.5 leading-relaxed">{t("trust.rowsRuled")}</p>
        )}
        {perSortie.length > 0 && (
          <ul className="mt-2 space-y-1">
            {perSortie.map((f) => {
              const rs = reviewStats(f);
              return (
                <li key={f.id} className="flex items-baseline justify-between gap-2 text-2xs">
                  <span className="text-ink3 truncate" title={f.filename}>{f.filename}</span>
                  <span className="tnum text-ink2 shrink-0">
                    {rs.reviewable > 0
                      ? t("trust.rowReviewed", { v: rs.ruled, r: rs.reviewable })
                      : t("trust.rowNothing")}
                    {rs.unreviewable > 0 && (
                      <span className="text-ink3"> · {t("trust.rowNotReviewable", { n: rs.unreviewable })}</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {footages.length > perSortie.length && (
          <p className="text-2xs text-ink3 mt-1">
            {t("est.showingOf", { n: perSortie.length, m: footages.length })}
          </p>
        )}
      </div>

      {/* Scale provenance — an assumed GSD is a guess under every area. */}
      <div className="mt-4">
        <div className="text-2xs text-ink3">{t("trust.scale")}</div>
        <div className="flex gap-3 mt-1.5">
          <Figure value={scale.measured} label={t("trust.scaleMeasured")} />
          <Figure value={scale.assumed} label={t("trust.scaleAssumed")} />
          <Figure value={scale.unknown} label={t("trust.scaleUnknown")} />
        </div>
        <p className="text-2xs text-ink3 mt-1.5 leading-relaxed">{t("trust.scaleNote")}</p>
      </div>

      {/* The engine's own reservations, verbatim. Paraphrasing a caveat is
          editing evidence. */}
      <div className="mt-4">
        <div className="text-2xs text-ink3">{t("trust.caveats")}</div>
        {caveated.length === 0 ? (
          <p className="text-2xs text-ink3 mt-1.5 leading-relaxed">{t("trust.noCaveats")}</p>
        ) : (
          <ul className="mt-1.5 space-y-1.5">
            {caveated.slice(0, LIST_CAP).map(({ f, list }) => (
              <li key={f.id} className="text-2xs leading-relaxed">
                <span className="text-ink2">{f.filename}</span>
                {list.map((c, i) => (
                  <span key={i} className="block text-ink3">{c}</span>
                ))}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2">
          <div className="text-2xs text-ink3">{t("trust.fpBasis")}</div>
          {fpGroups.length === 0 ? (
            <p className="text-2xs text-ink3 mt-1 leading-relaxed">{t("trust.noFpBasis")}</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {fpGroups.map((g) => (
                <li key={g.text} className="text-2xs leading-relaxed">
                  <span className="text-ink3">
                    {g.n} {tp(g.n, "unit.sorties")} —{" "}
                  </span>
                  <span className="text-ink2">“{g.text}”</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Repeatability, stated as the two things that were measured. */}
      <div className="mt-4">
        <div className="text-2xs text-ink3">{t("trust.repeatability")}</div>
        <p className="text-2xs text-ink3 mt-1 leading-relaxed">{t("trust.repeatNote")}</p>

        <div className="mt-2 text-2xs leading-relaxed">
          <span className="text-ink3">{t("trust.determinism")}</span>
          {repeats.length === 0 ? (
            <p className="text-ink3 mt-1">{t("trust.determNone")}</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {repeats.map((r, i) => (
                <li key={`${r.kind}-${r.file}-${i}`} className="text-ink2">
                  {r.kind === "identical" && t("trust.determIdentical", { n: r.n, file: r.file, v: r.value })}
                  {r.kind === "differ" && t("trust.determDiffer", { n: r.n, file: r.file, lo: r.lo, hi: r.hi })}
                  {r.kind === "params" && t("trust.determParams", { n: r.n, k: r.k, file: r.file })}
                </li>
              ))}
            </ul>
          )}
          {/* Both limits of the claim above, stated where the claim is made:
              "same file" is only a filename match, and "same settings" is only
              the two settings the archive keeps. */}
          {repeats.length > 0 && (
            <>
              <p className="text-ink3 mt-1">{t("trust.identityName")}</p>
              <p className="text-ink3 mt-0.5">{t("trust.determSettings")}</p>
            </>
          )}
        </div>

        <div className="mt-2.5 text-2xs leading-relaxed">
          <span className="text-ink3">{t("trust.spread")}</span>
          <p className="text-ink3 mt-1">{t("trust.spreadNote")}</p>
          {spread.rows.length === 0 ? (
            <p className="text-ink3 mt-1">{t("trust.spreadNone")}</p>
          ) : (
            <ul className="mt-1 space-y-0.5">
              {spread.rows.slice(0, LIST_CAP).map((r) => (
                <li key={r.id} className="flex items-baseline justify-between gap-2">
                  <span className="text-ink3 truncate" title={r.name}>{r.name}</span>
                  <span className="tnum text-ink2 shrink-0">
                    {r.pct === null
                      ? t("trust.spreadWidth", { w: r.width })
                      : t("trust.spreadRow", { w: r.width, pct: Math.round(r.pct) })}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {spread.noRange > 0 && (
            <p className="text-ink3 mt-1">{t("trust.spreadStills", { n: spread.noRange })}</p>
          )}
        </div>
      </div>

      {/* What is missing from every figure above, said out loud. */}
      <div className="mt-4 space-y-1 text-2xs leading-relaxed">
        <div className="text-2xs text-ink3">{t("trust.missing")}</div>
        <p className="text-ink2">
          {failedError
            ? t("trust.failedUnknown")
            : failed === null
              ? t("trust.failedLoading")
              : failed.length === 0
                ? t("trust.failedNone")
                : t("trust.failedN", { n: failed.length })}
        </p>
        {failed !== null && failed.length > 0 && (
          <ul className="space-y-0.5">
            {failed.slice(0, LIST_CAP).map((j) => (
              <li key={j.job_id} className="text-ink3 truncate" title={j.error ?? undefined}>
                {j.filename ?? j.job_id}
                {j.error ? ` — ${j.error}` : ""}
              </li>
            ))}
          </ul>
        )}
        <p className="text-ink2" title={retiredReasons(retired)}>
          {retired.length === 0 ? t("trust.retiredNone") : t("trust.retiredN", { n: retired.length })}
        </p>
        {withoutResult > 0 && <p className="text-ink2">{t("trust.noResult", { n: withoutResult })}</p>}
      </div>
    </div>
  );
}

/** Withdrawal reasons for the hover, in the order the sorties are held. An
 *  entry with no recorded reason says so — a withdrawal without a reason is a
 *  fact about the archive, not something to leave blank. */
function retiredReasons(retired: Footage[]): string | undefined {
  if (retired.length === 0) return undefined;
  return retired
    .map((f) => `${f.filename}: ${f.retiredReason?.trim() || "—"}`)
    .join("\n");
}

/** One count with its word under it. Smaller than Stat — three of these sit in
 *  a 380px column and Stat's figure size would wrap every label. */
function Figure({ value, label }: { value: number; label: string }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="tnum text-lead text-ink leading-none truncate" title={String(value)}>{value}</div>
      <div className="text-2xs text-ink3 mt-1 leading-tight">{label}</div>
    </div>
  );
}
