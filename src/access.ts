import type pg from "pg";
import { type Config, tableConfig } from "./config.js";

/**
 * Which rows of a table the read-only role can see, as far as Postgres's
 * catalog says.
 *
 * - `all` — RLS is off, the role is exempt (superuser, BYPASSRLS, or holding
 *   the owner's privileges without FORCE), or a permissive `using (true)`
 *   policy applies and no restrictive one narrows it.
 * - `none` — RLS is on and no permissive SELECT policy with a USING clause
 *   applies to the role.
 * - `partial` — policies apply, but none of them is plainly `true`, or a
 *   restrictive one narrows them. The role may see only some rows.
 * - `missing` — the table does not resolve (wrong name or no USAGE on its schema).
 * - `unknown` — the catalog could not be read.
 */
export type Visibility = "all" | "none" | "partial" | "missing" | "unknown";

/** Why a table counts as `all`. */
export type FullAccessReason =
  | "no-rls"
  | "superuser"
  | "bypassrls"
  | "owner"
  | "policy";

export type TableAccess = {
  table: string;
  visibility: Visibility;
  /** Set when `visibility` is `all`. */
  reason?: FullAccessReason;
  /** Columns the checks select that do not exist on the table. */
  missingColumns: string[];
  /** Columns that exist but the role may not SELECT. */
  unreadableColumns: string[];
  /** Set when `visibility` is `unknown`. */
  error?: string;
};

/** One wording for `check` and `doctor`. */
export const VISIBILITY_TEXT: Record<Visibility, string> = {
  all: "sees every row",
  none: "sees no rows: RLS is on and no SELECT policy applies to the role",
  partial:
    "may see only some rows: no plain `using (true)` policy for the role, or a restrictive policy narrows it",
  missing: "not found: wrong name, or the role has no USAGE on its schema",
  unknown: "unknown: the catalog could not be read",
};

type Queryable = Pick<pg.Pool, "query">;

/**
 * The membership table first, then every configured table, with the columns
 * the checks select from each.
 */
export function tablesToInspect(
  config: Config,
): Array<{ table: string; columns: string[] }> {
  const result = new Map<string, Set<string>>();
  const add = (table: string, columns: string[]) => {
    const set = result.get(table) ?? new Set<string>();
    for (const c of columns) set.add(c);
    result.set(table, set);
  };
  const m = config.membership;
  add(m.table, [m.userColumn, m.tenantColumn]);
  for (const name of Object.keys(config.tables)) {
    const t = tableConfig(config, name);
    if (t) add(name, [t.idColumn ?? "id", t.tenantColumn]);
  }
  return [...result].map(([table, columns]) => ({
    table,
    columns: [...columns],
  }));
}

/**
 * Reads what the connected role can see of each table from the catalog. Only
 * catalog tables are read, never the tables' rows. A table whose catalog
 * entries cannot be read comes back `unknown` instead of failing the run.
 */
export async function inspectAccess(
  db: Queryable,
  config: Config,
): Promise<TableAccess[]> {
  const result: TableAccess[] = [];
  for (const { table, columns } of tablesToInspect(config)) {
    try {
      result.push(await inspectTable(db, table, columns));
    } catch (error) {
      result.push({
        table,
        visibility: "unknown",
        missingColumns: [],
        unreadableColumns: [],
        error: (error as Error).message,
      });
    }
  }
  return result;
}

async function inspectTable(
  db: Queryable,
  table: string,
  columns: string[],
): Promise<TableAccess> {
  const name = quoteIdent(table);
  // RLS follows privileges, not bare membership: a NOINHERIT member of the
  // owner role is still filtered, so 'USAGE' rather than 'MEMBER'.
  const rel = await db.query<{
    rls: boolean;
    force: boolean;
    owner: boolean;
    superuser: boolean;
    bypass: boolean;
  }>(
    `select c.relrowsecurity as rls, c.relforcerowsecurity as force,
            pg_has_role(c.relowner, 'USAGE') as owner,
            coalesce(r.rolsuper, false) as superuser,
            coalesce(r.rolbypassrls, false) as bypass
       from pg_class c
       left join pg_roles r on r.rolname = current_user
      where c.oid = to_regclass($1)`,
    [name],
  );
  const r = rel.rows[0];
  if (!r) {
    return {
      table,
      visibility: "missing",
      missingColumns: [],
      unreadableColumns: [],
    };
  }

  const cols = await db.query<{ name: string; readable: boolean }>(
    `select a.attname as name,
            has_column_privilege(a.attrelid, a.attnum, 'SELECT') as readable
       from pg_attribute a
      where a.attrelid = to_regclass($1) and a.attname = any($2) and not a.attisdropped`,
    [name, columns],
  );
  const found = new Map(cols.rows.map((c) => [c.name, c.readable]));
  const base = {
    table,
    missingColumns: columns.filter((c) => !found.has(c)),
    unreadableColumns: columns.filter((c) => found.get(c) === false),
  };

  if (!r.rls) return { ...base, visibility: "all", reason: "no-rls" };
  if (r.superuser) return { ...base, visibility: "all", reason: "superuser" };
  if (r.bypass) return { ...base, visibility: "all", reason: "bypassrls" };
  if (r.owner && !r.force)
    return { ...base, visibility: "all", reason: "owner" };

  // Policies for SELECT (or ALL) that apply to this role: to PUBLIC (oid 0) or
  // to a role whose privileges it holds. A policy without USING (only WITH
  // CHECK) does not take part in reads.
  const policies = await db.query<{ permissive: boolean; qual: string }>(
    `select p.polpermissive as permissive, pg_get_expr(p.polqual, p.polrelid) as qual
       from pg_policy p
      where p.polrelid = to_regclass($1)
        and p.polcmd in ('r', '*')
        and p.polqual is not null
        and exists (
          select 1 from unnest(p.polroles) as pr(role)
           where pr.role = 0 or pg_has_role(current_user, pr.role, 'USAGE'))`,
    [name],
  );
  const permissive = policies.rows.filter((p) => p.permissive);
  const narrowing = policies.rows.filter(
    (p) => !p.permissive && p.qual !== "true",
  );
  if (permissive.length === 0) return { ...base, visibility: "none" };
  if (narrowing.length === 0 && permissive.some((p) => p.qual === "true"))
    return { ...base, visibility: "all", reason: "policy" };
  return { ...base, visibility: "partial" };
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
