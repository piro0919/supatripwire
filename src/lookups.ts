import { lookupTableFor } from "./check-named-tenant.js";
import { type Config, tableConfig } from "./config.js";
import { visibleAtLeast } from "./content-range.js";
import type { TenantDirectory } from "./directory.js";
import type { ReadLogEntry } from "./logs.js";
import { parsePinningFilters } from "./search.js";

/**
 * Everything the checks read from the database, cached for the whole run.
 *
 * `prefetch` loads what a batch of log entries needs in a handful of queries;
 * the getters then answer synchronously. Asking for something that was not
 * prefetched is a bug, and throws rather than guessing.
 */
export class Lookups {
  private readonly memberships = new Map<string, Set<string>>();
  /** table → id → tenant (null when the row was not found). */
  private readonly rowTenants = new Map<string, Map<string, string | null>>();
  /** Tenant id as the log spelled it → as the database spells it. */
  private readonly tenantIds = new Map<string, string>();
  /** table → tenant → rows. */
  private readonly counts = new Map<string, Map<string, number>>();

  constructor(
    private readonly config: Config,
    private readonly directory: TenantDirectory,
  ) {}

  membershipsOf(userId: string): Set<string> {
    const tenants = this.memberships.get(userId);
    if (!tenants) throw new Error(`memberships of ${userId} not prefetched`);
    return tenants;
  }

  canonicalTenant(spelling: string): string {
    return this.tenantIds.get(spelling) ?? spelling;
  }

  rowTenant(table: string, id: string): string | undefined {
    return this.rowTenants.get(table)?.get(id) ?? undefined;
  }

  rowCount(table: string, tenant: string): number {
    const n = this.counts.get(table)?.get(tenant);
    if (n === undefined) {
      throw new Error(`row count of ${table} for ${tenant} not prefetched`);
    }
    return n;
  }

  async prefetch(batch: ReadLogEntry[]): Promise<void> {
    const users = new Set<string>();
    const spellings = new Set<string>();
    const ids = new Map<string, Set<string>>();
    const counted: ReadLogEntry[] = [];

    for (const entry of batch) {
      let needsMembership = false;
      for (const filter of parsePinningFilters(entry.search)) {
        const target = lookupTableFor(this.config, entry.table, filter.column);
        if (target === null) continue;
        needsMembership = true;
        for (const value of filter.values) {
          if (target.kind === "tenant") {
            if (!this.tenantIds.has(value)) spellings.add(value);
          } else if (!this.rowTenants.get(target.table)?.has(value)) {
            getOrCreate(ids, target.table, () => new Set()).add(value);
          }
        }
      }
      if (
        tableConfig(this.config, entry.table)?.rowCeiling !== false &&
        (visibleAtLeast(entry.contentRange) ?? 0) > 0
      ) {
        needsMembership = true;
        counted.push(entry);
      }
      if (needsMembership && !this.memberships.has(entry.userId)) {
        users.add(entry.userId);
      }
    }

    if (users.size > 0) {
      const found = await this.directory.membershipsOf([...users]);
      for (const user of users) {
        this.memberships.set(user, found.get(user) ?? new Set());
      }
    }
    if (spellings.size > 0) {
      const canonical = await this.directory.canonicalTenantIds([...spellings]);
      for (const value of spellings) {
        this.tenantIds.set(value, canonical.get(value) ?? value);
      }
    }
    for (const [table, wanted] of ids) {
      const found = await this.directory.tenantsOfRows(table, [...wanted]);
      const cache = getOrCreate(this.rowTenants, table, () => new Map());
      for (const id of wanted) cache.set(id, found.get(id) ?? null);
    }

    // Row counts depend on memberships, so they come second.
    const toCount = new Map<string, Set<string>>();
    for (const entry of counted) {
      const known = this.counts.get(entry.table);
      for (const tenant of this.membershipsOf(entry.userId)) {
        if (!known?.has(tenant)) {
          getOrCreate(toCount, entry.table, () => new Set()).add(tenant);
        }
      }
    }
    for (const [table, tenants] of toCount) {
      const found = await this.directory.rowCounts(table, [...tenants]);
      const cache = getOrCreate(this.counts, table, () => new Map());
      for (const tenant of tenants) cache.set(tenant, found.get(tenant) ?? 0);
    }
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
