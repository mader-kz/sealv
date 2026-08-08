"use client";
/* Naming a place.
 *
 * The service has had a `site` table since the first schema and nothing could
 * write to it, so every haul-out in the product was a pair of coordinates.
 * "42.53, 51.08" is a true statement and a useless one: the ecologist knows
 * that beach by name, the repeat-survey panel lists it by name, and the report
 * has to print something a reader outside this app can find on a map.
 *
 * Two properties this component is careful about, because both touch the
 * headline number:
 *
 *  - Naming applies to the WHOLE geometric cluster, not to the one sortie in
 *    the inspector. Three visits to one beach are three sorties; naming one of
 *    them and leaving the other two anonymous would put a name on a third of a
 *    place. So the assignment runs over every sortie the 2 km clustering
 *    already treats as this site, with a progress line, sequentially.
 *  - An existing site within 2 km is REUSED rather than duplicated. Two site
 *    rows over one beach would let a later reassignment split the cluster, and
 *    a split cluster counts one colony twice.
 *
 * Unnamed sites keep their coordinates. A place with no name is not a place
 * with no position.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createSite, fetchSites, renameSite } from "@/lib/api";
import { useT } from "@/lib/i18n";
import type { Footage } from "@/lib/types";
import { useFootageStore } from "@/store/useFootageStore";
import { SITE_RADIUS_M, groupIntoSites, isPlaced } from "@/lib/analytics/surveys";
import { Button } from "@/components/ui/primitives";

/** Metres between two coordinates. Equirectangular, cos-corrected — the same
 *  approximation lib/analytics/groups.ts clusters with, and exact enough at
 *  the couple-of-kilometre scale this comparison happens at. */
function metresBetween(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const mPerDeg = 111320;
  const cos = Math.max(Math.cos(((a.lat + b.lat) / 2 * Math.PI) / 180), 0.01);
  return Math.hypot((a.lng - b.lng) * cos * mPerDeg, (a.lat - b.lat) * mPerDeg);
}

export default function SitePicker({ f }: { f: Footage }) {
  const { t } = useT();
  const footages = useFootageStore((s) => s.footages);
  const assignSite = useFootageStore((s) => s.assignSite);
  const applySiteName = useFootageStore((s) => s.applySiteName);
  const progress = useFootageStore((s) => s.siteAssign);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* The sorties this one shares a place with. Retired sorties are left out —
     they are not part of the season, so they are not part of its geography
     either — and so is anything with no position to cluster on. */
  const cluster = useMemo(() => {
    const placed = footages.filter((x) => !x.retiredAt && isPlaced(x));
    const groups = groupIntoSites(placed);
    const mine = groups.find((g) => g.footages.some((x) => x.id === f.id));
    return mine ?? null;
  }, [footages, f.id]);

  const members = cluster?.footages ?? (isPlaced(f) ? [f] : []);
  const centroid = cluster?.centroid ?? (isPlaced(f) ? f.center : null);
  const assignedName = f.siteName ?? cluster?.name ?? null;

  useEffect(() => {
    if (open) setName(assignedName ?? "");
    // Only when the form opens: retyping must not be overwritten by a re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = useCallback(async () => {
    const wanted = name.trim();
    if (!wanted) { setError(t("rec.site.nameRequired")); return; }
    if (!f.surveyId) { setError(t("rec.site.noSurvey")); return; }
    setBusy(true);
    setError(null);
    try {
      /* Already named: one write for the name, plus any sortie at this place
         that is not on the site yet — a flight made after the naming would
         otherwise sit unnamed next to three named neighbours. */
      if (f.siteId) {
        const target = f.siteId;
        await renameSite(target, wanted);
        applySiteName(target, wanted);
        const strays = members.filter((m) => m.siteId !== target).map((m) => m.id);
        if (strays.length) {
          const res = await assignSite(strays, target, wanted);
          if (res.failed > 0) {
            setError(t("rec.site.partial", { n: res.failed, m: strays.length }));
            return;
          }
        }
        setOpen(false);
        return;
      }

      let siteId: string | null = null;
      if (centroid) {
        /* Reuse before create. A site row already sitting on this beach —
           made by an earlier naming, or seeded — is the same place. */
        try {
          for (const row of await fetchSites()) {
            /* A site row with no coordinate cannot be matched against a place.
               Skipped rather than assumed to be this one. */
            if (row.lat == null || row.lng == null) continue;
            if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng)) continue;
            if (metresBetween(centroid, { lat: row.lat, lng: row.lng }) <= SITE_RADIUS_M) {
              siteId = row.id;
              break;
            }
          }
        } catch (e) {
          /* The listing is an optimisation, not a precondition: failing to read
             it means we may create a second row for one beach, which is
             recoverable, while refusing to name anything is not. */
          console.warn("existing sites could not be listed:", e);
        }
      }

      if (siteId) {
        /* Reused, so the operator's name is applied to it rather than silently
           discarded in favour of whatever it was called before. */
        await renameSite(siteId, wanted);
      } else {
        const made = await createSite({
          name: wanted,
          lat: centroid?.lat ?? null,
          lng: centroid?.lng ?? null,
        });
        siteId = made.id;
      }

      const ids = members.map((m) => m.id);
      const res = await assignSite(ids, siteId, wanted);
      applySiteName(siteId, wanted);
      if (res.failed > 0) setError(t("rec.site.partial", { n: res.failed, m: ids.length }));
      else setOpen(false);
    } catch (e) {
      setError(`${t("rec.site.failed")}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [name, f.surveyId, f.siteId, centroid, members, assignSite, applySiteName, t]);

  return (
    <div className="py-1.5 border-b border-line-soft last:border-0">
      <div className="flex items-baseline gap-3">
        <span className="text-xs text-ink3 w-[96px] shrink-0">{t("rec.site.label")}</span>
        <span className="text-sm text-ink truncate flex-1" title={assignedName ?? undefined}>
          {assignedName ?? (
            /* No name is not no place: the measured coordinate stands in, so a
               site is never rendered as blank. */
            <span className="text-ink3">
              {centroid
                ? <span className="font-mono tnum">{centroid.lat.toFixed(3)}, {centroid.lng.toFixed(3)}</span>
                : t("rec.site.unnamed")}
            </span>
          )}
        </span>
        {f.surveyId && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="text-2xs text-ink3 hover:text-ink transition-colors shrink-0"
          >
            {assignedName ? t("rec.site.rename") : t("rec.site.nameIt")}
          </button>
        )}
      </div>

      {open && (
        <div className="mt-2 space-y-1.5">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !busy) void submit(); }}
            maxLength={120}
            placeholder={t("rec.site.nameLabel")}
            aria-label={t("rec.site.nameLabel")}
            className="w-full h-7 bg-surface2 border border-line rounded px-2.5 text-sm placeholder:text-ink3 focus:outline-none focus:border-ink3 transition-colors"
          />
          {/* What is about to happen, before it happens: this writes to every
              sortie at the place, not to the one on screen. */}
          {!f.siteId && members.length > 1 && (
            <p className="text-2xs text-ink3 leading-relaxed">
              {t("rec.site.applies", { n: members.length })}
            </p>
          )}
          {progress && (
            <p className="text-2xs text-ink2 tnum">
              {t("rec.site.assigning", { n: progress.done, m: progress.total })}
            </p>
          )}
          {error && <p className="text-2xs text-bad leading-relaxed">{error}</p>}
          <div className="flex gap-1.5">
            <Button variant="primary" onClick={() => void submit()} disabled={busy}>
              {t("btn.confirm")}
            </Button>
            <Button onClick={() => { setOpen(false); setError(null); }} disabled={busy}>
              {t("btn.cancel")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
