/**
 * Number of top-level rows in a PostgREST response, from its Content-Range
 * header as logged in `response.headers.content_range`.
 *
 * - `0-4/*`, `0-4/120` — rows 0 to 4 were returned: 5 rows.
 * - `*\/*`, `*\/0`     — the range is empty: 0 rows.
 *
 * Returns `null` when the header is missing or unreadable, so the caller can
 * tell "no rows" from "don't know".
 */
export function rowsReturned(contentRange: string | undefined): number | null {
  if (!contentRange) return null;
  const range = contentRange.trim().split("/")[0];
  if (range === "*") return 0;
  const match = /^(\d+)-(\d+)$/.exec(range ?? "");
  if (!match) return null;
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (last < first) return null;
  return last - first + 1;
}
