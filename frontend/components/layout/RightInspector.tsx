"use client";
import { useFootageStore } from "@/store/useFootageStore";
import { useEffect, useMemo, useState } from "react";
import { Button, Row, SectionHead, Pill } from "@/components/ui/primitives";
import Icon from "@/components/ui/Icon";
import EvidenceView, { EvidenceFrame } from "@/components/evidence/EvidenceView";
import { basisText, useT } from "@/lib/i18n";
import { formatArea } from "@/lib/analytics/area";

export default function RightInspector({ compact }: { compact?: boolean }){
  const { t, tp, lang } = useT();
  const footages = useFootageStore(s=>s.footages);
  const selectedId = useFootageStore(s=>s.selectedId);
  const select = useFootageStore(s=>s.select);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const f = useMemo(()=> footages.find(x=>x.id===selectedId) || null, [footages, selectedId]);

  /* A selection change swaps the sortie under the dialog; showing sortie B's
     photo in a dialog opened for sortie A would be quiet misinformation. */
  useEffect(() => { setEvidenceOpen(false); }, [selectedId]);

  const shell = `w-[340px] ${compact ? "flex-1" : "shrink-0 border-l border-line"} bg-surface flex flex-col overflow-hidden`;

  if (!f) {
    return (
      <div className={shell}>
        <div className="flex-1 grid place-items-center p-8 text-center">
          <div className="max-w-[220px]">
            <Icon name="target" size={20} className="text-ink3 mx-auto" />
            <p className="text-sm text-ink2 mt-3 leading-relaxed">
              {t("insp.selectHint")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const det = f.detections[0] || null;
  /* The Evidence view exists only where its raw material does: a photo
     sortie whose engine run left us the media id and per-animal pixels.
     Everything here is optional on Footage - guard all of it, or the
     inspector goes down with the whole app (it already did once). */
  const evidence =
    !f.videoUrl && f.mediaId && f.pixels && f.pixels.length > 0
      ? { mediaId: f.mediaId, pixels: f.pixels }
      : null;
  /* With the real engine a sortie holds one detection PER ANIMAL, so the
     headline is the band's best estimate; summing detections is the fallback
     for test data, which never carries a band. */
  const totalSeals = f.band?.best ?? f.detections.reduce((s, d) => s + d.count, 0);
  const hasRange = !!f.band && f.band.low != null && f.band.high != null && f.band.low !== f.band.high;
  /* How much of this count a human has actually signed off on. False positives
     are excluded from both sides: a rejected detection is not evidence for or
     against the animals that remain. */
  const validated = f.detections.filter(d => d.status === "validated").length;
  const reviewable = validated + f.detections.filter(d => d.status === "auto").length;

  return (
    <div className={shell}>
      {/* The count is the answer this product exists to give — so it leads. */}
      <div className="px-4 pt-4 pb-3.5 border-b border-line">
        {f.status === "error" ? (
          <div>
            <div className="text-sm text-bad font-medium">{t("insp.countFailed")}</div>
            <div className="text-2xs text-ink3 mt-1 break-words">{f.error}</div>
          </div>
        ) : f.status === "processing" ? (
          <div className="flex items-baseline gap-2">
            <span className="text-hero tnum font-medium leading-none text-ink3 animate-pulse">…</span>
            <span className="text-sm text-ink2">{t("insp.counting")}</span>
          </div>
        ) : (
          <div className="flex items-baseline gap-2">
            <span className="text-hero tnum font-medium leading-none">{totalSeals}</span>
            <span className="text-sm text-ink2">{tp(totalSeals, "insp.sealsCounted")}</span>
          </div>
        )}

        {/* The range is not decoration: frames of the same colony disagree,
            and a single integer would be false precision. Test data has no
            band, so this strip only appears over a real count. */}
        {hasRange && f.band && (
          <div className="mt-3">
            <div className="relative h-1.5 rounded-full bg-surface2">
              <div className="absolute inset-y-0 rounded-full bg-accent-soft"
                   style={{ left: "6%", right: "6%" }} />
              <div className="absolute top-1/2 -translate-y-1/2 h-3 w-0.5 rounded bg-accent"
                   style={{ left: `${6 + 88 * (((f.band.best ?? 0) - (f.band.low ?? 0)) / Math.max(1, (f.band.high ?? 1) - (f.band.low ?? 0)))}%` }} />
            </div>
            <div className="flex justify-between mt-1 text-2xs tnum text-ink3">
              <span>{f.band.low}</span>
              <span className="text-ink2">{t("insp.rangeBetweenFrames")}</span>
              <span>{f.band.high}</span>
            </div>
          </div>
        )}

        <div className="flex items-center flex-wrap gap-2 mt-2.5">
          {f.source==="test" && <Pill tone="accent">{t("pill.testData")}</Pill>}
          {/* No confidence pill. The detector's score is an uncalibrated model
              output; printing it as "NN% confidence" dressed it up as a
              probability the number cannot support. The band is the honest
              uncertainty, and it is already above. */}
          {f.band?.basis && <Pill tone="neutral">{basisText(lang, f.band.basis)}</Pill>}
          {det?.status === "validated" && <Pill tone="good">{t("status.validated")}</Pill>}
          {det?.status === "false_positive" && <Pill tone="bad">{t("status.falsePositive")}</Pill>}
          {f.band && (
            <span className="text-2xs text-ink3">
              {f.unplaced
                ? `${t("insp.onMap", { n: f.detections.length })} · ${t("insp.withoutCoords", { n: f.unplaced })}`
                : t("insp.onMap", { n: f.detections.length })}
            </span>
          )}
        </div>
      </div>

      {/* frame preview: the real photo with every animal marked when the
          engine gave us one; the video player for video; the placeholder
          only where there is genuinely nothing to show. */}
      <div className="aspect-video bg-bg border-b border-line relative shrink-0">
        {f.videoUrl ? (
          <video src={f.videoUrl} controls className="w-full h-full object-contain" />
        ) : evidence ? (
          <>
            <EvidenceFrame mediaId={evidence.mediaId} pixels={evidence.pixels} />
            <Button
              icon="search"
              className="absolute bottom-2 right-2 shadow-pop"
              onClick={() => setEvidenceOpen(true)}
            >
              {t("insp.openEvidence")}
            </Button>
          </>
        ) : (
          <FramePreview filename={f.filename} count={totalSeals} det={det} />
        )}
      </div>

      {evidence && (
        <EvidenceView
          open={evidenceOpen}
          onOpenChange={setEvidenceOpen}
          mediaId={evidence.mediaId}
          pixels={evidence.pixels}
          band={f.band ?? null}
        />
      )}

      <div className="flex-1 overflow-auto">
        {/* The engine's own reasons not to trust its band, first - before the
            filename, before anything. They are English sentences straight from
            the run's quality ledger and are rendered verbatim: they are the
            evidence, and paraphrasing evidence is how a floor becomes a
            measurement. Absent (not empty) means the service never reported
            them, and silence is the only honest rendering of that. */}
        {f.caveats && (
          <div className="px-4 py-3 border-b border-line">
            <SectionHead title={t("sec.caveats")} className="mb-1.5" />
            {f.caveats.length ? (
              f.caveats.map((c, i) => (
                <div key={i} className="flex items-start gap-1.5 py-1 border-b border-line-soft last:border-0">
                  <Icon name="alert" size={12} className="text-accent shrink-0 mt-[3px]" />
                  <span className="text-xs text-ink2 leading-relaxed break-words">{c}</span>
                </div>
              ))
            ) : (
              <div className="text-xs text-ink3 py-1">{t("insp.noCaveats")}</div>
            )}
          </div>
        )}

        <div className="px-4 py-3">
          <SectionHead title={t("sec.sortie")} className="mb-1" />
          <Row label={t("row.file")} value={f.filename} mono />
          {/* A still has no duration; "0s" read as a broken video rather than
              as a photo. Region is gone for a harder reason: "KZ-East" was a
              latitude threshold wearing a toponym's clothes. Coordinates are
              the measured thing, so coordinates are what is shown. */}
          {f.duration > 0 && <Row label={t("row.duration")} value={`${f.duration}${t("unit.s")}`} mono />}
          <Row label={t("row.source")} value={f.source} />
          <Row label={t("row.track")} value={`${f.track.length} ${tp(f.track.length, "misc.trackPoints")}`} mono />
          <Row
            label={t("row.location")}
            value={`${f.center.lat.toFixed(4)}, ${f.center.lng.toFixed(4)}`}
            mono
          />
          {(f.areaM2 != null || f.gsdSource) && (
            <Row
              label={t("row.footprint")}
              value={
                <span className="inline-flex items-baseline gap-1.5">
                  {/* Hectares, formatted by the same shared helper the
                      dashboard total uses - one unit for one quantity across
                      the product. */}
                  <span className="font-mono tnum">
                    {f.areaM2 != null ? `${formatArea(f.areaM2, lang)} ${t("unit.ha")}` : "—"}
                  </span>
                  {f.gsdSource && <span className="text-2xs text-ink3">{gsdNote(f.gsdCmPx, f.gsdSource)}</span>}
                </span>
              }
            />
          )}
          {reviewable > 0 && (
            <Row
              label={t("row.review")}
              value={t("insp.verifiedShare", {
                n: validated,
                pct: Math.round((validated / reviewable) * 100),
              })}
            />
          )}
        </div>

        <div className="px-4 pb-4 flex gap-1.5">
          {/* Per-animal exports, not a dump of this component's state. The old
              "Export JSON" handed over the store object - internal shape, no
              schema, useless to QGIS or a spreadsheet. */}
          <Button
            icon="download"
            full
            onClick={async ()=>{
              const m = await import("@/lib/export/animals");
              m.exportAnimalsGeoJSON([f]);
            }}
          >
            GeoJSON
          </Button>
          <Button
            icon="download"
            full
            onClick={async ()=>{
              const m = await import("@/lib/export/animals");
              m.exportAnimalsCSV([f]);
            }}
          >
            CSV
          </Button>
          <Button
            icon="copy"
            title={t("btn.copyCoords")}
            onClick={()=> navigator.clipboard.writeText(`${f.center.lat},${f.center.lng}`)}
          />
        </div>
      </div>
    </div>
  );
}

/* Scale and where it came from. `gsd_source` stays a machine word (optics,
   assumed_native_width, unknown) - the same token the service and the exports
   use, and an assumed scale written out as prose would read like a measured
   one. With no GSD there is no area, so the source is shown alone: it says why
   the footprint is a dash. */
function gsdNote(gsd: number | null | undefined, source: string): string {
  return gsd ? `GSD: ${gsd.toFixed(1)} cm/px · ${source}` : `GSD: ${source}`;
}

function FramePreview({ filename, count, det }: { filename:string; count:number; det:any }){
  return (
    <div className="w-full h-full relative bg-[#0d0f11] overflow-hidden grid place-items-center">
      <div
        className="absolute inset-0 opacity-60"
        style={{ background:"radial-gradient(ellipse at 35% 40%, #14202a 0%, transparent 65%)" }}
      />
      {/* bbox is optional and, since the real engine replaced the mock, usually
          absent: the counter returns a point per animal, not a box. The mock
          always supplied one, so the old code indexed it unguarded - which
          crashed the whole app the moment a real sortie was selected. */}
      {det && Array.isArray(det.bbox) && det.bbox.length === 4 && (
        <div
          className="absolute border border-accent rounded-[2px]"
          style={{ left: `${det.bbox[0]*100}%`, top: `${det.bbox[1]*100}%`, width: `${det.bbox[2]*100}%`, height: `${det.bbox[3]*100}%` }}
        >
          <span className="absolute -top-[15px] left-0 bg-accent text-accent-ink text-2xs font-medium px-1 rounded-sm leading-[14px] tnum">
            {count}
          </span>
        </div>
      )}
      <span className="absolute bottom-2 left-2.5 text-2xs font-mono text-ink3 truncate max-w-[80%]">{filename}</span>
    </div>
  );
}
