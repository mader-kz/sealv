"use client";
/**
 * SiteCard — one haul-out, opened from its chip on the map.
 *
 * The season used to be readable only as a list of sorties: three visits to one
 * beach were three rows, three chips and three numbers, and the fact that they
 * were ONE PLACE lived in the analytics panel behind a disclosure. That was
 * backwards. A site is the unit an ecologist thinks in — it is what gets named,
 * what gets revisited, what a trend can honestly be claimed about — and the
 * season estimate is literally a sum over sites. So the site gets the card.
 *
 * What is in it, and why each part is here rather than somewhere else:
 *
 *   the name      The header IS the place: its name, or — while nobody has named
 *                 it — its coordinates, which are the only true thing about an
 *                 unnamed beach. Renaming is an ACTION in the row under the
 *                 photograph, not a permanent invitation occupying the title:
 *                 naming a place is how this product stops printing
 *                 "42.53, 51.08" at people who know the beach by
 *                 name. The write goes through the same reuse-before-create path
 *                 the sortie inspector's SitePicker uses, and for the same
 *                 reason: two site rows over one beach would let a later
 *                 reassignment split the cluster, and a split cluster counts one
 *                 colony twice.
 *   the standing  The one number the season estimate takes from this place: its
 *   count         latest visit that produced one, with that visit's band and
 *                 basis, and the date it was flown. Not a sum over visits —
 *                 summing them would count one haul-out once per flight. It is
 *                 printed ONCE, here; every caveat that used to be a sentence
 *                 around it is a muted chip carrying the whole sentence in its
 *                 tooltip. Nothing is deleted, only demoted: a card whose
 *                 qualifications are longer than its figure gets read as prose
 *                 and therefore not read at all.
 *   the dynamics  Every visit, plotted and then written out, from the existing
 *                 SiteDynamics: dots with whiskers, no line between them, gaps
 *                 drawn as gaps. Clicking a visit selects the sortie, which is
 *                 what puts the full sortie inspector on screen. Shown only
 *                 once there are two counts to have dynamics BETWEEN: one dot
 *                 is not a trend, and the section under it only restated the
 *                 hero's count, date, centroid and unnamed-ness.
 *   История       What has been DONE to this place's numbers: counted,
 *                 corrected, retired — assembled from the corrections and
 *                 retirement records the store already hydrates. A corrected
 *                 figure with no visible trace of what it replaced is an
 *                 unsourced number. A single event is always the one count the
 *                 hero already states, so the section starts at two.
 *   the note      Field notes, read-only. They are written against a sortie, in
 *                 that sortie's own card, and this says so rather than offering
 *                 a second editor that would write to a different row than the
 *                 one the reader is looking at.
 *
 * Retired sorties are not part of the season and are not plotted, but they ARE
 * part of this place's record, so they appear in История and can be opened from
 * there. Nothing about a retirement is hidden; it is simply not counted.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import SiteDynamics from "@/components/dashboard/SiteDynamics";
import { EvidenceFrame } from "@/components/evidence/EvidenceView";
import ReplayView from "@/components/replay/ReplayView";
import Icon from "@/components/ui/Icon";
import { Button, IconButton, Pill } from "@/components/ui/primitives";
import { createSite, fetchSites, renameSite } from "@/lib/api";
import { formatDate } from "@/lib/analytics/brush";
import { reviewStats } from "@/lib/analytics/review";
import { SITE_RADIUS_M, siteSeries, type Site } from "@/lib/analytics/surveys";
import { basisText, useT } from "@/lib/i18n";
import type { Footage } from "@/lib/types";
import { useFootageStore } from "@/store/useFootageStore";

/** Metres between two coordinates. Equirectangular, cos-corrected — the same
 *  approximation lib/analytics/groups.ts clusters with, and exact enough at the
 *  couple-of-kilometre scale this comparison happens at. */
function metresBetween(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const mPerDeg = 111320;
  const cos = Math.max(Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180), 0.01);
  return Math.hypot((a.lng - b.lng) * cos * mPerDeg, (a.lat - b.lat) * mPerDeg);
}

/** A caveat, worn small. The chip says the short of it and the tooltip carries
 *  the sentence this card used to print in full next to the figure — the
 *  qualification is not gone, it is simply no longer louder than the number it
 *  qualifies. Neutral tone on purpose: the accent belongs to the standing
 *  estimate alone, and a green warning would claim the opposite of what it
 *  says. */
function Chip({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <span
      title={title}
      className="inline-flex items-center h-5 px-1.5 border border-hair cursor-help"
    >
      <Pill tone="neutral">{children}</Pill>
    </span>
  );
}

/** One line of История. `t` is the instant it happened; a record with no
 *  readable timestamp keeps its place at the end rather than being dated by
 *  guesswork. */
type Event = {
  key: string;
  kind: "counted" | "correction" | "retired";
  t: number;
  when: string | null;
  footageId: string;
  text: string;
  detail: string | null;
  who: string | null;
};

export default function SiteCard({
  site,
  retired,
  onClose,
}: {
  /** The site as the season sees it: its LIVE sorties only, so everything
   *  computed here matches what seasonEstimate() summed. */
  site: Site<Footage>;
  /** Sorties at this place that have been withdrawn from the count. Evidence,
   *  never a figure — they appear in История and nowhere else on this card. */
  retired: Footage[];
  onClose: () => void;
}) {
  const { t, tp, lang } = useT();
  const select = useFootageStore((s) => s.select);
  const assignSite = useFootageStore((s) => s.assignSite);
  const applySiteName = useFootageStore((s) => s.applySiteName);
  const progress = useFootageStore((s) => s.siteAssign);
  const corrections = useFootageStore((s) => s.corrections);
  const retirement = useFootageStore((s) => s.retirement);

  const series = useMemo(() => siteSeries(site), [site]);

  /* The visit the season estimate is actually reading. Not simply the last one:
     seasonEstimate walks back past visits that produced no count, because null
     is unknown and a flight that measured nothing does not empty a haul-out.
     This repeats that walk so the figure printed here is the figure summed
     there — a card that disagreed with the strip above it would be worse than
     no card. */
  const standing = useMemo(() => {
    for (let i = series.length - 1; i >= 0; i--) {
      const e = series[i];
      if (e.best != null && Number.isFinite(e.best)) return e;
    }
    return null;
  }, [series]);

  /* ------------------------------------------------------------- the name */
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(site.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* A different site opened: forget an abandoned rename rather than carrying a
     half-typed name from one beach onto another. */
  useEffect(() => {
    setName(site.name ?? "");
    setEditing(false);
    setError(null);
  }, [site.siteId, site.name, site.centroid.lat, site.centroid.lng]);

  const members = site.footages;

  /* The same write SitePicker performs from the sortie inspector, addressed to
     the whole cluster instead of to one sortie — which is what naming a place
     has always meant here, since naming one of three visits would put a name on
     a third of a haul-out.
     (The two implementations are twins on purpose for now: the inspector names
     a place from a sortie, this names it from the place. If a third caller ever
     appears they should be folded into one lib helper.) */
  const submit = useCallback(async () => {
    const wanted = name.trim();
    if (!wanted) { setError(t("rec.site.nameRequired")); return; }
    const writable = members.filter((m) => m.surveyId);
    if (writable.length === 0) { setError(t("rec.site.noSurvey")); return; }
    setBusy(true);
    setError(null);
    try {
      if (site.siteId) {
        const target = site.siteId;
        await renameSite(target, wanted);
        applySiteName(target, wanted);
        /* A flight made after the naming sits unnamed next to named
           neighbours until it is attached too. */
        const strays = writable.filter((m) => m.siteId !== target).map((m) => m.id);
        if (strays.length) {
          const res = await assignSite(strays, target, wanted);
          if (res.failed > 0) {
            setError(t("rec.site.partial", { n: res.failed, m: strays.length }));
            return;
          }
        }
        setEditing(false);
        return;
      }

      let siteId: string | null = null;
      /* Reuse before create. A site row already sitting on this beach — made by
         an earlier naming, or seeded — is the same place. */
      try {
        for (const row of await fetchSites()) {
          if (row.lat == null || row.lng == null) continue;
          if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng)) continue;
          if (metresBetween(site.centroid, { lat: row.lat, lng: row.lng }) <= SITE_RADIUS_M) {
            siteId = row.id;
            break;
          }
        }
      } catch (e) {
        /* The listing is an optimisation, not a precondition: failing to read it
           may leave a second row for one beach, which is recoverable, while
           refusing to name anything is not. */
        console.warn("existing sites could not be listed:", e);
      }

      if (siteId) await renameSite(siteId, wanted);
      else {
        const made = await createSite({
          name: wanted,
          lat: site.centroid.lat,
          lng: site.centroid.lng,
        });
        siteId = made.id;
      }

      const ids = writable.map((m) => m.id);
      const res = await assignSite(ids, siteId, wanted);
      applySiteName(siteId, wanted);
      if (res.failed > 0) setError(t("rec.site.partial", { n: res.failed, m: ids.length }));
      else setEditing(false);
    } catch (e) {
      setError(`${t("rec.site.failed")}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [name, members, site.siteId, site.centroid, assignSite, applySiteName, t]);

  /* ------------------------------------------------------- the photographs */
  /* A visit worth showing is a STILL whose engine run left per-animal pixels:
     those two facts are what EvidenceFrame needs to draw the frame with its
     marks. A video has neither a single frame nor pixel marks to put on one,
     so it is absent here rather than represented by a black rectangle.
     Newest first — the standing count's own frame leads. */
  const photoVisits = useMemo(
    () =>
      members
        .filter((f) => !f.videoUrl && f.mediaId && (f.pixels?.length ?? 0) > 0)
        .sort((a, b) => String(b.uploadedAt ?? "").localeCompare(String(a.uploadedAt ?? ""))),
    [members],
  );
  const [shownId, setShownId] = useState<string | null>(null);
  const shown = useMemo(
    () => photoVisits.find((f) => f.id === shownId) ?? photoVisits[0] ?? null,
    [photoVisits, shownId],
  );
  /* The count replay, launched from the photograph itself. Held as the
     footage rather than a boolean so the dialog cannot outlive a site switch
     and replay some other beach's animals. */
  const [replayFor, setReplayFor] = useState<Footage | null>(null);
  /* Switching sites must not leave the previous site's frame selected. */
  useEffect(() => { setShownId(null); setReplayFor(null); }, [site.id]);

  /* ---------------------------------------------------------- the record */
  const events = useMemo(() => {
    const out: Event[] = [];
    const at = (iso: string | null | undefined) => {
      const n = Date.parse(String(iso ?? ""));
      return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
    };

    for (const e of series) {
      const f = e.footage;
      out.push({
        key: `c-${f.id}`,
        kind: "counted",
        t: at(f.uploadedAt),
        when: f.uploadedAt ?? null,
        footageId: f.id,
        text: e.best == null ? t("site.ev.countedNone") : t("site.ev.counted", { n: e.best }),
        detail: f.filename || null,
        who: f.operator ?? null,
      });
    }

    /* A corrected standing count, and what it replaced. Retired sorties are
       included: the correction happened, and hiding it because the flight was
       later withdrawn would edit the record rather than report it. */
    for (const f of [...members, ...retired]) {
      const c = corrections[f.id];
      if (!c) continue;
      const was = c.previous?.best;
      out.push({
        key: `x-${f.id}`,
        kind: "correction",
        t: at(c.at),
        when: c.at,
        footageId: f.id,
        text: t("site.ev.corrected", { n: c.value }),
        detail: [
          was != null && Number.isFinite(was) ? t("site.ev.correctedFrom", { n: was }) : null,
          c.reason ? t("site.ev.reason", { why: c.reason }) : null,
        ].filter(Boolean).join(" · ") || null,
        who: c.by ?? null,
      });
    }

    for (const f of retired) {
      const r = retirement[f.id];
      out.push({
        key: `r-${f.id}`,
        kind: "retired",
        t: at(f.retiredAt),
        when: f.retiredAt ?? null,
        footageId: f.id,
        text: t("site.ev.retired"),
        detail: [
          f.filename || null,
          r?.reason ? t("site.ev.reason", { why: r.reason }) : null,
        ].filter(Boolean).join(" · ") || null,
        who: r?.by ?? null,
      });
    }

    /* Newest first — this is a feed, not a timeline. An unreadable timestamp
       sorts to the bottom rather than being placed by invention. */
    return out.sort((a, b) => b.t - a.t);
  }, [series, members, retired, corrections, retirement, t]);

  /* Field notes, from wherever they were actually written. A note belongs to a
     sortie and carries that sortie's date, so it is shown that way rather than
     merged into one anonymous paragraph about the place. */
  const notes = useMemo(
    () => [...members, ...retired].filter((f) => (f.notes ?? "").trim() !== ""),
    [members, retired],
  );

  const coord = `${site.centroid.lat.toFixed(4)}, ${site.centroid.lng.toFixed(4)}`;
  const visits = members.length + retired.length;
  const band = standing?.band;
  const hasRange = !!band && band.low != null && band.high != null && band.high > band.low;

  /* Which clock this place's dates are on. The same count SiteDynamics makes
     for its own note, made here too because the note only appears with the
     chart, and the chart only appears once there are two counts to compare. */
  const flown = useMemo(
    () => series.filter((e) => (e.footage.capturedAt ?? "").trim() !== "").length,
    [series],
  );
  /* Animals the engine counted with no row anyone can open. A fact about the
     standing figure specifically, so it is read off that visit and not the
     whole series. */
  const unreviewable = standing ? reviewStats(standing.footage).unreviewable : 0;

  /* Dynamics needs two counts to be dynamics; one dot is the hero figure drawn
     again, under a heading that promises a trend. История needs two events for
     the same reason: a lone "counted 575" is the hero in a list. */
  const counted = useMemo(() => series.filter((e) => e.best != null).length, [series]);

  const open = (id: string) => select(id);

  return (
    /* Over the map, against its right edge — the map is the thing this card is
       about, and covering the whole screen with it would break the connection
       between the chip and the panel it opened. */
    <aside className="absolute top-0 right-0 bottom-0 z-20 w-[360px] max-w-[86%] bg-bg border-l border-line flex flex-col">
      <div className="shrink-0 px-4 pt-3.5 pb-3 border-b border-line relative">
        {editing ? (
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) void submit();
              if (e.key === "Escape") { setEditing(false); setError(null); }
            }}
            maxLength={120}
            autoFocus
            placeholder={t("site.namePlaceholder")}
            aria-label={t("rec.site.nameLabel")}
            className="w-full bg-transparent border-0 border-b border-line px-0 pb-1 text-base font-semibold tracking-tight focus:border-ink2 transition-colors"
          />
        ) : (
          /* The title is the PLACE, not an invitation to type. A named beach
             reads as its name; an unnamed one reads as the coordinates that
             identify it, which is the truest heading available and is also the
             only place on this card coordinates appear. Naming is offered as an
             action below, where the other things a reader can do to this place
             already are. */
          <h2
            className={`pr-6 text-base font-semibold tracking-tight truncate ${site.name ? "" : "tnum"}`}
            title={site.name ?? coord}
          >
            {site.name ?? coord}
          </h2>
        )}
        <div className="text-2xs text-ink3 tnum mt-1.5">
          {site.name && <>{coord} · </>}
          {visits} {tp(visits, "unit.sorties")}
        </div>
        <div className="absolute top-3 right-2">
          <IconButton name="close" onClick={onClose} title={t("btn.close")} />
        </div>

        {editing && (
          <div className="mt-2 space-y-2">
            {!site.siteId && members.length > 1 && (
              <p className="text-xs text-ink3 leading-relaxed">
                {t("rec.site.applies", { n: members.length })}
              </p>
            )}
            {progress && (
              <p className="text-xs text-ink2 tnum">
                {t("rec.site.assigning", { n: progress.done, m: progress.total })}
              </p>
            )}
            {error && <p className="text-xs text-bad leading-relaxed">{error}</p>}
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => void submit()} disabled={busy}>
                {t("btn.confirm")}
              </Button>
              <Button onClick={() => { setEditing(false); setError(null); }} disabled={busy}>
                {t("btn.cancel")}
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* The one figure this place contributes to the season. */}
        <div className="px-4 py-4">
          {standing ? (
            <>
              <div className="flex items-end gap-3">
                <span className="tnum text-accent" style={{ fontSize: 42, lineHeight: 0.88, fontWeight: 500, letterSpacing: "-0.038em" }}>
                  {standing.best}
                </span>
                <span className="text-2xs text-ink3 leading-snug pb-1">
                  {tp(standing.best as number, "unit.seals")}
                  {hasRange && (
                    <>
                      <br />
                      {t("misc.range", { low: band!.low as number, high: band!.high as number })}
                    </>
                  )}
                </span>
              </div>
              {/* The date this number was measured on, once, quietly. */}
              <p className="text-2xs text-ink3 tnum mt-2.5 leading-relaxed">
                {t("site.standingBy", {
                  when: formatDate(standing.uploadedAt, lang, { day: "numeric", month: "short", year: "numeric" }),
                })}
                {band?.basis && <> · {basisText(lang, band.basis)}</>}
              </p>
              {/* Everything this figure is NOT: no band, dates that are the
                  count's clock rather than the flight's, animals with no row to
                  check. Each chip's tooltip is the sentence that used to sit
                  here in full. */}
              {(!hasRange || flown < series.length || unreviewable > 0) && (
                <div className="flex flex-wrap gap-1.5 mt-2.5">
                  {!hasRange && <Chip title={t("season.bandNone")}>{t("site.chip.noBand")}</Chip>}
                  {flown < series.length && (
                    <Chip
                      title={
                        flown === 0
                          ? t("dyn.datesJob")
                          : t("dyn.datesMixed", { n: flown, m: series.length })
                      }
                    >
                      {t("site.chip.dateJob")}
                    </Chip>
                  )}
                  {unreviewable > 0 && (
                    <Chip title={t("dash.plusUnreviewable", { n: unreviewable })}>
                      {t("dyn.unreviewable", { n: unreviewable })}
                    </Chip>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="flex items-end gap-3">
                <span className="tnum text-ink4" style={{ fontSize: 42, lineHeight: 0.88, fontWeight: 500 }}>—</span>
                <span className="text-2xs text-ink3 leading-snug pb-1">{t("site.noStanding")}</span>
              </div>
              <p className="text-2xs text-ink3 mt-2.5 leading-relaxed">{t("site.noStandingWhy")}</p>
            </>
          )}
        </div>

        {/* The place, as it was actually photographed. A card that talks about
            700 animals without ever showing one is a spreadsheet about a coast;
            the frame the standing count was measured on belongs at the top of
            it. Only a still can be shown — a video sortie has no single frame
            to stand for it — so the newest visit that carries marked pixels
            wins, and the row underneath offers the others. Clicking opens the
            sortie, where the full evidence view lives. */}
        {photoVisits.length > 0 && shown && (
          <div className="px-4 pb-4">
            {/* Pressing the photograph replays the count over it — the number
                this card leads with, earned again in front of the reader. The
                badge is an affordance label inside the same button, not a
                second control; the sortie record keeps its own door in the
                caption row below. */}
            <button
              type="button"
              onClick={() => setReplayFor(shown)}
              title={t("insp.replay")}
              className="block w-full text-left group relative"
            >
              <div className="aspect-video bg-bg border border-hair overflow-hidden">
                <EvidenceFrame mediaId={shown.mediaId as string} pixels={shown.pixels ?? []} />
              </div>
              <span className="pointer-events-none absolute bottom-2 right-2 plate inline-flex items-center gap-1.5 h-7 px-2.5 text-xs text-ink2 group-hover:text-ink transition-colors">
                <Icon name="play" size={12} />
                {t("insp.replay")}
              </span>
            </button>
            {/* Which file this is. Its date only when the frame on screen is
                NOT the one the standing figure was measured on — otherwise the
                line under the hero already said it, and saying it twice is how
                a reader stops believing either. */}
            <div className="flex items-baseline gap-2 mt-1.5">
              <span className="text-2xs text-ink3 truncate">{shown.filename}</span>
              {shown.id !== standing?.footage.id && (
                <span className="text-2xs text-ink3 tnum ml-auto shrink-0">
                  {formatDate(shown.uploadedAt, lang, { day: "numeric", month: "short" })}
                </span>
              )}
            </div>

            {photoVisits.length > 1 && (
              /* Every other photographed visit of this place, smallest useful
                 size. Same haul-out a month apart, side by side — which is the
                 comparison the whole site-first idea exists to make. */
              <div className="flex gap-1.5 mt-2 overflow-x-auto pb-1">
                {photoVisits.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setShownId(f.id)}
                    title={`${f.filename} · ${formatDate(f.uploadedAt, lang, { day: "numeric", month: "short" })}`}
                    className={`shrink-0 w-[68px] aspect-video overflow-hidden border transition-colors ${
                      f.id === shown.id ? "border-accent" : "border-hair hover:border-ink3"
                    }`}
                  >
                    <EvidenceFrame mediaId={f.mediaId as string} pixels={[]} />
                  </button>
                ))}
              </div>
            )}

            {replayFor && (
              <ReplayView
                open
                onOpenChange={(o) => { if (!o) setReplayFor(null); }}
                footage={replayFor}
              />
            )}
          </div>
        )}

        {/* Everything a reader can DO here, in one row, once. These used to be
            scattered as a badge, an underlined word in a caption and a heading
            that was secretly a button — three different shapes for three
            equally ordinary actions. The badge on the photograph stays, because
            pressing the photograph really does replay the count and a control
            with no label is not a control. */}
        <div className="px-4 pb-4 flex flex-wrap gap-2">
          {shown && (
            <Button icon="play" onClick={() => setReplayFor(shown)}>
              {t("insp.replay")}
            </Button>
          )}
          {shown && <Button onClick={() => open(shown.id)}>{t("site.openSortie")}</Button>}
          <Button onClick={() => setEditing(true)} disabled={editing}>
            {site.name ? t("rec.site.rename") : t("rec.site.nameIt")}
          </Button>
        </div>

        {/* Every visit: the chart, then the same visits written out. Reused
            wholesale — this is the component the analytics panel used to hide
            behind a disclosure, and it was always the right drawing. Two counts
            minimum: with one, every line of it is the hero repeated. */}
        {counted >= 2 && (
          <div className="px-4 py-4 border-t border-hair">
            <span className="hd">{t("site.dynamics")}</span>
            <SiteDynamics site={site} series={series} onPick={(f) => open(f.id)} />
          </div>
        )}

        {/* What has been done to these numbers, and by whom — once there is
            more than one thing to say. A single event is always the count the
            hero figure already is. */}
        {events.length >= 2 && (
          <div className="px-4 py-4 border-t border-hair">
            <span className="hd">{t("site.history")}</span>
            <ul className="mt-2.5">
              {events.map((e) => (
                <li key={e.key} className="flex gap-2.5 pb-2.5 last:pb-0">
                  {/* The marker carries the KIND, by weight: a correction is
                      the loudest thing that can happen to a number, a
                      retirement is a withdrawal and is drawn as a stroke
                      through rather than a dot. */}
                  <span aria-hidden="true" className="relative w-3 shrink-0 flex justify-center">
                    <span
                      className={
                        e.kind === "correction"
                          ? "bg-ink"
                          : e.kind === "retired"
                            ? "bg-ink4"
                            : "bg-ink3"
                      }
                      style={
                        e.kind === "retired"
                          ? { width: 9, height: 1, marginTop: 7 }
                          : { width: 5, height: 5, marginTop: 5 }
                      }
                    />
                  </span>
                  <button
                    type="button"
                    onClick={() => open(e.footageId)}
                    title={t("sec.sortie")}
                    className="flex-1 min-w-0 text-left px-1 -mx-1 py-0.5 hover:bg-hover transition-colors"
                  >
                    <span className="block text-xs text-ink2 leading-snug">
                      {e.text}
                      {e.who && <span className="text-ink3"> · {e.who}</span>}
                    </span>
                    {e.detail && (
                      <span className="block text-2xs text-ink3 leading-tight mt-0.5 truncate" title={e.detail}>
                        {e.detail}
                      </span>
                    )}
                    <span className="block text-2xs text-ink4 tnum leading-tight mt-0.5">
                      {e.when
                        ? formatDate(e.when, lang, { day: "numeric", month: "short", year: "numeric" })
                        : "—"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* A person's own words about the place. Read-only here on purpose. */}
        <div className="px-4 py-4 border-t border-hair">
          <span className="hd">{t("rec.notes.title")}</span>
          {notes.length === 0 ? (
            <>
              <p className="text-xs text-ink4 mt-2 leading-relaxed italic">{t("site.noteEmpty")}</p>
              {/* Where notes DO get written — said once, to the reader who has
                  none and might otherwise look for an editor here. With notes
                  on screen it is a footnote about something already visible. */}
              <p className="text-2xs text-ink4 mt-2.5 leading-relaxed">{t("site.noteWhere")}</p>
            </>
          ) : (
            <ul className="mt-2.5 space-y-2.5">
              {notes.map((f) => (
                <li key={f.id} className="pl-3 border-l border-line">
                  <p className="text-xs text-ink2 leading-relaxed whitespace-pre-wrap">{f.notes}</p>
                  <button
                    type="button"
                    onClick={() => open(f.id)}
                    className="text-2xs text-ink4 tnum mt-1 hover:text-ink2 transition-colors"
                  >
                    {formatDate(f.uploadedAt, lang, { day: "numeric", month: "short", year: "numeric" })}
                    {f.operator ? ` · ${f.operator}` : ""}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </aside>
  );
}
