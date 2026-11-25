import type { TableConfig } from "./config.js";
import { groupItems } from "./search.js";

/** What a hidden value is replaced with. */
export const REDACTED = "***";

/**
 * Parameters that carry column names or numbers, never row data.
 * See https://docs.postgrest.org/en/stable/references/api/tables_views.html
 */
const STRUCTURAL = new Set([
  "select",
  "order",
  "limit",
  "offset",
  "columns",
  "on_conflict",
]);

/** PostgREST filter operators and modifiers, as they appear before the value. */
const OPERATORS = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "match",
  "imatch",
  "in",
  "is",
  "isdistinct",
  "fts",
  "plfts",
  "phfts",
  "wfts",
  "cs",
  "cd",
  "ov",
  "sl",
  "sr",
  "nxr",
  "nxl",
  "adj",
  "not",
]);

/**
 * `request.search` with every filter value hidden, except on the columns the
 * config maps for the table: its tenant column, its id column and its
 * references. Those are what an investigation needs; any other column may be
 * a name, an email or a note the app filtered on, and the report must not
 * carry it into CI logs or chat.
 *
 * Column names, operators and the structure of `and=(…)` / `or=(…)` stay, so
 * the shape of the query is still readable: `?name=ilike.***&org_id=eq.<id>`.
 * Anything the parser does not recognize is hidden whole.
 */
export function redactSearch(
  search: string,
  table: TableConfig | undefined,
): string {
  const keep = keptColumns(table);
  const prefix = search.startsWith("?") ? "?" : "";
  const params = new URLSearchParams(prefix ? search.slice(1) : search);
  const parts: string[] = [];
  for (const [key, raw] of params) {
    parts.push(`${encode(key)}=${encode(redactParam(key, raw, keep))}`);
  }
  return parts.length > 0 ? prefix + parts.join("&") : prefix;
}

function keptColumns(table: TableConfig | undefined): Set<string> {
  if (!table) return new Set();
  return new Set([
    table.tenantColumn,
    table.idColumn ?? "id",
    ...Object.keys(table.references ?? {}),
  ]);
}

function redactParam(key: string, raw: string, keep: Set<string>): string {
  if (STRUCTURAL.has(key)) return raw;
  const segments = key.split(".");
  const last = segments[segments.length - 1] as string;
  if (last === "and" || last === "or") {
    // A tree on an embedded resource (`other.or`) names columns of rows the
    // config does not describe: keep nothing. `not.and` is still this table.
    const embedded = segments.slice(0, -1).some((s) => s !== "not");
    return redactTree(raw, embedded ? new Set() : keep);
  }
  // `other.col=eq.…` filters an embedded resource; its columns are not mapped.
  return keep.has(key) ? raw : redactFilter(raw);
}

/** `ilike.*smith*` → `ilike.***`; `not.in.(a,b)` → `not.in.***`. */
function redactFilter(raw: string): string {
  const tokens = raw.split(".");
  const kept: string[] = [];
  for (const token of tokens) {
    // `like(any)`, `fts(english)`: the modifier in parentheses is not data.
    const name = token.replace(/\([a-z_]*\)$/, "");
    if (!OPERATORS.has(name) || kept.length === tokens.length - 1) break;
    kept.push(token);
  }
  return [...kept, REDACTED].join(".");
}

/** `(org_id.eq.<id>,name.eq.Smith)` → `(org_id.eq.<id>,name.eq.***)`. */
function redactTree(raw: string, keep: Set<string>): string {
  const items = groupItems(raw);
  if (!items) return REDACTED;
  return `(${items.map((item) => redactTreeItem(item, keep)).join(",")})`;
}

function redactTreeItem(item: string, keep: Set<string>): string {
  const nested = /^((?:not\.)?(?:and|or))(\(.*\))$/s.exec(item);
  if (nested) return `${nested[1]}${redactTree(nested[2] as string, keep)}`;
  const dot = item.indexOf(".");
  if (dot <= 0) return REDACTED;
  const column = item.slice(0, dot);
  const rest = item.slice(dot + 1);
  return `${column}.${keep.has(column) ? rest : redactFilter(rest)}`;
}

/** Like the log: percent-encoded, but `(`, `)`, `*` and `,` left readable. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(/%2C/g, ",");
}
