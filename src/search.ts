/**
 * A top-level PostgREST filter that pins a column to concrete values.
 *
 * Only `eq` and `in` are kept: they are the operators that name specific rows.
 * Negations (`not.eq`, `neq`), ranges and pattern matches do not name a tenant.
 */
export type PinningFilter = {
  column: string;
  values: string[];
};

/**
 * Query parameters PostgREST reserves for something other than a column filter.
 * See https://docs.postgrest.org/en/stable/references/api/tables_views.html
 */
const RESERVED = new Set([
  "select",
  "order",
  "limit",
  "offset",
  "or",
  "and",
  "not",
  "on_conflict",
  "columns",
]);

/**
 * Reads the pinning filters out of `request.search` as Supabase logs it:
 * a leading `?`, URL-encoded (`in.(a,b)` is logged as `in.%28a%2Cb%29`).
 *
 * Top-level `and=(…)` and `or=(…)` logic trees are read too: every pinning
 * item of an `and` pins the result, and an `or` whose items all pin the same
 * column acts like an `in` list. Anything else in a tree is not read.
 *
 * Filters on embedded resources (`other.col=eq.…`, `other.or=…`) are skipped:
 * they narrow the embedded rows, not the top-level rows `content_range` counts.
 */
export function parsePinningFilters(search: string): PinningFilter[] {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const filters: PinningFilter[] = [];
  for (const [key, raw] of params) {
    if (key === "and" || key === "or") {
      const items = groupItems(raw);
      if (items) filters.push(...logicGroup(key, items));
      continue;
    }
    if (RESERVED.has(key) || key.includes(".")) continue;
    const values = pinnedValues(raw);
    if (values) filters.push({ column: key, values });
  }
  return filters;
}

const EQ = "eq.";
const IN_OPEN = "in.(";

function pinnedValues(raw: string, inTree = false): string[] | null {
  if (raw.startsWith(EQ)) {
    const value = raw.slice(EQ.length);
    return [inTree ? unquote(value) : value];
  }
  if (raw.startsWith(IN_OPEN) && raw.endsWith(")")) {
    return splitList(raw.slice(IN_OPEN.length, -1));
  }
  return null;
}

/** `"a\"b"` → `a"b`; anything not wrapped in double quotes is returned as is. */
function unquote(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
    return value;
  }
  return value.slice(1, -1).replace(/\\(.)/g, "$1");
}

/** `(a,b(c,d),"e,f")` → `["a", "b(c,d)", "\"e,f\""]`; null if not parenthesised. */
function groupItems(raw: string): string[] | null {
  if (!raw.startsWith("(") || !raw.endsWith(")")) return null;
  const inner = raw.slice(1, -1);
  const items: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quoted) {
      if (ch === "\\") i++;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      items.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  items.push(inner.slice(start));
  return items.map((s) => s.trim()).filter((s) => s !== "");
}

/** `col.eq.v` or `col.in.(a,b)` inside a logic tree. */
function treeItem(item: string): PinningFilter | null {
  const dot = item.indexOf(".");
  if (dot <= 0) return null;
  const column = item.slice(0, dot);
  if (RESERVED.has(column)) return null;
  const values = pinnedValues(item.slice(dot + 1), true);
  return values ? { column, values } : null;
}

function logicGroup(kind: "and" | "or", items: string[]): PinningFilter[] {
  if (kind === "and") {
    const filters: PinningFilter[] = [];
    for (const item of items) {
      const nested = /^(and|or)(\(.*\))$/s.exec(item);
      if (nested) {
        const sub = groupItems(nested[2] as string);
        if (sub) filters.push(...logicGroup(nested[1] as "and" | "or", sub));
        continue;
      }
      const filter = treeItem(item);
      if (filter) filters.push(filter);
    }
    return filters;
  }
  // An `or` pins only when every branch pins the same column.
  const parts = items.map(treeItem);
  const first = parts[0];
  if (!first || parts.some((p) => !p || p.column !== first.column)) return [];
  return [
    {
      column: first.column,
      values: parts.flatMap((p) => (p as PinningFilter).values),
    },
  ];
}

/**
 * Splits a comma-separated list, as inside `in.(…)`. Values may be
 * double-quoted to carry commas or parentheses, and `\` escapes inside quotes.
 */
function splitList(inner: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quoted) {
      if (ch === "\\" && i + 1 < inner.length) {
        current += inner[++i];
      } else if (ch === '"') {
        quoted = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
      wasQuoted = true;
    } else if (ch === ",") {
      values.push(wasQuoted ? current : current.trim());
      current = "";
      wasQuoted = false;
    } else {
      current += ch;
    }
  }
  if (current !== "" || wasQuoted)
    values.push(wasQuoted ? current : current.trim());
  return values;
}
