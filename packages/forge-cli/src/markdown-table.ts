/**
 * Shared markdown pipe-table row parsing, used by both `new.ts` (the
 * archetype catalog) and `register.ts` (the per-repo factory table) — both
 * read pipe tables out of `toon-meta/FACTORY.md`.
 */

/** Splits a `| a | b |` row into trimmed cells, or `undefined` if `line` isn't a table row. */
export function splitTableRowCells(
  line: string
): readonly string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return undefined;
  return trimmed
    .slice(1, trimmed.endsWith('|') ? -1 : undefined)
    .split('|')
    .map((cell) => cell.trim());
}
