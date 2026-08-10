"use client";
/**
 * IngestMode — Загрузка, at full size.
 *
 * This used to be a 360 px panel floating over the map, and every card that
 * needed a person was squeezed into that column: a frame picker showing two
 * thumbnails at a time, a duplicate whose three buttons wrapped onto three
 * lines, survey metadata folded away behind a disclosure because there was
 * nowhere to put it. The panel is gone. The queue now gets a reading column,
 * the attention cards get room, and the survey details sit beside the queue
 * instead of under it.
 *
 * What this screen deliberately does NOT own:
 *
 *  · the drop. Files dropped anywhere in the window are caught by the shell,
 *    which switches here while the drag is still in the air — so by the time
 *    the button is released the real dropzone is under the cursor.
 *  · the way out. The shell watches the queue and walks back to Карта once it
 *    has settled. This screen states that it is about to happen (the line
 *    below) and nothing more: two owners of the same return is a race, and the
 *    one that lost would leave somebody stranded on a finished queue.
 */

import { useEffect, useRef, useState } from "react";
import Dropzone from "@/components/upload/Dropzone";
import { isRunning, isWaiting, useIngestStore } from "@/store/useIngestStore";
import { MODE_LABEL_KEY } from "@/lib/modes";
import { useT } from "@/lib/i18n";

/* If the shell has not taken this screen away within this long, it is not
   going to — say nothing rather than keep a promise on screen that nobody is
   keeping. (The shell's own interval is 1500 ms; this is its backstop.) */
const RETURN_CLAIM_MS = 4000;

export default function IngestMode() {
  const { t } = useT();
  const items = useIngestStore((s) => s.items);

  /* The same reading of the queue the shell uses to decide it is done — armed
     only by a queue THIS screen watched go busy, so opening Загрузка to look
     at a finished list does not announce a return that will never come. It is
     a read, not a second timer: nothing here switches modes. */
  const [returning, setReturning] = useState(false);
  const armed = useRef(false);
  useEffect(() => {
    const busy = items.some((i) => isRunning(i.phase) || i.phase === "queued");
    const wantsYou = items.some((i) => isWaiting(i.phase) || i.phase === "failed");
    if (busy || wantsYou) {
      armed.current = true;
      setReturning(false);
      return;
    }
    if (!armed.current || !items.some((i) => i.phase === "done")) {
      setReturning(false);
      return;
    }
    setReturning(true);
    const timer = window.setTimeout(() => setReturning(false), RETURN_CLAIM_MS);
    return () => window.clearTimeout(timer);
  }, [items]);

  return (
    /* The mode owns its whole region, its own scrolling included. One column
       of content, centred, with the queue as the wide half — a queue that runs
       the full width of a 27" display is a line of text 200 characters long. */
    <div className="flex-1 min-h-0 overflow-y-auto">
      {/* 944 = the 640 px queue column + the 40 px gutter + the 264 px survey
          column, exactly. A wider wrapper would leave the two columns floating
          apart inside a box neither of them reaches the edge of. */}
      <div className="mx-auto w-full max-w-[944px] px-6 pt-5 pb-16">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 className="text-[22px] font-semibold tracking-[-0.028em] text-ink">
            {t(MODE_LABEL_KEY.ingest)}
          </h1>
          <p className="text-xs text-ink3 min-w-0">{t("ingest.pageSub")}</p>
        </div>

        {/* No countdown. The wait is a second and a half; a ticking number on
            it would be a widget measuring nothing. */}
        {returning && <div className="mt-3.5 text-xs text-ink3">{t("ingest.returning")}</div>}

        <div className="mt-4">
          <Dropzone />
        </div>
      </div>
    </div>
  );
}
