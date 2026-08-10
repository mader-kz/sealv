"use client";

/* Data management deliberately begins with individual records. A global wipe
   in a browser that has no authentication boundary would turn a shared link
   into a catastrophic command. The existing retire → preview → permanent
   delete path is therefore surfaced here, with the same server-counted receipt
   used everywhere else, rather than duplicated or weakened. */
import { useMemo } from "react";
import { useFootageStore } from "@/store/useFootageStore";
import { Button, Stat } from "@/components/ui/primitives";
import { PurgeControl } from "@/components/layout/RightInspector";
import { useT } from "@/lib/i18n";
import { countOf } from "@/lib/analytics/count";
import { formatDate } from "@/lib/analytics/brush";
import { setMode } from "@/lib/modes";

export default function ManageMode() {
  const { t, lang } = useT();
  const footages = useFootageStore(s => s.footages);
  const select = useFootageStore(s => s.select);

  const summary = useMemo(() => ({
    live: footages.filter(f => !f.retiredAt).length,
    retired: footages.filter(f => !!f.retiredAt).length,
    points: footages.reduce((n, f) => n + Math.max(0, countOf(f)), 0),
  }), [footages]);

  const inspect = (id: string) => {
    select(id);
    setMode("archive");
  };

  return (
    <main className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
      <header className="max-w-5xl">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-page text-ink">{t("manage.title")}</h1>
            <p className="text-xs text-ink3 mt-1 leading-relaxed max-w-xl">{t("manage.lead")}</p>
          </div>
          <Button icon="list" onClick={() => setMode("archive")}>{t("manage.archive")}</Button>
        </div>

        <section className="grid grid-cols-3 gap-8 mt-8 pb-5 border-b border-line" aria-label={t("manage.title")}>
          <Stat value={summary.live} label={t("manage.live")} tone="accent" />
          <Stat value={summary.retired} label={t("manage.retired")} />
          <Stat value={summary.points} label={t("manage.points")} />
        </section>
      </header>

      <section className="max-w-5xl mt-6" aria-labelledby="manage-records">
        <h2 id="manage-records" className="hd mb-2">{t("manage.records")}</h2>
        {!footages.length ? (
          <p className="text-sm text-ink3 py-8 border-t border-hair">{t("manage.empty")}</p>
        ) : (
          <div className="border-t border-line">
            {footages.map(f => (
              <article key={f.id} className="py-3 border-b border-hair flex gap-5 items-start">
                <div className="min-w-0 flex-1">
                  <button onClick={() => inspect(f.id)} className="text-sm text-ink text-left truncate max-w-full hover:text-accent transition-colors" title={f.filename || f.siteName || f.id}>
                    {f.filename || f.siteName || f.id}
                  </button>
                  <div className="flex flex-wrap gap-x-2 gap-y-1 mt-1 text-2xs text-ink3">
                    <span className="tnum">{countOf(f)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatDate(f.capturedAt ?? f.uploadedAt, lang)}</span>
                    {f.retiredAt && <><span aria-hidden="true">·</span><span className="text-bad">{t("manage.retired")}</span></>}
                  </div>
                </div>
                <div className="shrink-0 w-[255px] text-right">
                  <Button onClick={() => inspect(f.id)}>{t("manage.inspect")}</Button>
                  {f.retiredAt ? <PurgeControl f={f} /> : <p className="mt-1.5 text-2xs text-ink3 leading-relaxed">{t("manage.withdrawFirst")}</p>}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
