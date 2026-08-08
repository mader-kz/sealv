"use client";
/* The correction log — who changed this count, and when.
 *
 * The service has kept an append-only `edit` row for every verdict since the
 * first schema; nothing in the platform ever showed one. An audit trail that
 * cannot be read is not an audit trail, it is a table.
 *
 * Two deliberate renderings:
 *
 *  - a null operator prints as "not recorded", verbatim and in place. Until
 *    this release the client hardcoded operator:"platform" on every write, so
 *    the log's honest answer to "who did this" is "nobody wrote it down" for
 *    every historic row. Papering that over with the current user's name, or
 *    hiding the column, would launder a gap in the record into a record.
 *  - newest first, because the question is almost always "what just happened
 *    to this sortie".
 *
 * Loaded on demand: 1473 points can carry a long log, and no inspector should
 * fetch one nobody asked to see.
 */
import { useCallback, useEffect, useState } from "react";
import { fetchEdits, type EditRow } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { formatDate } from "@/lib/analytics/brush";
import type { Footage } from "@/lib/types";
import { SectionHead } from "@/components/ui/primitives";

/** An operator string that is really there. The column is nullable and an
 *  empty one is the same claim as a missing one: nobody wrote it down. */
const text = (v: string | null | undefined): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

export default function EditHistory({ f }: { f: Footage }) {
  const { t, lang } = useT();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<EditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const runId = f.runId ?? null;

  /* A different sortie has a different log. Dropping the old rows on the id
     change matters more than it looks: showing sortie A's corrections under
     sortie B's header is a false attribution, which is the exact failure this
     panel exists to prevent. */
  useEffect(() => {
    setRows(null);
    setError(null);
    setOpen(false);
  }, [runId]);

  const load = useCallback(async () => {
    if (!runId) return;
    setLoading(true);
    setError(null);
    try {
      const list = await fetchEdits(runId);
      /* Newest first. Ties keep the service's order, which is the insert
         order — two edits in the same second really did happen in that one. */
      setRows(
        list
          .map((r, i) => ({ r, i }))
          .sort((a, b) => {
            const at = Date.parse(text(a.r.created_at) ?? "");
            const bt = Date.parse(text(b.r.created_at) ?? "");
            const av = Number.isFinite(at) ? at : -Infinity;
            const bv = Number.isFinite(bt) ? bt : -Infinity;
            return bv - av || b.i - a.i;
          })
          .map((e) => e.r),
      );
    } catch (e) {
      setError(`${t("rec.edits.failed")}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [runId, t]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && rows === null && !loading) void load();
  };

  const opLabel = (op: string | null | undefined): string =>
    op === "remove" ? t("rec.edits.opRemove")
    : op === "reinstate" ? t("rec.edits.opReinstate")
    : op === "add" ? t("rec.edits.opAdd")
    /* An op this build does not know is printed as the service wrote it,
       rather than dropped or guessed at. */
    : (op ?? "—");

  return (
    <div className="px-4 py-3 border-b border-line">
      <SectionHead
        title={t("rec.edits.title")}
        className="mb-1.5"
        right={
          runId ? (
            <button
              onClick={toggle}
              aria-expanded={open}
              className="text-2xs text-ink3 hover:text-ink transition-colors"
            >
              {open ? t("rec.edits.hide") : t("rec.edits.show")}
            </button>
          ) : undefined
        }
      />
      {!runId ? (
        <p className="text-2xs text-ink3 leading-relaxed">{t("rec.edits.noRun")}</p>
      ) : open ? (
        loading ? (
          <p className="text-2xs text-ink3">{t("rec.edits.loading")}</p>
        ) : error ? (
          <p className="text-2xs text-bad leading-relaxed">{error}</p>
        ) : rows && rows.length ? (
          <div className="max-h-[180px] overflow-auto -mx-1 px-1">
            {rows.map((r, i) => {
              const pid = r.point_id;
              const who = text(r.operator);
              const when = text(r.created_at);
              return (
                <div
                  key={`${r.id}-${i}`}
                  className="flex items-baseline gap-2 py-1 border-b border-line-soft last:border-0"
                >
                  <span className="text-2xs text-ink2 w-[76px] shrink-0 truncate">
                    {opLabel(text(r.op))}
                  </span>
                  <span className="text-2xs text-ink3 tnum shrink-0">
                    {/* An edit with no point id is a whole-run correction the
                        service recorded without one; a dash says so rather
                        than printing "point null". */}
                    {pid != null && Number.isFinite(pid) ? t("rec.edits.point", { id: pid }) : "—"}
                  </span>
                  <span
                    className={`text-2xs flex-1 truncate ${who ? "text-ink2" : "text-ink3 italic"}`}
                    title={who ?? t("rec.edits.noOperator")}
                  >
                    {who ?? t("rec.edits.noOperator")}
                  </span>
                  <span className="text-2xs text-ink3 tnum shrink-0">
                    {when ? formatDate(when, lang) : "—"}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-2xs text-ink3">{t("rec.edits.empty")}</p>
        )
      ) : null}
    </div>
  );
}
