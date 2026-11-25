import { type Config, referencedTable, tableConfig } from "./config.js";
import { rowsReturned } from "./content-range.js";
import type { FindingKind, NamedTenantFinding } from "./findings.js";
import type { ReadLogEntry } from "./logs.js";
import type { Lookups } from "./lookups.js";
import { redactSearch } from "./redact.js";
import { parsePinningFilters } from "./search.js";

const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;

/**
 * What a filter column's values are: tenant ids themselves, ids of rows in a
 * configured table, or nothing the config knows about (null).
 */
export type FilterTarget = { kind: "tenant" } | { kind: "row"; table: string };

export function lookupTableFor(
  config: Config,
  table: string,
  column: string,
): FilterTarget | null {
  const t = tableConfig(config, table);
  if (!t) return null;
  if (column === t.tenantColumn) return { kind: "tenant" };
  if (column === (t.idColumn ?? "id")) return { kind: "row", table };
  const referenced = referencedTable(t, column);
  return referenced ? { kind: "row", table: referenced } : null;
}

type Resolved = {
  column: string;
  /** Tenant per filter value; undefined when the id was not found. */
  tenants: Array<string | undefined>;
};

/**
 * Check 1: a read whose filter names a tenant the caller does not belong to.
 *
 * - `crossed` — rows came back, and some filter pinned the result to other
 *   tenants only. Every returned row matched that filter, so every returned
 *   row belongs to a tenant the caller is not in.
 * - `unconfirmed` — rows came back and another tenant was named, but the same
 *   filter also named the caller's own tenant, the row count is unknown, or
 *   the caller has no membership rows at all.
 * - `attempt` — another tenant was named and nothing came back.
 */
export function evaluateNamedTenant(
  entry: ReadLogEntry,
  config: Config,
  lookups: Lookups,
): NamedTenantFinding | null {
  const resolved: Resolved[] = [];
  for (const filter of parsePinningFilters(entry.search)) {
    const target = lookupTableFor(config, entry.table, filter.column);
    if (target === null) continue;
    resolved.push({
      column: filter.column,
      tenants: filter.values.map((value) =>
        target.kind === "tenant"
          ? lookups.canonicalTenant(value)
          : lookups.rowTenant(target.table, value),
      ),
    });
  }
  if (resolved.length === 0) return null;

  const mine = lookups.membershipsOf(entry.userId);
  const isForeign = (tenant: string | undefined): tenant is string =>
    tenant !== undefined && !mine.has(tenant);

  const foreign = new Set<string>();
  for (const r of resolved)
    for (const t of r.tenants) if (isForeign(t)) foreign.add(t);
  if (foreign.size === 0) return null;

  // Filters on different columns are ANDed, and an `in` list is ORed. So a
  // returned row is provably foreign only if one filter's every value is.
  const pinnedToForeign = resolved.some(
    (r) => r.tenants.length > 0 && r.tenants.every(isForeign),
  );
  const rows = rowsReturned(entry.contentRange);
  const ok = entry.status >= HTTP_OK_MIN && entry.status <= HTTP_OK_MAX;

  let kind: FindingKind;
  if (!ok || rows === 0) kind = "attempt";
  else if (rows !== null && pinnedToForeign && mine.size > 0) kind = "crossed";
  else kind = "unconfirmed";

  return {
    check: "named-tenant",
    kind,
    timestamp: entry.timestamp,
    logId: entry.id,
    userId: entry.userId,
    table: entry.table,
    status: entry.status,
    rows,
    foreignTenants: [...foreign].sort(),
    memberTenants: [...mine].sort(),
    search: redactSearch(entry.search, tableConfig(config, entry.table)),
  };
}
