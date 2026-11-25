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
  // `other.col=eq.…` filters an embedded resource; its columns are not mapped,
  // and a dotted key is never in `keep`.
  return redactFilter(raw, keep.has(key));
}

/**
 * `ilike.*smith*` → `ilike.***`; `not.in.(a,b)` → `not.in.***`.
 *
 * With `mapped`, the value stays when the operator names ids (`eq`, `neq`,
 * `in`, `is`): those are what a finding is about. Pattern and full-text
 * operators can carry free text even on an id column, so they are hidden.
 */
function redactFilter(raw: string, mapped: boolean): string {
  const ops = operatorPrefix(raw);
  if (ops === null) return REDACTED;
  if (mapped && ID_OPERATORS.has(ops.name)) return raw;
  return `${ops.prefix}.${REDACTED}`;
}

/** Operators whose value is an id or a constant, kept on mapped columns. */
const ID_OPERATORS = new Set(["eq", "neq", "in", "is"]);

/** Full-text operators, which take a language config in parentheses. */
const FTS_OPERATORS = new Set(["fts", "plfts", "phfts", "wfts"]);

/**
 * The operator in front of a filter value: an optional `not`, then exactly one
 * operator, with `(any)` / `(all)` or, on full-text operators, a language
 * config. Null when the value does not start that way, or nothing follows.
 */
function operatorPrefix(raw: string): { prefix: string; name: string } | null {
  const tokens = raw.split(".");
  const at = tokens[0] === "not" ? 1 : 0;
  if (tokens.length < at + 2) return null;
  const match = /^([a-z]+)(?:\(([a-z_]+)\))?$/.exec(tokens[at] as string);
  if (!match) return null;
  const name = match[1] as string;
  const modifier = match[2];
  if (!OPERATORS.has(name)) return null;
  if (
    modifier !== undefined &&
    modifier !== "any" &&
    modifier !== "all" &&
    !FTS_OPERATORS.has(name)
  ) {
    return null;
  }
  return { prefix: tokens.slice(0, at + 1).join("."), name };
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
  // `project_id.name.eq.x` is a filter on a resource embedded through the
  // `project_id` column, not on `project_id`: its rest starts with no operator,
  // so redactFilter hides it whole.
  return `${column}.${redactFilter(item.slice(dot + 1), keep.has(column))}`;
}

/**
 * Percent-encoded, but `(`, `)`, `*` and `,` left readable. The log encodes
 * those too (`in.%28a%2Cb%29`), so search the log by its id, not this text.
 */
function encode(value: string): string {
  return encodeURIComponent(value).replace(/%2C/g, ",");
}
