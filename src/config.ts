import { readFile } from "node:fs/promises";

/**
 * A table with no tenant column of its own, whose rows belong to the tenant of
 * the row they reference: `{ "column": "post_id", "table": "posts" }`.
 */
export type TenantVia = {
  /** Column on this table holding the id of a row in `table`. */
  column: string;
  /** A configured table with its own `tenantColumn`. */
  table: string;
};

/** How a table relates to tenants: `tenantColumn` or `tenantVia`, never both. */
export type TableConfig = {
  /** Primary key column. Defaults to `id`. */
  idColumn?: string;
  /** Columns holding the id of a row in another configured table, e.g. `{ "resident_id": "residents" }`. */
  references?: Record<string, string>;
  /**
   * `false` turns check 2 off for this table — for a table whose RLS lets
   * every tenant read some rows (a null tenant), which the ceiling never
   * counts. Check 1 still runs. Absent means on.
   */
  rowCeiling?: boolean;
} & (
  | {
      /** Column holding the tenant id. On the tenants table itself, this is its primary key. */
      tenantColumn: string;
      tenantVia?: undefined;
    }
  | { tenantVia: TenantVia; tenantColumn?: undefined }
);

export type Config = {
  /** The 20-letter project ref. */
  projectRef: string;
  /** Where membership (user → tenants) lives. */
  membership: {
    table: string;
    userColumn: string;
    tenantColumn: string;
  };
  /** Tables exposed through PostgREST, keyed by the name in the request path. */
  tables: Record<string, TableConfig>;
  /**
   * Names in the request path that are deliberately not checked — tables every
   * tenant may read, or `rpc` for all functions. Reads on them are counted on
   * their own and are not a coverage gap.
   */
  ignore?: string[];
};

/**
 * The config for a name taken from a request path, or undefined. Only own
 * keys count, so `constructor` or `__proto__` never resolve to something
 * inherited — also for configs built by hand rather than by `parseConfig`.
 */
export function tableConfig(
  config: Config,
  name: string,
): TableConfig | undefined {
  return Object.hasOwn(config.tables, name) ? config.tables[name] : undefined;
}

/**
 * The table a referencing column points at, own keys only. The `tenantVia`
 * column counts as a reference too.
 */
export function referencedTable(
  table: TableConfig,
  column: string,
): string | undefined {
  if (table.tenantVia?.column === column) return table.tenantVia.table;
  const refs = table.references;
  return refs && Object.hasOwn(refs, column) ? refs[column] : undefined;
}

/** One step of a `tenantVia` chain: `from.column` holds the id of a row in `to`. */
export type TenantHop = {
  from: string;
  column: string;
  to: string;
  /** The primary key of `to`. */
  idColumn: string;
};

export type TenantSource = {
  /** The table holding the tenant column. */
  table: string;
  column: string;
  /**
   * For a tenantVia table, the joins from the table read to `table`, in that
   * order. Empty when the table holds its own tenant column.
   */
  hops: TenantHop[];
};

/**
 * Where the tenant of a configured table's rows is read: the table and
 * column holding it, and — for a `tenantVia` table — the chain of joins to
 * it. Undefined when the config is inconsistent (a hand-built one, as
 * `parseConfig` rejects these): a missing table or a chain that loops.
 */
export function tenantSource(
  config: Config,
  name: string,
): TenantSource | undefined {
  const hops: TenantHop[] = [];
  const seen = new Set<string>();
  let current = name;
  for (;;) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const t = tableConfig(config, current);
    if (!t) return undefined;
    if (t.tenantColumn !== undefined)
      return { table: current, column: t.tenantColumn, hops };
    const target = tableConfig(config, t.tenantVia.table);
    if (!target) return undefined;
    hops.push({
      from: current,
      column: t.tenantVia.column,
      to: t.tenantVia.table,
      idColumn: target.idColumn ?? "id",
    });
    current = t.tenantVia.table;
  }
}

/**
 * The tables whose rows decide a read of `table`: the table itself, then —
 * for a tenantVia table — every table its chain passes through. If the role
 * sees only some rows of any of them, ids resolve to nothing and the ceiling
 * comes out too low.
 */
export function tablesOnTenantPath(config: Config, table: string): string[] {
  const source = tenantSource(config, table);
  return source ? [table, ...source.hops.map((h) => h.to)] : [table];
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export async function loadConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigError(
      `Cannot read config file ${path}: ${(error as Error).message}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      `Config file ${path} is not valid JSON: ${(error as Error).message}`,
    );
  }
  return parseConfig(json);
}

export function parseConfig(json: unknown): Config {
  const root = object(json, "config");
  const projectRef = string(root.projectRef, "projectRef");
  if (!/^[a-z]{20}$/.test(projectRef)) {
    throw new ConfigError(
      "projectRef must be the 20 lowercase letters of the project ref",
    );
  }

  const m = object(root.membership, "membership");
  const membership = {
    table: identifier(m.table, "membership.table"),
    userColumn: identifier(m.userColumn, "membership.userColumn"),
    tenantColumn: identifier(m.tenantColumn, "membership.tenantColumn"),
  };

  const rawTables = object(root.tables, "tables");
  // Looked up by names taken from request paths, which anyone signed in can
  // choose. Without a prototype, `/rest/v1/constructor` finds nothing instead
  // of Object's own `constructor`.
  const tables: Record<string, TableConfig> = Object.create(null);
  for (const [name, value] of Object.entries(rawTables)) {
    identifier(name, `tables key "${name}"`);
    const t = object(value, `tables.${name}`);
    if (t.tenantColumn === undefined && t.tenantVia === undefined) {
      throw new ConfigError(
        `tables.${name} needs tenantColumn, or tenantVia for a table with no tenant column`,
      );
    }
    if (t.tenantColumn !== undefined && t.tenantVia !== undefined) {
      throw new ConfigError(
        `tables.${name} has both tenantColumn and tenantVia; use one`,
      );
    }
    let table: TableConfig;
    if (t.tenantColumn !== undefined) {
      table = {
        tenantColumn: identifier(t.tenantColumn, `tables.${name}.tenantColumn`),
      };
    } else {
      const via = object(t.tenantVia, `tables.${name}.tenantVia`);
      table = {
        tenantVia: {
          column: identifier(via.column, `tables.${name}.tenantVia.column`),
          table: string(via.table, `tables.${name}.tenantVia.table`),
        },
      };
    }
    if (t.idColumn !== undefined)
      table.idColumn = identifier(t.idColumn, `tables.${name}.idColumn`);
    if (t.rowCeiling !== undefined) {
      if (typeof t.rowCeiling !== "boolean") {
        throw new ConfigError(
          `tables.${name}.rowCeiling must be true or false`,
        );
      }
      if (t.rowCeiling === false) table.rowCeiling = false;
    }
    if (t.references !== undefined) {
      const refs = object(t.references, `tables.${name}.references`);
      table.references = Object.create(null) as Record<string, string>;
      for (const [column, target] of Object.entries(refs)) {
        identifier(column, `tables.${name}.references key "${column}"`);
        table.references[column] = string(
          target,
          `tables.${name}.references.${column}`,
        );
      }
    }
    tables[name] = table;
  }
  if (Object.keys(tables).length === 0)
    throw new ConfigError("tables must list at least one table");

  for (const [name, table] of Object.entries(tables)) {
    for (const [column, target] of Object.entries(table.references ?? {})) {
      if (!Object.hasOwn(tables, target)) {
        throw new ConfigError(
          `tables.${name}.references.${column} points at "${target}", which is not in tables`,
        );
      }
    }
    const via = table.tenantVia;
    if (via) {
      if (!Object.hasOwn(tables, via.table)) {
        throw new ConfigError(
          `tables.${name}.tenantVia.table is "${via.table}", which is not in tables`,
        );
      }
      const listed = table.references?.[via.column];
      if (listed !== undefined && listed !== via.table) {
        throw new ConfigError(
          `tables.${name}.references.${via.column} points at "${listed}", but tenantVia says "${via.table}"`,
        );
      }
    }
  }
  // Chains may run through several tenantVia tables, but must end at a table
  // with its own tenantColumn. Checked once every target is known to exist.
  for (const [name, table] of Object.entries(tables)) {
    if (
      table.tenantVia &&
      !tenantSource({ projectRef, membership, tables }, name)
    ) {
      throw new ConfigError(
        `tables.${name}.tenantVia leads back to a table it already passed through; the chain must end at a table with a tenantColumn`,
      );
    }
  }

  const ignore: string[] = [];
  if (root.ignore !== undefined) {
    if (!Array.isArray(root.ignore))
      throw new ConfigError("ignore must be an array of names");
    for (const [i, name] of root.ignore.entries()) {
      // Compared with the first path segment after /rest/v1/, never put into
      // SQL. A `/` or `?` could never match it: `rpc/fn` stays a silent no-op.
      const value = string(name, `ignore[${i}]`);
      if (/[/?]/.test(value)) {
        throw new ConfigError(
          `ignore[${i}] is "${value}"; use the name right after /rest/v1/ (functions are ignored all at once, as "rpc")`,
        );
      }
      if (Object.hasOwn(tables, value)) {
        throw new ConfigError(
          `ignore[${i}] is "${value}", which is also in tables; list it in one of them`,
        );
      }
      ignore.push(value);
    }
  }

  return { projectRef, membership, tables, ignore };
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "")
    throw new ConfigError(`${path} must be a non-empty string`);
  return value;
}

/** Names are interpolated into SQL as quoted identifiers, so keep them plain. */
function identifier(value: unknown, path: string): string {
  const s = string(value, path);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) {
    throw new ConfigError(
      `${path} must be a plain identifier (letters, digits, underscore)`,
    );
  }
  return s;
}
