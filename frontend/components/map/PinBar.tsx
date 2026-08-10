"use client";
/**
 * PinBar — the pin flow's other half, on the screen where pinning happens.
 *
 * Splitting the app into modes broke this flow in a way no single component
 * could see: the card that asks for a location lives on Загрузка, the map you
 * pin on lives on Карта, and the Confirm button was on the card. Walking to the
 * map to place the point therefore left the crosshair armed, the chips dimmed
 * and nothing on screen to finish or cancel with — a dead end you could only
 * leave by guessing that the answer was on another screen.
 *
 * So the decision travels with the crosshair: which file is waiting, where the
 * point currently is, confirm, cancel. Escape cancels, because a mode you
 * cannot leave with Escape is a trap.
 *
 * It never invents state. `pinTarget` and the queue item are the store's; the
 * confirm writes exactly what the card's confirm wrote (anchor + provenance,
 * then resume). If no item owns the pin — the file was dismissed while the
 * operator was looking at the map — the bar says so and offers only the way
 * out, instead of leaving a crosshair over a map nobody armed.
 */
import { useEffect } from "react";
import { useFootageStore } from "@/store/useFootageStore";
import { useIngestStore } from "@/store/useIngestStore";
import { Button } from "@/components/ui/primitives";
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

  const item = items.find((i) => i.id === pinTarget) ?? null;
  const point = pinPoints.length ? pinPoints[0] : null;

  const cancel = () => {
    claimPin(null);
    setPinMode(false);
    setPinPoints([]);
  };

  /* Escape is the universal way out of a modal state, and this one is modal in
     every way that matters: the cursor changes, the chips step back and clicks
     mean something else. Bound while the bar is up, released with it. */
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

  return (
    <div className="absolute left-1/2 -translate-x-1/2 bottom-5 z-30 plate px-3 py-2.5 flex items-center gap-3 max-w-[min(560px,92vw)]">
      <div className="min-w-0">
        {item ? (
          <>
            <div className="text-sm text-ink truncate">{item.fileName}</div>
            <div className="text-2xs text-ink3 mt-0.5">
              {point
                ? t("pin.barPlaced", { lat: point.lat.toFixed(3), lng: point.lng.toFixed(3) })
                : t("pin.barAsk")}
            </div>
          </>
        ) : (
          /* The crosshair outlived its file. Say that plainly rather than
             leaving the operator to wonder what they are pointing at. */
          <div className="text-sm text-ink2">{t("pin.barOrphan")}</div>
        )}
      </div>
      <div className="flex items-center gap-1.5 ml-auto shrink-0">
        {item && (
          <Button
            variant="primary"
            disabled={!point}
            onClick={() => {
              if (!point || !item) return;
              setAnchor(
                item.id,
                { lat: point.lat, lng: point.lng },
                pinEntry === "typed" ? "typed" : "pinned",
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
  );
}
