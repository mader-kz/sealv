/**
 * count.ts — what one sortie counted. Exactly one definition, product-wide.
 *
 * There used to be four: the left panel summed every detection (including the
 * ones a reviewer had rejected), the inspector summed them without the animals
 * the map could not place, the dashboard used the band, and the report used
 * the band with the unplaced added back. The same survey therefore printed as
 * four different numbers depending on which panel was open.
 *
 * The rule, once: the engine's own best estimate if it produced one — that is
 * the number the whole product exists to give — otherwise the animals that
 * survived review plus the ones counted but not georeferenced. A false
 * positive is not an animal and is in neither term.
 *
 * Structural input type so this module stays pure and importable from the PDF
 * builder (which runs outside React); a Footage satisfies it.
 */

export type CountableFootage = {
  band?: { best?: number | null } | null;
  detections?: { count: number; status: "auto" | "validated" | "false_positive" }[];
  /** Animals the engine counted but could not place on the map. */
  unplaced?: number | null;
};

export function countOf(f: CountableFootage): number {
  const best = f?.band?.best;
  if (typeof best === "number" && Number.isFinite(best)) return best;
  let n = 0;
  for (const d of f?.detections ?? []) {
    if (d.status === "false_positive") continue;
    if (Number.isFinite(d.count)) n += d.count;
  }
  const unplaced = f?.unplaced;
  return n + (typeof unplaced === "number" && Number.isFinite(unplaced) ? unplaced : 0);
}
