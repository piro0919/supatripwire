import type pg from "pg";
import { type Config, tableConfig } from "./config.js";

/**
 * Which rows of a table the read-only role can see, as far as Postgres's
 * catalog says.
 *
 * - `all` — RLS is off, the role owns the table or bypasses RLS, or a
 *   permissive `using (true)` policy applies and no restrictive one narrows it.
 * - `none` — RLS is on and no permissive SELECT policy applies to the role.
 * - `partial` — policies apply, but none of them is plainly `true`, or a
 *   restrictive one narrows them. The role may see only some rows.
 * - `missing` — the table does not resolve (wrong name or no USAGE on its schema).
 */
export type Visibility = "all" | "none" | "partial" | "missing";

export type TableAccess = {
  table: string;
  visibility: Visibility;
  /** Columns the checks select that do not exist on the table. */
  missingColumns: string[];
  /** Columns that exist but the role may not SELECT. */
  unreadableColumns: string[];
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
 * catalog tables are read, never the tables' rows.
 */
export async function inspectAccess(
  db: Queryable,
  config: Config,
): Promise<TableAccess[]> {
  const result: TableAccess[] = [];
  for (const { table, columns } of tablesToInspect(config)) {
    result.push(await inspectTable(db, table, columns));
  }
  return result;
}

async function inspectTable(
  db: Queryable,
  table: string,
  columns: string[],
): Promise<TableAccess> {
  const name = quoteIdent(table);
  const rel = await db.query<{
    rls: boolean;
    force: boolean;
    owner: boolean;
    bypass: boolean;
  }>(
    `select c.relrowsecurity as rls, c.relforcerowsecurity as force,
            pg_has_role(c.relowner, 'MEMBER') as owner,
            coalesce((select rolbypassrls from pg_roles where rolname = current_user), false) as bypass
       from pg_class c
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
  const missingColumns = columns.filter((c) => !found.has(c));
  const unreadableColumns = columns.filter((c) => found.get(c) === false);

  let visibility: Visibility;
  if (!r.rls || r.bypass || (r.owner && !r.force)) {
    visibility = "all";
  } else {
    // Policies for SELECT (or ALL) that apply to this role: to PUBLIC (oid 0)
    // or to any role it is a member of.
    const policies = await db.query<{
      permissive: boolean;
      qual: string | null;
    }>(
      `select p.polpermissive as permissive, pg_get_expr(p.polqual, p.polrelid) as qual
         from pg_policy p
        where p.polrelid = to_regclass($1)
          and p.polcmd in ('r', '*')
          and exists (
            select 1 from unnest(p.polroles) as pr(role)
             where pr.role = 0 or pg_has_role(current_user, pr.role, 'MEMBER'))`,
      [name],
    );
    const permissive = policies.rows.filter((p) => p.permissive);
    const narrowing = policies.rows.filter(
      (p) => !p.permissive && p.qual !== "true",
    );
    if (permissive.length === 0) visibility = "none";
    else if (
      narrowing.length === 0 &&
      permissive.some((p) => p.qual === "true")
    )
      visibility = "all";
    else visibility = "partial";
  }
  return { table, visibility, missingColumns, unreadableColumns };
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
