"use client";
/* Correcting what the file got wrong.
 *
 * A drone writes its altitude into the telemetry and the service derives a
 * scale from it; when the clip has been cropped, re-encoded or shot on a rig
 * the optics table does not know, that scale is wrong and every hectare
 * downstream is wrong with it. The person who flew the sortie knows the real
 * altitude. This is where they say so.
 *
 * The downstream notice is the point of the component, and it is written to be
 * SPECIFIC and TRUE, because a vague one ("this may affect results") is how a
 * product teaches its users to ignore warnings:
 *
 *   - the photographed area IS recomputed, here and in the totals, from the
 *     new scale (and the store recomputes it from the frame geometry, not by
 *     leaving the old hectares under a new number);
 *   - the COUNT is not. Re-deriving a count needs another run of the engine at
 *     the new tiling — nothing in this form can do it, and pretending
 *     otherwise would be the same false promise the endpoint audit caught;
 *   - altitude alone re-derives the scale service-side, so the area moves even
 *     when the scale field is left untouched;
 *   - the date moves the sortie on the timeline, and the current estimate
 *     takes the LATEST visit at each site — so a corrected date can change
 *     which visit stands for this place.
 */
import { useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import type { Footage } from "@/lib/types";
import { useFootageStore, type SurveyPatch } from "@/store/useFootageStore";
import { Button, SectionHead } from "@/components/ui/primitives";

/* The service's own tide vocabulary, plus the "leave it alone" entry. These
   are stored values, not prose — the labels are translated, the tokens are
   not, so a correction made in Kazakh reads the same to the endpoint. */
const TIDES = ["low", "falling", "high", "rising", "unknown"] as const;

/* Correcting a measurement is typing a number on a ruled line. Boxed inputs
   drew five identical grey rectangles down a 380px column and made the form
   the loudest thing in the inspector; the rule under each value is enough,
   and the label above it in plain case does the rest. */
const LABEL = "label";
const FIELD =
  "w-full h-7 mt-0.5 bg-transparent border-0 border-b border-line px-0 text-sm " +
  "placeholder:text-ink4 focus:border-ink2 transition-colors";

/** `2026-04-11T08:12:00Z` -> `2026-04-11` for a date input, in UTC: the input
 *  has no zone, and shifting a capture date by the reader's offset would move
 *  a morning sortie to the previous day in the field. */
function dateValue(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

const numText = (v: number | null | undefined): string =>
  typeof v === "number" && Number.isFinite(v) ? String(v) : "";

export default function SurveyMetaEdit({ f }: { f: Footage }) {
  const { t } = useT();
  const patchSurveyFields = useFootageStore((s) => s.patchSurveyFields);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initial = useMemo(
    () => ({
      captured: dateValue(f.capturedAt),
      altitude: numText(f.altitudeM),
      gsd: numText(f.gsdCmPx),
      tide: f.tideState ?? "",
    }),
    [f.capturedAt, f.altitudeM, f.gsdCmPx, f.tideState],
  );
  const [form, setForm] = useState(initial);
  const [editingId, setEditingId] = useState(f.id);
  if (editingId !== f.id) {
    /* A different sortie is a different form. Rendering sortie A's typed
       altitude over sortie B's row is the kind of quiet mix-up that ends with
       the wrong survey corrected. */
    setEditingId(f.id);
    setForm(initial);
  }

  const set = (k: keyof typeof form, v: string) => setForm((s) => ({ ...s, [k]: v }));
  const today = new Date().toISOString().slice(0, 10);

  const submit = async () => {
    setError(null);
    const patch: SurveyPatch = {};

    if (form.captured !== initial.captured) {
      if (form.captured && form.captured > today) { setError(t("rec.meta.futureDate")); return; }
      patch.captured_at = form.captured ? `${form.captured}T00:00:00Z` : null;
    }
    /* Only what actually changed goes on the wire. Re-sending an untouched
       gsd_cm_px would stamp `gsd_source: explicit` on a scale nobody typed —
       an assumed number laundered into a measured one by a form submit. */
    if (form.altitude !== initial.altitude && form.altitude.trim()) {
      const n = Number(form.altitude.trim());
      if (!Number.isFinite(n) || n <= 0) { setError(t("rec.meta.badNumber")); return; }
      patch.altitude_m = n;
    }
    if (form.gsd !== initial.gsd && form.gsd.trim()) {
      const n = Number(form.gsd.trim());
      if (!Number.isFinite(n) || n <= 0) { setError(t("rec.meta.badNumber")); return; }
      patch.gsd_cm_px = n;
    }
    if (form.tide !== initial.tide) patch.tide_state = form.tide || null;

    if (!Object.keys(patch).length) { setError(t("rec.meta.unchanged")); return; }
    setBusy(true);
    const ok = await patchSurveyFields(f.id, patch);
    setBusy(false);
    if (ok) setOpen(false);
    else setError(t("rec.meta.failed"));
  };

  if (!f.surveyId) return null;

  return (
    <div className="px-4 py-3 border-b border-line">
      <SectionHead
        title={t("rec.meta.edit")}
        className="mb-1.5"
        right={
          <button
            onClick={() => { setOpen((v) => !v); setError(null); }}
            className="text-xs text-ink3 hover:text-ink transition-colors"
          >
            {open ? t("rec.edits.hide") : t("rec.edits.show")}
          </button>
        }
      />
      {open && (
        <div className="space-y-3">
          <label className="block">
            <span className={LABEL}>{t("rec.meta.capturedAt")}</span>
            <input
              type="date"
              max={today}
              value={form.captured}
              onChange={(e) => set("captured", e.target.value)}
              className={`${FIELD} tnum`}
            />
          </label>
          <div className="flex gap-4">
            <label className="block flex-1 min-w-0">
              <span className={LABEL}>{t("rec.meta.altitude")}</span>
              <input
                inputMode="decimal"
                value={form.altitude}
                onChange={(e) => set("altitude", e.target.value)}
                className={`${FIELD} tnum`}
              />
            </label>
            <label className="block flex-1 min-w-0">
              <span className={LABEL}>{t("rec.meta.gsd")}</span>
              <input
                inputMode="decimal"
                value={form.gsd}
                onChange={(e) => set("gsd", e.target.value)}
                className={`${FIELD} tnum`}
              />
            </label>
          </div>
          <label className="block">
            <span className={LABEL}>{t("rec.meta.tide")}</span>
            <select
              value={form.tide}
              onChange={(e) => set("tide", e.target.value)}
              className={`${FIELD} text-ink`}
            >
              <option value="">{t("rec.tide.unset")}</option>
              {TIDES.map((v) => (
                <option key={v} value={v}>
                  {v === "low" ? t("rec.tide.low")
                    : v === "falling" ? t("rec.tide.falling")
                    : v === "high" ? t("rec.tide.high")
                    : v === "rising" ? t("rec.tide.rising")
                    : t("rec.tide.unknown")}
                </option>
              ))}
            </select>
          </label>

          {/* Four consequences of a correction, ruled off from the fields
              rather than boxed into a notice. */}
          <div className="text-xs text-ink3 leading-relaxed space-y-1 pt-1.5 border-t border-hair">
            <p>{t("rec.meta.noticeArea")}</p>
            <p>{t("rec.meta.noticeAlt")}</p>
            {/* The one sentence that must never soften: nothing here re-counts. */}
            <p className="text-ink2">{t("rec.meta.noticeCount")}</p>
            <p>{t("rec.meta.noticeDate")}</p>
          </div>

          {error && <p className="text-xs text-bad leading-relaxed">{error}</p>}
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => void submit()} disabled={busy}>
              {busy ? t("rec.meta.saving") : t("rec.meta.save")}
            </Button>
            <Button onClick={() => { setOpen(false); setForm(initial); setError(null); }} disabled={busy}>
              {t("btn.cancel")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
