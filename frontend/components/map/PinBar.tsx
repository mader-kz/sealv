"use client";
/**
 * PinBar — the whole pin decision, in one object, on the screen where pinning
 * happens.
 *
 * Two things were wrong and they had the same shape. Splitting the app into
 * modes put the card that asks for a location on Загрузка and the map you pin
 * on under Карта, so walking over to place the point left an armed crosshair
 * with nothing to finish or cancel with. Then this bar fixed that and created
 * the second half of the problem: the coordinate readout stayed in the map's
 * top-left corner while the confirm sat at the bottom — the same coordinate and
 * the same "click again to move it" sentence printed twice, 800px apart, and
 * one action split across two corners of a 1500px screen.
 *
 * So everything the decision needs is here: which file is waiting, where the
 * point is, at what precision, the typed-coordinate escape hatch, confirm,
 * cancel. Escape cancels, because a mode you cannot leave with the keyboard is
 * a trap.
 *
 * It never invents state. `pinTarget` and the queue item are the store's; the
 * confirm writes exactly what the queue card's confirm wrote (anchor with its
 * provenance, then resume). If no item owns the pin — the file was dismissed
 * while the operator was looking at the map — the bar says so and offers only
 * the way out.
 */
import { useEffect, useState } from "react";
import { useFootageStore } from "@/store/useFootageStore";
import { useIngestStore } from "@/store/useIngestStore";
import { Button } from "@/components/ui/primitives";
import { parseLatLng } from "@/lib/parsers/latlng";
import { useT } from "@/lib/i18n";

export default function PinBar() {
  const { t } = useT();
  const pinMode = useFootageStore((s) => s.pinMode);
  const pinPoints = useFootageStore((s) => s.pinPoints);
  const setPinMode = useFootageStore((s) => s.setPinMode);
  const setPinPoints = useFootageStore((s) => s.setPinPoints);

  const items = useIngestStore((s) => s.items);
  const pinTarget = useIngestStore((s) => s.pinTarget);
  const pinEntry = useIngestStore((s) => s.pinEntry);
  const claimPin = useIngestStore((s) => s.claimPin);
  const setAnchor = useIngestStore((s) => s.setAnchor);
  const resume = useIngestStore((s) => s.resume);

  const [text, setText] = useState("");
  const [bad, setBad] = useState(false);

  const item = items.find((i) => i.id === pinTarget) ?? null;
  const point = pinPoints.length ? pinPoints[0] : null;
  const typed = pinEntry === "typed";

  const cancel = () => {
    claimPin(null);
    setPinMode(false);
    setPinPoints([]);
    setText("");
    setBad(false);
  };

  useEffect(() => {
    if (!pinMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pinMode]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!pinMode) return null;

  /* One shared parser, and a pure one: inline, it used to reject the commonest
     paste in the world — "43.65,51.18" straight out of Google Maps — because it
     normalised the decimal comma before splitting on the separator. */
  const applyTyped = () => {
    const p = parseLatLng(text);
    if (!p) {
      setBad(true);
      return;
    }
    setBad(false);
    setText("");
    setPinPoints([{ t: 0, lat: p.lat, lng: p.lng }]);
    try {
      useIngestStore.getState().notePin("typed", null);
    } catch {}
    document.dispatchEvent(new CustomEvent("flyto", { detail: { lat: p.lat, lng: p.lng } }));
  };

  return (
    <div className="absolute left-1/2 -translate-x-1/2 bottom-5 z-30 plate px-3 py-2.5 w-[min(620px,92vw)]">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {item ? (
            <>
              <div className="text-sm text-ink truncate" title={item.fileName}>
                {item.fileName}
              </div>
              {point ? (
                <>
                  {/* The figure, set like one: tabular, reading size. Printed at
                      the precision it is STORED at — a click is rounded to three
                      decimals on the way into the store, a typed coordinate is
                      kept verbatim, and trimming that here would show 43.651 for
                      a value that reaches the GeoJSON, the CSV and the report at
                      full length. */}
                  <div className="text-lead text-ink tnum mt-0.5">
                    {typed
                      ? `${point.lat}, ${point.lng}`
                      : `${point.lat.toFixed(3)}, ${point.lng.toFixed(3)}`}
                  </div>
                  <div className="text-2xs text-ink3 mt-0.5">
                    {typed ? t("map.pinTypedExact") : t("map.pinPrecision")}
                  </div>
                </>
              ) : (
                <div className="text-2xs text-ink3 mt-0.5">{t("map.clickCentre")}</div>
              )}
            </>
          ) : (
            <div className="text-sm text-ink2">{t("pin.barOrphan")}</div>
          )}
        </div>

        {item && (
          /* The typed escape hatch, beside the figure it replaces rather than
             in another corner: a coordinate read off a GPS or pasted from a
             colleague's message is as legitimate an answer as a click, and it
             is the only answer available when the place is off-screen. */
          <div className="shrink-0">
            <div className="flex items-center gap-1.5">
              <input
                value={text}
                onChange={(e) => { setText(e.target.value); setBad(false); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyTyped(); } }}
                placeholder="43.650, 51.180"
                aria-label={t("map.pinTypeLabel")}
                aria-invalid={bad || undefined}
                className={`w-[148px] h-7 bg-transparent border-b px-0 text-xs tnum placeholder:text-ink4 transition-colors ${
                  bad ? "border-bad" : "border-line focus:border-ink2"
                }`}
              />
              <Button onClick={applyTyped} disabled={!text.trim()}>
                {t("map.pinSet")}
              </Button>
            </div>
            {bad && <p className="text-2xs text-bad mt-1 max-w-[220px] leading-relaxed">{t("map.pinBad")}</p>}
          </div>
        )}

        <div className="flex items-center gap-1.5 shrink-0">
          {item && (
            <Button
              variant="primary"
              disabled={!point}
              onClick={() => {
                if (!point || !item) return;
                setAnchor(
                  item.id,
                  { lat: point.lat, lng: point.lng },
                  typed ? "typed" : "pinned",
                );
                claimPin(null);
                setPinMode(false);
                setPinPoints([]);
                resume(item.id);
              }}
            >
              {t("btn.confirm")}
            </Button>
          )}
          <Button variant="ghost" onClick={cancel}>
            {t("btn.cancel")}
          </Button>
        </div>
      </div>
    </div>
  );
}
