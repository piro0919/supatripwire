/**
 * - `crossed` — rows from another tenant reached the caller. Certain, given
 *   the config and the database as they are when the check runs.
 * - `unconfirmed` — something points at another tenant, but the evidence
 *   does not prove rows crossed.
 * - `attempt` — another tenant was named and nothing came back: RLS (or an
 *   error) stopped it.
 */
export type FindingKind = "crossed" | "unconfirmed" | "attempt";

type FindingBase = {
  kind: FindingKind;
  timestamp: string;
  logId: string;
  userId: string;
  table: string;
  status: number;
  /** Rows returned, or null when `content_range` was missing or unreadable. */
  rows: number | null;
  /** Tenants the user belongs to, as the database says now. */
  memberTenants: string[];
  search: string;
};

/** Check 1: the filter named a tenant the caller does not belong to. */
export type NamedTenantFinding = FindingBase & {
  check: "named-tenant";
  /** Tenants named by the request that the user does not belong to. */
  foreignTenants: string[];
};

/** Check 2: the caller saw more rows than their tenants hold. */
export type RowCeilingFinding = FindingBase & {
  check: "row-ceiling";
  /** The fewest rows the caller's query could see, from the returned range. */
  visibleAtLeast: number;
  /** Rows of the table inside the caller's tenants, counted now. */
  ceiling: number;
};

export type Finding = NamedTenantFinding | RowCeilingFinding;

export type CheckSummary = {
  findings: Finding[];
  /** Signed-in GETs read from the logs. */
  readsScanned: number;
  /** Reads on a table the config does not list. */
  readsOnUnmappedTables: number;
  /** Unmapped table names with how many reads each had. */
  unmappedTables: Map<string, number>;
  /**
   * Users who appear in a finding but have no membership rows at all. Their
   * findings are never `crossed`: an empty result more often means the
   * membership mapping or the role's access is wrong than that the user is
   * in no tenant.
   */
  usersWithoutMembership: Set<string>;
};
