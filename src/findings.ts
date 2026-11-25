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
  /**
   * `request.search` with values hidden (`***`) except ids on the table's
   * tenant, id and reference columns; see `redactSearch`. Findings end up in
   * CI logs, and other columns may hold names or emails.
   */
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
  /**
   * Signed-in GETs to `/rest/v1/` read from the logs. This is the whole
   * denominator: writes, anonymous reads, secret-key requests and anything not
   * in the logs are outside it.
   */
  readsScanned: number;
  /** Timestamp of the first and last read found, or null when there were none. */
  firstReadAt: string | null;
  lastReadAt: string | null;
  /**
   * Reads on configured tables that did not fail (4xx/5xx) and whose
   * `content_range` was missing or unreadable — a missing status counts as
   * not failed. Check 2 cannot judge them and check 1 cannot call them
   * crossed: they were scanned, not checked.
   */
  readsWithoutRowCount: number;
  /** Configured tables with such reads, with how many each had. */
  tablesWithoutRowCount: Map<string, number>;
  /** Reads on names the config's `ignore` lists. Not checked, by choice. */
  readsOnIgnoredTables: number;
  /** Ignored names with how many reads each had. */
  ignoredTables: Map<string, number>;
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
  /**
   * Tables where a member got rows back while the table holds none in their
   * tenants. Check 2 does not report those reads as `crossed`: it more often
   * means the read-only role cannot see the table's rows.
   */
  tablesWithEmptyCeiling: Set<string>;
};
