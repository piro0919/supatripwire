import { rowsReturned, visibleAtLeast } from "./content-range.js";
import type { RowCeilingFinding } from "./findings.js";
import type { ReadLogEntry } from "./logs.js";
import type { Lookups } from "./lookups.js";

/**
 * Check 2: the caller's query saw more rows than the table holds inside the
 * caller's tenants.
 *
 * Filters only ever narrow, so with correct RLS the rows a query can see never
 * exceed the rows in the caller's tenants. The returned range gives a floor on
 * what the query saw (`1000-1999/*` means at least 2000 rows), so a floor above
 * the ceiling proves rows from other tenants were visible — whatever the
 * filter said, and even with no filter at all.
 *
 * - `crossed` — the floor exceeds the ceiling.
 * - `unconfirmed` — the ceiling is 0: either the user has no membership rows,
 *   or the table holds no rows in their tenants. Both more often mean the
 *   mapping is wrong or the read-only role cannot see the rows (RLS on, no
 *   policy for the role) than that every returned row was foreign.
 */
export function evaluateRowCeiling(
  entry: ReadLogEntry,
  lookups: Lookups,
): RowCeilingFinding | null {
  const visible = visibleAtLeast(entry.contentRange);
  if (visible === null || visible === 0) return null;

  const mine = lookups.membershipsOf(entry.userId);
  const ceiling = [...mine].reduce(
    (sum, tenant) => sum + lookups.rowCount(entry.table, tenant),
    0,
  );
  if (visible <= ceiling) return null;

  return {
    check: "row-ceiling",
    kind: ceiling > 0 ? "crossed" : "unconfirmed",
    timestamp: entry.timestamp,
    logId: entry.id,
    userId: entry.userId,
    table: entry.table,
    status: entry.status,
    rows: rowsReturned(entry.contentRange),
    visibleAtLeast: visible,
    ceiling,
    memberTenants: [...mine].sort(),
    search: entry.search,
  };
}
