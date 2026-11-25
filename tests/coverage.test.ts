import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { coverageGaps, exitCode } from "../src/coverage.js";
import type { TenantDirectory } from "../src/directory.js";
import type { ReadLogEntry } from "../src/logs.js";
import { formatJson, formatText } from "../src/report.js";
import { runChecks } from "../src/run-checks.js";

const config = parseConfig({
  projectRef: "abcdefghijklmnopqrst",
  membership: {
    table: "memberships",
    userColumn: "user_id",
    tenantColumn: "org_id",
  },
  tables: { projects: { tenantColumn: "org_id" } },
});

/** alice is in org-a, which holds 5 projects; nobody else is in anything. */
const directory: TenantDirectory = {
  async membershipsOf(userIds) {
    return new Map(
      userIds.map((u) => [u, new Set(u === "alice" ? ["org-a"] : [])]),
    );
  },
  async tenantsOfRows() {
    return new Map();
  },
  async rowCounts(_table, tenants) {
    return new Map(tenants.map((t) => [t, 5]));
  },
  async canonicalTenantIds(values) {
    return new Map(values.map((v) => [v, v]));
  },
  async close() {},
};

let seq = 0;
function read(overrides: Partial<ReadLogEntry>): ReadLogEntry {
  seq++;
  return {
    timestamp: `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000000`,
    id: `log-${seq}`,
    userId: "alice",
    table: "projects",
    search: "?select=*",
    contentRange: "0-0/*",
    status: 200,
    ...overrides,
  };
}

const range = {
  from: new Date("2026-01-01T00:00:00Z"),
  to: new Date("2026-01-02T00:00:00Z"),
};

describe("coverage", () => {
  it("has no gaps when every read was on a configured table with a row count", async () => {
    const summary = await runChecks(
      [read({}), read({ contentRange: "*/*" })],
      config,
      directory,
    );
    expect(coverageGaps(summary)).toEqual([]);
    expect(exitCode(summary, true)).toBe(0);
  });

  it("records when the first and last reads were found", async () => {
    const first = read({});
    const last = read({});
    const summary = await runChecks([first, last], config, directory);
    expect(summary.firstReadAt).toBe(first.timestamp);
    expect(summary.lastReadAt).toBe(last.timestamp);
  });

  it("finds the first and last reads whatever order the entries come in", async () => {
    const early = read({});
    const late = read({});
    const summary = await runChecks([late, early], config, directory);
    expect(summary.firstReadAt).toBe(early.timestamp);
    expect(summary.lastReadAt).toBe(late.timestamp);
  });

  it("notes a range whose first read comes more than a day after its start", async () => {
    const summary = await runChecks(
      [read({ timestamp: "2026-01-05T00:00:00.000000" })],
      config,
      directory,
    );
    const to = new Date("2026-01-06T00:00:00Z");
    const wide = { from: new Date("2026-01-01T00:00:00Z"), to };
    const narrow = { from: new Date("2026-01-04T12:00:00Z"), to };
    expect(formatText(summary, wide)).toContain("Nothing before that.");
    expect(formatText(summary, narrow)).not.toContain("Nothing before that.");
    expect(coverageGaps(summary)).toEqual([]);
  });

  it("calls an empty range a gap, since expired logs also come back empty", async () => {
    const summary = await runChecks([], config, directory);
    expect(coverageGaps(summary)).toEqual(["no-reads"]);
    expect(summary.firstReadAt).toBeNull();
    expect(exitCode(summary, false)).toBe(0);
    expect(exitCode(summary, true)).toBe(3);
    expect(formatText(summary, range)).toContain("Nothing was checked.");
  });

  it("counts successful reads with no readable row count, per table", async () => {
    const summary = await runChecks(
      [
        read({ contentRange: "" }),
        read({ contentRange: "garbage" }),
        // An error returned no rows: nothing to judge, so not a gap.
        read({ contentRange: "", status: 401 }),
        // A missing status is not an error; it may have returned rows.
        read({ contentRange: "", status: Number("") }),
        read({}),
      ],
      config,
      directory,
    );
    expect(summary.readsWithoutRowCount).toBe(3);
    expect(Object.fromEntries(summary.tablesWithoutRowCount)).toEqual({
      projects: 3,
    });
    expect(coverageGaps(summary)).toEqual(["no-row-count"]);
    const text = formatText(summary, range);
    expect(text).toContain("fully checked: 2");
    expect(text).toContain("without a row count: 3");
  });

  it("lists every kind of gap, and strict fails on them", async () => {
    const summary = await runChecks(
      [
        read({ table: "invoices" }),
        read({ contentRange: "" }),
        // bob has no membership: a finding that cannot be crossed.
        read({ userId: "bob", contentRange: "0-9/*" }),
      ],
      config,
      directory,
    );
    expect(coverageGaps(summary)).toEqual([
      "unmapped-tables",
      "no-row-count",
      "users-without-membership",
    ]);
    expect(exitCode(summary, false)).toBe(0);
    expect(exitCode(summary, true)).toBe(3);
    const json = JSON.parse(formatJson(summary, range));
    expect(json.coverageGaps).toEqual(coverageGaps(summary));
    expect(json.readsWithoutRowCount).toBe(1);
  });

  it("reports an empty ceiling as a gap", async () => {
    const empty: TenantDirectory = {
      ...directory,
      async rowCounts(_table, tenants) {
        return new Map(tenants.map((t) => [t, 0]));
      },
    };
    const summary = await runChecks([read({})], config, empty);
    expect(coverageGaps(summary)).toEqual(["empty-ceiling"]);
  });

  it("counts reads on ignored tables apart, not as a gap", async () => {
    const withIgnore = parseConfig({
      projectRef: "abcdefghijklmnopqrst",
      membership: {
        table: "memberships",
        userColumn: "user_id",
        tenantColumn: "org_id",
      },
      tables: { projects: { tenantColumn: "org_id" } },
      ignore: ["countries", "rpc"],
    });
    const summary = await runChecks(
      [
        read({ table: "countries" }),
        read({ table: "countries" }),
        read({ table: "rpc" }),
        read({}),
      ],
      withIgnore,
      directory,
    );
    expect(summary.readsOnIgnoredTables).toBe(3);
    expect(summary.readsOnUnmappedTables).toBe(0);
    expect(coverageGaps(summary)).toEqual([]);
    expect(exitCode(summary, true)).toBe(0);
    const text = formatText(summary, range);
    expect(text).toContain("fully checked: 1");
    expect(text).toContain(
      "on tables the config ignores: 3 (countries 2, rpc 1)",
    );
  });

  it("calls a run where every read was ignored a gap: nothing was checked", async () => {
    const withIgnore = { ...config, ignore: ["countries"] };
    const summary = await runChecks(
      [read({ table: "countries" })],
      withIgnore,
      directory,
    );
    expect(coverageGaps(summary)).toEqual(["no-reads"]);
    expect(exitCode(summary, true)).toBe(3);
  });

  it("checks a configured table even when a hand-built config also ignores it", async () => {
    const overlap = { ...config, ignore: ["projects"] };
    const summary = await runChecks(
      [read({ contentRange: "0-9/*" })],
      overlap,
      directory,
    );
    expect(summary.readsOnIgnoredTables).toBe(0);
    expect(summary.findings.some((f) => f.kind === "crossed")).toBe(true);
  });

  it("does not crash on Object-named paths with a hand-built config either", async () => {
    // A plain object, unlike parseConfig's prototype-free one.
    const handBuilt = { ...config, tables: { ...config.tables } };
    const summary = await runChecks(
      [
        read({
          table: "constructor",
          search: "?id=eq.1",
          contentRange: "0-9/*",
        }),
      ],
      handBuilt,
      directory,
    );
    expect(summary.readsOnUnmappedTables).toBe(1);
  });

  it("does not crash on a path named after an Object property", async () => {
    const summary = await runChecks(
      [
        read({
          table: "constructor",
          search: "?id=eq.1",
          contentRange: "0-9/*",
        }),
        read({ table: "__proto__", search: "?id=eq.1", contentRange: "0-9/*" }),
      ],
      config,
      directory,
    );
    expect(summary.readsOnUnmappedTables).toBe(2);
    expect(summary.findings).toEqual([]);
  });

  it("exits 1 on crossed data even with gaps and strict", async () => {
    const summary = await runChecks(
      [read({ contentRange: "0-9/*" }), read({ table: "invoices" })],
      config,
      directory,
    );
    expect(summary.findings.some((f) => f.kind === "crossed")).toBe(true);
    expect(exitCode(summary, true)).toBe(1);
  });
});
