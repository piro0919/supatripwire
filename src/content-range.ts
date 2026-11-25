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
  const range = parseRange(contentRange);
  if (range === null) return null;
  return range === "empty" ? 0 : range.last - range.first + 1;
}

/**
 * The fewest rows the caller could see for this query, from the positions in
 * the Content-Range header: `1000-1999/*` means rows 1000 to 1999 of the
 * caller's result were returned, so that result has at least 2000 rows.
 *
 * The total after the slash is deliberately ignored. With `Prefer:
 * count=planned` or `count=estimated` it is a planner estimate, not a count
 * (https://docs.postgrest.org/en/stable/references/api/pagination_count.html),
 * and the log does not say which count was asked for.
 */
export function visibleAtLeast(
  contentRange: string | undefined,
): number | null {
  const range = parseRange(contentRange);
  if (range === null) return null;
  return range === "empty" ? 0 : range.last + 1;
}

function parseRange(
  contentRange: string | undefined,
): { first: number; last: number } | "empty" | null {
  if (!contentRange) return null;
  const range = contentRange.trim().split("/")[0];
  if (range === "*") return "empty";
  const match = /^(\d+)-(\d+)$/.exec(range ?? "");
  if (!match) return null;
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (last < first) return null;
  return { first, last };
}
