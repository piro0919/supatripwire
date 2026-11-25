import pg from "pg";
import type { Config } from "./config.js";

/**
 * The few id-to-tenant facts the checks need. Backed by the read-only role in
 * production and by plain maps in tests.
 */
export type TenantDirectory = {
  /** Tenant ids each user belongs to. Users with no membership map to an empty set. */
  membershipsOf(userIds: string[]): Promise<Map<string, Set<string>>>;
  /** Tenant id of each row of `table` found by primary key. Missing rows are left out. */
  tenantsOfRows(table: string, ids: string[]): Promise<Map<string, string>>;
  /**
   * Tenant ids as the log spelled them → as the membership table's tenant
   * column prints them (`3F2A…` → `3f2a…` for uuid, `007` → `7` for integers).
   * Values that do not parse are left out.
   */
  canonicalTenantIds(values: string[]): Promise<Map<string, string>>;
  /**
   * Rows of `table` in each of `tenants` (canonical ids from membership).
   * Tenants with no rows map to 0.
   */
  rowCounts(table: string, tenants: string[]): Promise<Map<string, number>>;
  close(): Promise<void>;
};

/**
 * Reads membership and row tenants through a connection string for a read-only
 * role. Only the id and tenant columns named in the config are selected, so the
 * role needs no more than column-level SELECT on them.
 */
export function createPgDirectory(
  connectionString: string,
  config: Config,
): TenantDirectory {
  const pool = new pg.Pool({ connectionString, max: 2 });
  const columnTypes = new Map<string, Promise<string | null>>();

  async function columnType(
    table: string,
    column: string,
  ): Promise<string | null> {
    const key = `${table}.${column}`;
    let pending = columnTypes.get(key);
    if (!pending) {
      pending = pool
        .query<{ type: string }>(
          `select format_type(a.atttypid, a.atttypmod) as type
             from pg_attribute a
            where a.attrelid = to_regclass($1) and a.attname = $2 and not a.attisdropped`,
          [quoteIdent(table), column],
        )
        .then((r) => r.rows[0]?.type ?? null);
      columnTypes.set(key, pending);
    }
    return pending;
  }

  /**
   * Looks up `valueColumn` for each input in `values`, matched on `column`.
   * Each row comes back keyed by the input string as the log spelled it.
   *
   * Comparing in the column's own type keeps its index usable. If an input
   * does not parse as that type (someone filtered `id=eq.abc` on a uuid
   * column), the batch falls back to comparing as text.
   */
  async function lookup(
    table: string,
    column: string,
    valueColumn: string,
    values: string[],
  ): Promise<Array<{ k: string; v: string | null }>> {
    const t = quoteIdent(table);
    const c = quoteIdent(column);
    const vc = quoteIdent(valueColumn);
    const type = await columnType(table, column);
    if (type) {
      try {
        const r = await pool.query<{ k: string; v: string | null }>(
          `select u.input as k, t.${vc}::text as v
             from unnest($1::text[]) as u(input)
             join ${t} as t on t.${c} = u.input::${type}`,
          [values],
        );
        return r.rows;
      } catch (error) {
        if (!isParseError(error)) throw error;
      }
    }
    const r = await pool.query<{ k: string; v: string | null }>(
      `select u.input as k, t.${vc}::text as v
         from unnest($1::text[]) as u(input)
         join ${t} as t on t.${c}::text = u.input`,
      [values],
    );
    return r.rows;
  }

  return {
    async membershipsOf(userIds) {
      const result = new Map<string, Set<string>>(
        userIds.map((id) => [id, new Set<string>()]),
      );
      if (userIds.length === 0) return result;
      const { table, userColumn, tenantColumn } = config.membership;
      for (const row of await lookup(
        table,
        userColumn,
        tenantColumn,
        userIds,
      )) {
        if (row.v !== null) result.get(row.k)?.add(row.v);
      }
      return result;
    },

    async tenantsOfRows(table, ids) {
      const result = new Map<string, string>();
      const t = config.tables[table];
      if (!t || ids.length === 0) return result;
      const idColumn = t.idColumn ?? "id";
      for (const row of await lookup(table, idColumn, t.tenantColumn, ids)) {
        if (row.v !== null) result.set(row.k, row.v);
      }
      return result;
    },

    async canonicalTenantIds(values) {
      const result = new Map<string, string>();
      if (values.length === 0) return result;
      const { table, tenantColumn } = config.membership;
      const type = await columnType(table, tenantColumn);
      if (!type) return result;
      const canonicalize = async (batch: string[]) => {
        const r = await pool.query<{ k: string; v: string }>(
          `select u.input as k, (u.input::${type})::text as v
             from unnest($1::text[]) as u(input)`,
          [batch],
        );
        for (const row of r.rows) result.set(row.k, row.v);
      };
      try {
        await canonicalize(values);
      } catch (error) {
        if (!isParseError(error)) throw error;
        // One value does not parse; keep the others. Unparseable ones stay as
        // spelled, which can only make them foreign, never the caller's own.
        for (const value of values) {
          try {
            await canonicalize([value]);
          } catch (inner) {
            if (!isParseError(inner)) throw inner;
          }
        }
      }
      return result;
    },

    async rowCounts(table, tenants) {
      const result = new Map<string, number>(tenants.map((t) => [t, 0]));
      const t = config.tables[table];
      if (!t || tenants.length === 0) return result;
      const tq = quoteIdent(table);
      const c = quoteIdent(t.tenantColumn);
      // Grouped by the input spelling so the keys match the membership ids.
      const count = async (cast: string) =>
        pool.query<{ k: string; n: number }>(
          `select u.input as k, count(*)::int as n
             from unnest($1::text[]) as u(input)
             join ${tq} as r on ${cast}
            group by u.input`,
          [tenants],
        );
      const type = await columnType(table, t.tenantColumn);
      let rows: Array<{ k: string; n: number }> | null = null;
      if (type) {
        try {
          rows = (await count(`r.${c} = u.input::${type}`)).rows;
        } catch (error) {
          if (!isParseError(error)) throw error;
        }
      }
      rows ??= (await count(`r.${c}::text = u.input`)).rows;
      for (const row of rows) result.set(row.k, row.n);
      return result;
    },

    async close() {
      await pool.end();
    },
  };
}

/** 22P02 invalid_text_representation, 22003 numeric_value_out_of_range. */
function isParseError(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === "22P02" || code === "22003";
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
