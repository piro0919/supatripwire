import { readFile } from "node:fs/promises";

/** How a table relates to tenants. */
export type TableConfig = {
  /** Column holding the tenant id. On the tenants table itself, this is its primary key. */
  tenantColumn: string;
  /** Primary key column. Defaults to `id`. */
  idColumn?: string;
  /** Columns holding the id of a row in another configured table, e.g. `{ "resident_id": "residents" }`. */
  references?: Record<string, string>;
};

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
};

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
  const tables: Record<string, TableConfig> = {};
  for (const [name, value] of Object.entries(rawTables)) {
    identifier(name, `tables key "${name}"`);
    const t = object(value, `tables.${name}`);
    const table: TableConfig = {
      tenantColumn: identifier(t.tenantColumn, `tables.${name}.tenantColumn`),
    };
    if (t.idColumn !== undefined)
      table.idColumn = identifier(t.idColumn, `tables.${name}.idColumn`);
    if (t.references !== undefined) {
      const refs = object(t.references, `tables.${name}.references`);
      table.references = {};
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
      if (!tables[target]) {
        throw new ConfigError(
          `tables.${name}.references.${column} points at "${target}", which is not in tables`,
        );
      }
    }
  }

  return { projectRef, membership, tables };
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
