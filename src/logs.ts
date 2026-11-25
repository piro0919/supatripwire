/** One signed-in PostgREST read, as recorded in `edge_logs`. */
export type ReadLogEntry = {
  /** UTC, as returned by the logs API (`2026-01-01T00:00:00.000000`). */
  timestamp: string;
  /** The log event id. */
  id: string;
  /** `sub` of the caller's JWT: the auth user id. */
  userId: string;
  /** Table or view name from `/rest/v1/<table>`. */
  table: string;
  /** `request.search` verbatim: leading `?`, URL-encoded. */
  search: string;
  /** `response.headers.content_range`, empty when absent. */
  contentRange: string;
  status: number;
};

export type FetchReadLogsOptions = {
  projectRef: string;
  accessToken: string;
  from: Date;
  to: Date;
  /** Rows per API call. */
  pageSize?: number;
  fetch?: typeof globalThis.fetch;
  /** Base URL of the Management API. */
  apiUrl?: string;
};

export class LogsApiError extends Error {
  override name = "LogsApiError";
}

/**
 * The logs endpoint rejects ranges longer than 24 hours. Each window's bounds
 * are widened to whole minutes before they are sent, so keep two minutes spare.
 */
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MAX_WINDOW_MS = DAY_MS - 2 * MINUTE_MS;
const DEFAULT_PAGE_SIZE = 1000;
const HTTP_TOO_MANY_REQUESTS = 429;
const MAX_RETRIES = 5;
const ERROR_BODY_LIMIT = 500;
const PATH_PREFIX = "/rest/v1/";

/**
 * Yields every signed-in GET to PostgREST between `from` (inclusive) and `to`
 * (exclusive), oldest first.
 *
 * The range is split into windows of at most 24 hours, and each window is read
 * in pages with a (timestamp, id) cursor so no event is skipped or repeated.
 */
export async function* fetchReadLogs(
  options: FetchReadLogsOptions,
): AsyncGenerator<ReadLogEntry> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  for (const [start, end] of windows(options.from, options.to)) {
    let cursor: { timestamp: string; id: string } | null = null;
    while (true) {
      const rows = await queryLogs(
        options,
        start,
        end,
        buildSql(start, end, cursor, pageSize),
      );
      for (const row of rows) {
        const entry = toEntry(row);
        if (entry) yield entry;
      }
      if (rows.length < pageSize) break;
      const last = rows[rows.length - 1] as Record<string, unknown>;
      cursor = { timestamp: String(last.timestamp), id: String(last.id) };
    }
  }
}

export function windows(from: Date, to: Date): Array<[Date, Date]> {
  const result: Array<[Date, Date]> = [];
  let start = from.getTime();
  const stop = to.getTime();
  while (start < stop) {
    const end = Math.min(start + MAX_WINDOW_MS, stop);
    result.push([new Date(start), new Date(end)]);
    start = end;
  }
  return result;
}

export function buildSql(
  start: Date,
  end: Date,
  cursor: { timestamp: string; id: string } | null,
  pageSize: number,
): string {
  // The API rounds its own time bounds to the minute, so the exact window is
  // enforced here as well; otherwise adjacent windows would overlap.
  const conditions = [
    "source = 'edge_logs'",
    "log_attributes['request.method'] = 'GET'",
    `startsWith(log_attributes['request.path'], '${PATH_PREFIX}')`,
    "log_attributes['request.sb.jwt.authorization.payload.subject'] != ''",
    `timestamp >= ${dateTime64(start.toISOString())}`,
    `timestamp < ${dateTime64(end.toISOString())}`,
  ];
  if (cursor) {
    const ts = dateTime64(cursor.timestamp);
    conditions.push(
      `(timestamp > ${ts} or (timestamp = ${ts} and toString(id) > ${literal(cursor.id)}))`,
    );
  }
  return [
    "select timestamp, toString(id) as id,",
    "  log_attributes['request.sb.jwt.authorization.payload.subject'] as user_id,",
    "  log_attributes['request.path'] as path,",
    "  log_attributes['request.search'] as search,",
    "  log_attributes['response.headers.content_range'] as content_range,",
    "  log_attributes['response.status_code'] as status",
    "from logs",
    `where ${conditions.join("\n  and ")}`,
    "order by timestamp, toString(id)",
    `limit ${pageSize}`,
  ].join("\n");
}

/** `2026-01-01T00:00:00.000Z` or `2026-01-01T00:00:00.000000` → a UTC DateTime64(6) literal. */
function dateTime64(iso: string): string {
  const plain = iso.replace("T", " ").replace(/Z$/, "");
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(plain)) {
    throw new LogsApiError(`Unexpected timestamp from the logs API: ${iso}`);
  }
  return `toDateTime64('${plain}', 6, 'UTC')`;
}

function literal(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

async function queryLogs(
  options: FetchReadLogsOptions,
  start: Date,
  end: Date,
  sql: string,
): Promise<unknown[]> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const base = options.apiUrl ?? "https://api.supabase.com";
  const url = `${base}/v1/projects/${options.projectRef}/analytics/endpoints/logs`;
  const body = JSON.stringify({
    sql,
    iso_timestamp_start: floorToMinute(start).toISOString(),
    iso_timestamp_end: ceilToMinute(end).toISOString(),
  });

  for (let attempt = 0; ; attempt++) {
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.accessToken}`,
        "content-type": "application/json",
      },
      body,
    });
    // 120 requests per minute per user, project and endpoint.
    if (response.status === HTTP_TOO_MANY_REQUESTS && attempt < MAX_RETRIES) {
      // Release the connection before waiting.
      await response.body?.cancel();
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * SECOND_MS
          : 2 ** attempt * SECOND_MS,
      );
      continue;
    }
    if (!response.ok) {
      throw new LogsApiError(
        `Logs API returned ${response.status}: ${await safeText(response)}`,
      );
    }
    const json = (await response.json()) as {
      result?: unknown[];
      error?: unknown;
    };
    if (json.error) {
      const message =
        typeof json.error === "string"
          ? json.error
          : JSON.stringify(json.error);
      throw new LogsApiError(`Logs query failed: ${message}`);
    }
    return json.result ?? [];
  }
}

function toEntry(row: unknown): ReadLogEntry | null {
  const r = row as Record<string, unknown>;
  const path = String(r.path ?? "");
  if (!path.startsWith(PATH_PREFIX)) return null;
  const table = safeDecode(path.slice(PATH_PREFIX.length).split("/")[0] ?? "");
  if (!table) return null;
  return {
    timestamp: String(r.timestamp),
    id: String(r.id),
    userId: String(r.user_id),
    table,
    search: String(r.search ?? ""),
    contentRange: String(r.content_range ?? ""),
    status: Number(r.status),
  };
}

/**
 * A path with a broken percent-escape (`/rest/v1/%E0`) is kept as spelled rather
 * than aborting the whole run on one malformed request.
 */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function floorToMinute(date: Date): Date {
  return new Date(Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS);
}

function ceilToMinute(date: Date): Date {
  return new Date(Math.ceil(date.getTime() / MINUTE_MS) * MINUTE_MS);
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, ERROR_BODY_LIMIT);
  } catch {
    return "(no body)";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
