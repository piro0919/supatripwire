import pg from "pg";
import { inspectAccess, type TableAccess } from "./access.js";
import {
  type Config,
  type TenantSource,
  tableConfig,
  tenantSource,
} from "./config.js";

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
  /**
   * What the role can see of each table the checks read, from the catalog.
   * Optional so test directories can leave it out; then every table counts as
   * fully visible.
   */
  inspectAccess?(): Promise<TableAccess[]>;
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
   * Runs `query` comparing in the column's own type, which keeps its index
   * usable. If some input does not parse as that type (someone filtered
   * `id=eq.abc` on a uuid column), only the inputs that fail are compared as
   * text. The rest stay typed, so one bad value cannot make the others miss:
   * `3F2A…` matches a uuid column when typed, but not as text.
   */
  async function typedOrText<R extends pg.QueryResultRow>(
    type: string | null,
    values: string[],
    query: (cast: string | null, batch: string[]) => Promise<R[]>,
  ): Promise<R[]> {
    if (!type) return query(null, values);
    try {
      return await query(type, values);
    } catch (error) {
      if (!isParseError(error)) throw error;
    }
    const rows: R[] = [];
    const asText: string[] = [];
    for (const value of values) {
      try {
        rows.push(...(await query(type, [value])));
      } catch (error) {
        if (!isParseError(error)) throw error;
        asText.push(value);
      }
    }
    if (asText.length > 0) rows.push(...(await query(null, asText)));
    return rows;
  }

  /**
   * Looks up `valueColumn` for each input in `values`, matched on `column`.
   * Each row comes back keyed by the input string as the log spelled it.
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
    return typedOrText(type, values, async (cast, batch) => {
      const on = cast ? `t.${c} = u.input::${cast}` : `t.${c}::text = u.input`;
      const r = await pool.query<{ k: string; v: string | null }>(
        `select u.input as k, t.${vc}::text as v
           from unnest($1::text[]) as u(input)
           join ${t} as t on ${on}`,
        [batch],
      );
      return r.rows;
    });
  }

  /**
   * Like `lookup`, for a tenantVia table: matches `values` on its `column`,
   * then follows the chain and reads the tenant from the last row.
   */
  async function lookupVia(
    table: string,
    column: string,
    source: TenantSource,
    values: string[],
  ): Promise<Array<{ k: string; v: string | null }>> {
    const c = quoteIdent(column);
    const type = await columnType(table, column);
    const conds = await hopConditions(source);
    // From the table read outward: a0, then a1 … a<n>.
    const joins = source.hops.map(
      (hop, i) => `join ${quoteIdent(hop.to)} as a${i + 1} on ${conds[i]}`,
    );
    const last = `a${source.hops.length}`;
    return typedOrText(type, values, async (cast, batch) => {
      const on = cast
        ? `a0.${c} = u.input::${cast}`
        : `a0.${c}::text = u.input`;
      const r = await pool.query<{ k: string; v: string | null }>(
        `select u.input as k, ${last}.${quoteIdent(source.column)}::text as v
           from unnest($1::text[]) as u(input)
           join ${quoteIdent(table)} as a0 on ${on}
           ${joins.join("\n           ")}`,
        [batch],
      );
      return r.rows;
    });
  }

  /**
   * The join conditions along a tenantVia chain: `a0` is the table read,
   * `a<i+1>` the table hop `i` points at, and condition `i` links `a<i>` to
   * `a<i+1>`. Callers write the joins starting from the side their input
   * matches, as Postgres keeps the written order past `join_collapse_limit`.
   *
   * Compared as is when both columns have the same type, which keeps the
   * index usable; as text otherwise, so a `text` column holding uuids cannot
   * fail the run with "operator does not exist". The text comparison can miss
   * differently spelled values (upper-case uuids), which only leaves a row
   * out — never assigns it to a wrong tenant.
   */
  async function hopConditions(source: TenantSource): Promise<string[]> {
    return Promise.all(
      source.hops.map(async (hop, i) => {
        const [from, to] = await Promise.all([
          columnType(hop.from, hop.column),
          columnType(hop.to, hop.idColumn),
        ]);
        const fc = `a${i}.${quoteIdent(hop.column)}`;
        const tc = `a${i + 1}.${quoteIdent(hop.idColumn)}`;
        return from !== null && from === to
          ? `${tc} = ${fc}`
          : `${tc}::text = ${fc}::text`;
      }),
    );
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
      const t = tableConfig(config, table);
      const source = tenantSource(config, table);
      if (!t || !source || ids.length === 0) return result;
      const idColumn = t.idColumn ?? "id";
      const rows =
        source.hops.length > 0
          ? await lookupVia(table, idColumn, source, ids)
          : await lookup(table, idColumn, source.column, ids);
      for (const row of rows) {
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
      const source = tenantSource(config, table);
      if (!source || tenants.length === 0) return result;
      const c = quoteIdent(source.column);
      const type = await columnType(source.table, source.column);
      // For a tenantVia table, rows of the table read (`a0`) are counted
      // through the chain to the table holding the tenant (`a<n>`). Each hop
      // points at a primary key, so every `a0` row joins at most once.
      const n = source.hops.length;
      const last = `a${n}`;
      const conds = await hopConditions(source);
      // From the tenant inward: a<n>, then a<n-1> … a0.
      const joins = source.hops
        .map((hop, i) => `join ${quoteIdent(hop.from)} as a${i} on ${conds[i]}`)
        .reverse();
      // Grouped by the input spelling so the keys match the membership ids.
      // bigint comes back from pg as a string.
      const rows = await typedOrText(type, tenants, async (cast, batch) => {
        const on = cast
          ? `${last}.${c} = u.input::${cast}`
          : `${last}.${c}::text = u.input`;
        const r = await pool.query<{ k: string; n: string }>(
          `select u.input as k, count(*) as n
             from unnest($1::text[]) as u(input)
             join ${quoteIdent(source.table)} as ${last} on ${on}
             ${joins.join("\n             ")}
            group by u.input`,
          [batch],
        );
        return r.rows;
      });
      for (const row of rows) result.set(row.k, Number(row.n));
      return result;
    },

    inspectAccess() {
      return inspectAccess(pool, config);
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
