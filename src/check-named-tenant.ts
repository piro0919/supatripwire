import type { Config } from "./config.js";
import { rowsReturned } from "./content-range.js";
import type { TenantDirectory } from "./directory.js";
import type { ReadLogEntry } from "./logs.js";
import { parsePinningFilters } from "./search.js";

/**
 * - `crossed` — rows came back, and some filter pinned the result to other
 *   tenants only. Every returned row matched that filter, so every returned
 *   row belongs to a tenant the caller is not in. Certain.
 * - `unconfirmed` — rows came back and another tenant was named, but the same
 *   filter also named the caller's own tenant, the row count is unknown, or
 *   the caller has no membership rows at all. None of these alone proves a
 *   leak.
 * - `attempt` — another tenant was named and nothing came back: RLS (or an
 *   error) stopped it.
 */
export type FindingKind = "crossed" | "unconfirmed" | "attempt";

export type NamedTenantFinding = {
  kind: FindingKind;
  timestamp: string;
  logId: string;
  userId: string;
  table: string;
  status: number;
  /** Rows returned, or null when `content_range` was missing or unreadable. */
  rows: number | null;
  /** Tenants named by the request that the user does not belong to. */
  foreignTenants: string[];
  /** Tenants the user belongs to, as the database says now. */
  memberTenants: string[];
  search: string;
};

export type NamedTenantSummary = {
  findings: NamedTenantFinding[];
  /** Signed-in GETs read from the logs. */
  readsScanned: number;
  /** Reads on a table the config does not list. */
  readsOnUnmappedTables: number;
  /** Unmapped table names with how many reads each had. */
  unmappedTables: Map<string, number>;
  /**
   * Users who named a tenant but have no membership rows at all. Their findings
   * are never `crossed`: an empty result more often means the membership
   * mapping or the role's access is wrong than that the user is in no tenant.
   */
  usersWithoutMembership: Set<string>;
};

const DEFAULT_BATCH_SIZE = 500;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;

type Resolved = {
  column: string;
  /** Tenant per filter value; undefined when the id was not found. */
  tenants: Array<string | undefined>;
};

/**
 * Check 1: a read whose filter names a tenant the caller does not belong to.
 *
 * Entries are processed in batches so membership and id lookups are grouped
 * into a few queries; results are cached for the whole run.
 */
export async function checkNamedTenant(
  entries: AsyncIterable<ReadLogEntry> | Iterable<ReadLogEntry>,
  config: Config,
  directory: TenantDirectory,
  options: { batchSize?: number } = {},
): Promise<NamedTenantSummary> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const memberships = new Map<string, Set<string>>();
  /** `table` → id → tenant (null when not found). */
  const rowTenants = new Map<string, Map<string, string | null>>();
  const summary: NamedTenantSummary = {
    findings: [],
    readsScanned: 0,
    readsOnUnmappedTables: 0,
    unmappedTables: new Map(),
    usersWithoutMembership: new Set(),
  };
  /** Tenant id as the log spelled it → as the database spells it. */
  const tenantIds = new Map<string, string>();

  let batch: ReadLogEntry[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    await prefetch(
      batch,
      config,
      directory,
      memberships,
      rowTenants,
      tenantIds,
    );
    for (const entry of batch) {
      const finding = evaluate(
        entry,
        config,
        memberships,
        rowTenants,
        tenantIds,
      );
      if (!finding) continue;
      summary.findings.push(finding);
      if (finding.memberTenants.length === 0) {
        summary.usersWithoutMembership.add(finding.userId);
      }
    }
    batch = [];
  };

  for await (const entry of entries) {
    summary.readsScanned++;
    if (!config.tables[entry.table]) {
      summary.readsOnUnmappedTables++;
      summary.unmappedTables.set(
        entry.table,
        (summary.unmappedTables.get(entry.table) ?? 0) + 1,
      );
      continue;
    }
    batch.push(entry);
    if (batch.length >= batchSize) await flush();
  }
  await flush();
  return summary;
}

/**
 * What a filter column's values are: tenant ids themselves, ids of rows in a
 * configured table, or nothing the config knows about (null).
 */
type FilterTarget = { kind: "tenant" } | { kind: "row"; table: string };

function lookupTableFor(
  config: Config,
  table: string,
  column: string,
): FilterTarget | null {
  const t = config.tables[table];
  if (!t) return null;
  if (column === t.tenantColumn) return { kind: "tenant" };
  if (column === (t.idColumn ?? "id")) return { kind: "row", table };
  const referenced = t.references?.[column];
  return referenced ? { kind: "row", table: referenced } : null;
}

async function prefetch(
  batch: ReadLogEntry[],
  config: Config,
  directory: TenantDirectory,
  memberships: Map<string, Set<string>>,
  rowTenants: Map<string, Map<string, string | null>>,
  tenantIds: Map<string, string>,
): Promise<void> {
  const wanted = new Map<string, Set<string>>();
  const users = new Set<string>();
  const tenantSpellings = new Set<string>();
  for (const entry of batch) {
    let namesSomething = false;
    for (const filter of parsePinningFilters(entry.search)) {
      const target = lookupTableFor(config, entry.table, filter.column);
      if (target === null) continue;
      namesSomething = true;
      if (target.kind === "tenant") {
        for (const value of filter.values) {
          if (!tenantIds.has(value)) tenantSpellings.add(value);
        }
        continue;
      }
      const known = rowTenants.get(target.table);
      const set = getOrCreate(wanted, target.table, () => new Set<string>());
      for (const value of filter.values) {
        if (!known?.has(value)) set.add(value);
      }
    }
    if (namesSomething && !memberships.has(entry.userId))
      users.add(entry.userId);
  }

  if (users.size > 0) {
    for (const [user, tenants] of await directory.membershipsOf([...users])) {
      memberships.set(user, tenants);
    }
  }
  if (tenantSpellings.size > 0) {
    const canonical = await directory.canonicalTenantIds([...tenantSpellings]);
    for (const value of tenantSpellings) {
      tenantIds.set(value, canonical.get(value) ?? value);
    }
  }
  for (const [table, ids] of wanted) {
    if (ids.size === 0) continue;
    const found = await directory.tenantsOfRows(table, [...ids]);
    const cache = getOrCreate(rowTenants, table, () => new Map());
    for (const id of ids) cache.set(id, found.get(id) ?? null);
  }
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = create();
    map.set(key, value);
  }
  return value;
}

function evaluate(
  entry: ReadLogEntry,
  config: Config,
  memberships: Map<string, Set<string>>,
  rowTenants: Map<string, Map<string, string | null>>,
  tenantIds: Map<string, string>,
): NamedTenantFinding | null {
  const resolved: Resolved[] = [];
  for (const filter of parsePinningFilters(entry.search)) {
    const target = lookupTableFor(config, entry.table, filter.column);
    if (target === null) continue;
    resolved.push({
      column: filter.column,
      tenants: filter.values.map((value) =>
        target.kind === "tenant"
          ? (tenantIds.get(value) ?? value)
          : (rowTenants.get(target.table)?.get(value) ?? undefined),
      ),
    });
  }
  if (resolved.length === 0) return null;

  const mine = memberships.get(entry.userId) ?? new Set<string>();
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
    kind,
    timestamp: entry.timestamp,
    logId: entry.id,
    userId: entry.userId,
    table: entry.table,
    status: entry.status,
    rows,
    foreignTenants: [...foreign].sort(),
    memberTenants: [...mine].sort(),
    search: entry.search,
  };
}
