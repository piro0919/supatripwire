import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSql, fetchReadLogs, LogsApiError, windows } from "../src/logs.js";

type Call = {
  url: string;
  body: { sql: string; iso_timestamp_start: string; iso_timestamp_end: string };
};

function row(n: number, extra: Record<string, unknown> = {}) {
  return {
    timestamp: `2026-01-01T00:00:${String(n).padStart(2, "0")}.000000`,
    id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
    user_id: "user-1",
    path: "/rest/v1/projects",
    search: "?id=eq.p1",
    content_range: "0-0/*",
    status: "200",
    ...extra,
  };
}

function fakeFetch(responses: Array<Response | (() => Response)>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const next = responses.shift();
    if (!next) throw new Error("unexpected call");
    return typeof next === "function" ? next() : next;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const base = {
  projectRef: "abcdefghijklmnopqrst",
  accessToken: "token",
  from: new Date("2026-01-01T00:00:00Z"),
  to: new Date("2026-01-01T01:00:00Z"),
};

afterEach(() => {
  vi.useRealTimers();
});

describe("windows", () => {
  it("splits a long range into windows under 24 hours", () => {
    const w = windows(
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-03T00:00:00Z"),
    );
    expect(w).toHaveLength(3);
    for (const [s, e] of w)
      expect(e.getTime() - s.getTime()).toBeLessThan(24 * 3_600_000);
    expect(w[0]?.[0].toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(w[2]?.[1].toISOString()).toBe("2026-01-03T00:00:00.000Z");
    expect(w[1]?.[0].getTime()).toBe(w[0]?.[1].getTime());
  });
});

describe("buildSql", () => {
  it("limits to signed-in GETs on PostgREST within the exact window", () => {
    const sql = buildSql(
      new Date("2026-01-01T00:00:30Z"),
      new Date("2026-01-01T01:00:00Z"),
      null,
      100,
    );
    expect(sql).toContain("source = 'edge_logs'");
    expect(sql).toContain("log_attributes['request.method'] = 'GET'");
    expect(sql).toContain(
      "startsWith(log_attributes['request.path'], '/rest/v1/')",
    );
    expect(sql).toContain(
      "log_attributes['request.sb.jwt.authorization.payload.subject'] != ''",
    );
    expect(sql).toContain(
      "timestamp >= toDateTime64('2026-01-01 00:00:30.000', 6, 'UTC')",
    );
    expect(sql).toContain(
      "timestamp < toDateTime64('2026-01-01 01:00:00.000', 6, 'UTC')",
    );
    expect(sql).toMatch(/limit 100$/);
  });

  it("adds a cursor that continues after the last row", () => {
    const sql = buildSql(
      base.from,
      base.to,
      { timestamp: "2026-01-01T00:00:05.123000", id: "abc" },
      100,
    );
    expect(sql).toContain(
      "(timestamp > toDateTime64('2026-01-01 00:00:05.123000', 6, 'UTC') or (timestamp = toDateTime64('2026-01-01 00:00:05.123000', 6, 'UTC') and toString(id) > 'abc'))",
    );
  });

  it("refuses a cursor timestamp that is not a timestamp", () => {
    expect(() =>
      buildSql(base.from, base.to, { timestamp: "x') or 1=1 --", id: "a" }, 10),
    ).toThrow(LogsApiError);
  });
});

describe("fetchReadLogs", () => {
  it("pages with the last row as the cursor and maps rows to entries", async () => {
    const { fn, calls } = fakeFetch([
      json({ result: [row(1), row(2)] }),
      json({ result: [row(3)] }),
    ]);
    const entries = await collect(
      fetchReadLogs({ ...base, pageSize: 2, fetch: fn }),
    );

    expect(entries.map((e) => e.id)).toEqual([row(1).id, row(2).id, row(3).id]);
    expect(entries[0]).toEqual({
      timestamp: row(1).timestamp,
      id: row(1).id,
      userId: "user-1",
      table: "projects",
      search: "?id=eq.p1",
      contentRange: "0-0/*",
      status: 200,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(
      "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/analytics/endpoints/logs",
    );
    expect(calls[0]?.body.sql).not.toContain("toString(id) >");
    expect(calls[1]?.body.sql).toContain(`toString(id) > '${row(2).id}'`);
  });

  it("sends minute-aligned bounds that cover the window", async () => {
    const { fn, calls } = fakeFetch([json({ result: [] })]);
    await collect(
      fetchReadLogs({
        ...base,
        from: new Date("2026-01-01T00:00:30Z"),
        to: new Date("2026-01-01T00:10:15Z"),
        fetch: fn,
      }),
    );
    expect(calls[0]?.body.iso_timestamp_start).toBe("2026-01-01T00:00:00.000Z");
    expect(calls[0]?.body.iso_timestamp_end).toBe("2026-01-01T00:11:00.000Z");
  });

  it("takes the table from the path, dropping anything after it", async () => {
    const { fn } = fakeFetch([
      json({ result: [row(1, { path: "/rest/v1/my%20table/extra" })] }),
    ]);
    const [entry] = await collect(fetchReadLogs({ ...base, fetch: fn }));
    expect(entry?.table).toBe("my table");
  });

  it("keeps a path with a broken percent-escape instead of aborting", async () => {
    const { fn } = fakeFetch([
      json({
        result: [row(1, { path: "/rest/v1/%E0%A4" }), row(2)],
      }),
    ]);
    const entries = await collect(fetchReadLogs({ ...base, fetch: fn }));
    expect(entries.map((e) => e.table)).toEqual(["%E0%A4", "projects"]);
  });

  it("retries after a 429", async () => {
    vi.useFakeTimers();
    const { fn, calls } = fakeFetch([
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": "3" },
      }),
      json({ result: [row(1)] }),
    ]);
    const pending = collect(fetchReadLogs({ ...base, fetch: fn }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("throws on an HTTP error", async () => {
    const { fn } = fakeFetch([new Response("nope", { status: 401 })]);
    await expect(
      collect(fetchReadLogs({ ...base, fetch: fn })),
    ).rejects.toThrow(/401: nope/);
  });

  it("throws when the query itself failed", async () => {
    const { fn } = fakeFetch([json({ error: "Syntax error" })]);
    await expect(
      collect(fetchReadLogs({ ...base, fetch: fn })),
    ).rejects.toThrow(/Syntax error/);
  });
});
