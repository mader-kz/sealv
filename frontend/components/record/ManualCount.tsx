"use client";
/* A count a person made, standing on the shore.
 *
 * Not every survey is a drone. Ground counts from a boat, a headland or a
 * hide are how most of this coastline has ever been counted, and a platform
 * that can only hold engine output quietly tells an ecologist their own
 * fieldwork does not count. So it is stored, it participates in the site
 * estimate as a sortie — one visit, one place, one date — and it is labelled
 * `manual` everywhere it appears.
 *
 * What it deliberately does NOT get is a band. The engine's low–high is the
 * disagreement between frames of the same colony; a person looked once and
 * said a number. Fabricating ±10% around it to make the row look like the
 * others would be inventing an uncertainty nobody measured, which is exactly
 * the failure this product is built against. low = best = high, and the
 * inspector draws no range strip over it.
 */
import { useEffect, useMemo, useState } from "react";
import { fetchSites, METHOD_MAX, OPERATOR_MAX, NOTES_MAX, type SiteOut } from "@/lib/api";
import { getOperator } from "@/lib/identity";
import { useT } from "@/lib/i18n";
import { useFootageStore } from "@/store/useFootageStore";
import { Button } from "@/components/ui/primitives";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const LABEL = "text-2xs text-ink3";
const INPUT =
  "w-full h-7 mt-0.5 bg-surface2 border border-line rounded px-2 text-sm text-ink placeholder:text-ink3 focus:outline-none focus:border-ink3 transition-colors";

export default function ManualCount({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useT();
  const addObservation = useFootageStore((s) => s.addObservation);
  const pinPoints = useFootageStore((s) => s.pinPoints);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [count, setCount] = useState("");
  const [date, setDate] = useState(today);
  const [siteId, setSiteId] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [method, setMethod] = useState("");
  const [note, setNote] = useState("");
  const [operator, setOperator] = useState("");
  const [sites, setSites] = useState<SiteOut[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* Fresh every time it opens, and the operator prefilled from whoever the
     top bar says is recording — a name typed once should not have to be typed
     again for every observation. */
  useEffect(() => {
    if (!open) return;
    setCount("");
    setDate(today);
    setSiteId("");
    setLat("");
    setLng("");
    setMethod("");
    setNote("");
    setOperator(getOperator() ?? "");
    setError(null);
    let alive = true;
    void (async () => {
      try {
        const rows = await fetchSites();
        if (alive) setSites(rows);
      } catch {
        /* No site list is not a blocker: a typed coordinate or the map pin is
           a complete location on its own. */
        if (alive) setSites([]);
      }
    })();
    return () => { alive = false; };
  }, [open, today]);

  const pin = pinPoints.length ? pinPoints[pinPoints.length - 1] : null;

  const pickSite = (id: string) => {
    setSiteId(id);
    const s = sites.find((x) => x.id === id);
    /* The site's own coordinate becomes the observation's, unless the observer
       has already typed one — a place has a position, and re-typing it from
       memory is how a count lands a kilometre from the beach it was made on. */
    if (s && s.lat != null && s.lng != null && !lat && !lng) {
      setLat(String(s.lat));
      setLng(String(s.lng));
    }
  };

  const submit = async () => {
    setError(null);
    const n = Number(count.trim());
    if (!count.trim() || !Number.isInteger(n) || n < 0) { setError(t("rec.manual.badCount")); return; }
    if (!date) { setError(t("rec.manual.dateRequired")); return; }
    if (date > today) { setError(t("rec.manual.futureDate")); return; }
    const la = Number(lat.trim());
    const ln = Number(lng.trim());
    if (!lat.trim() || !lng.trim() || !Number.isFinite(la) || !Number.isFinite(ln)) {
      setError(t("rec.manual.badLocation"));
      return;
    }
    if (la < -90 || la > 90 || ln < -180 || ln > 180) { setError(t("rec.manual.badLocation")); return; }

    setBusy(true);
    const ok = await addObservation({
      count: n,
      captured_at: `${date}T00:00:00Z`,
      lat: la,
      lng: ln,
      site_id: siteId || null,
      operator: operator.trim().slice(0, OPERATOR_MAX) || null,
      notes: note.trim().slice(0, NOTES_MAX) || null,
      /* METHOD_MAX, not 200: the service caps `method` at 120 and a
         121-character entry 400d behind a generic failure toast. The
         input below stops at the same number. */
      method: method.trim().slice(0, METHOD_MAX) || null,
    });
    setBusy(false);
    if (ok) onOpenChange(false);
    else setError(t("rec.manual.failed"));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="max-w-[420px] w-[92vw] p-0 gap-0 bg-surface border-line rounded"
      >
        <DialogHeader className="px-4 py-3 pr-12 border-b border-line space-y-0">
          <DialogTitle className="text-sm font-medium text-ink tracking-normal">
            {t("rec.manual.title")}
          </DialogTitle>
        </DialogHeader>

        <div className="px-4 py-3 space-y-2.5 max-h-[70vh] overflow-auto">
          <p className="text-2xs text-ink3 leading-relaxed">{t("rec.manual.lead")}</p>

          <div className="flex gap-1.5">
            <label className="block flex-1 min-w-0">
              <span className={LABEL}>{t("rec.manual.count")}</span>
              <input
                inputMode="numeric"
                value={count}
                onChange={(e) => setCount(e.target.value)}
                className={`${INPUT} tnum`}
              />
            </label>
            <label className="block flex-1 min-w-0">
              <span className={LABEL}>{t("rec.manual.date")}</span>
              <input
                type="date"
                max={today}
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className={`${INPUT} tnum`}
              />
            </label>
          </div>

          <div>
            <span className={LABEL}>{t("rec.manual.location")}</span>
            {sites.length > 0 && (
              <select
                value={siteId}
                onChange={(e) => pickSite(e.target.value)}
                className={INPUT}
                aria-label={t("rec.site.label")}
              >
                <option value="">{t("rec.site.unnamed")}</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            )}
            <div className="flex gap-1.5 mt-1">
              <label className="block flex-1 min-w-0">
                <span className={LABEL}>{t("rec.manual.lat")}</span>
                <input
                  inputMode="decimal"
                  value={lat}
                  onChange={(e) => setLat(e.target.value)}
                  className={`${INPUT} tnum font-mono`}
                />
              </label>
              <label className="block flex-1 min-w-0">
                <span className={LABEL}>{t("rec.manual.lng")}</span>
                <input
                  inputMode="decimal"
                  value={lng}
                  onChange={(e) => setLng(e.target.value)}
                  className={`${INPUT} tnum font-mono`}
                />
              </label>
            </div>
            {pin ? (
              <button
                onClick={() => { setLat(String(pin.lat)); setLng(String(pin.lng)); }}
                className="text-2xs text-accent hover:underline mt-1"
              >
                {t("rec.manual.usePin")}
              </button>
            ) : (
              <p className="text-2xs text-ink3 mt-1 leading-relaxed">{t("rec.manual.pinHint")}</p>
            )}
          </div>

          <label className="block">
            <span className={LABEL}>{t("rec.manual.method")}</span>
            <input
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              maxLength={METHOD_MAX}
              placeholder={t("rec.manual.methodPlaceholder")}
              className={INPUT}
            />
          </label>

          <label className="block">
            <span className={LABEL}>{t("rec.manual.operator")}</span>
            <input
              value={operator}
              onChange={(e) => setOperator(e.target.value)}
              maxLength={OPERATOR_MAX}
              className={INPUT}
            />
          </label>

          <label className="block">
            <span className={LABEL}>{t("rec.manual.note")}</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, NOTES_MAX))}
              maxLength={NOTES_MAX}
              rows={2}
              className="w-full mt-0.5 bg-surface2 border border-line rounded px-2 py-1.5 text-sm text-ink placeholder:text-ink3 focus:outline-none focus:border-ink3 transition-colors resize-y"
            />
          </label>

          <p className="text-2xs text-ink3 leading-relaxed">{t("rec.manual.noBand")}</p>
          {error && <p className="text-2xs text-bad leading-relaxed">{error}</p>}
        </div>

        <div className="px-4 py-3 border-t border-line flex gap-1.5">
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? t("rec.manual.saving") : t("rec.manual.submit")}
          </Button>
          <Button onClick={() => onOpenChange(false)} disabled={busy}>
            {t("btn.cancel")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
