import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import type { TenantDirectory } from "../src/directory.js";
import type { ReadLogEntry } from "../src/logs.js";
import { formatText } from "../src/report.js";
import { runChecks } from "../src/run-checks.js";

// A made-up project: org-a has 2 projects, org-b has 5.
const config = parseConfig({
  projectRef: "abcdefghijklmnopqrst",
  membership: {
    table: "memberships",
    userColumn: "user_id",
    tenantColumn: "org_id",
  },
  tables: {
    orgs: { tenantColumn: "id" },
    projects: { tenantColumn: "org_id" },
    tasks: { tenantColumn: "org_id" },
  },
});

const memberships: Record<string, string[]> = {
  alice: ["org-a"],
  bob: ["org-a", "org-b"],
};
const counts: Record<string, Record<string, number>> = {
  orgs: { "org-a": 1, "org-b": 1 },
  projects: { "org-a": 2, "org-b": 5 },
};
const rowTenants: Record<string, string> = { "p-b1": "org-b" };

function fakeDirectory() {
  const countCalls: Array<[string, string[]]> = [];
  const directory: TenantDirectory = {
    async membershipsOf(userIds) {
      return new Map(userIds.map((u) => [u, new Set(memberships[u] ?? [])]));
    },
    async tenantsOfRows(_table, ids) {
      return new Map(
        ids.flatMap((id) => (rowTenants[id] ? [[id, rowTenants[id]]] : [])),
      );
    },
    async canonicalTenantIds(values) {
      return new Map(values.map((v) => [v, v]));
    },
    async rowCounts(table, tenants) {
      countCalls.push([table, tenants]);
      return new Map(tenants.map((t) => [t, counts[table]?.[t] ?? 0]));
    },
    async close() {},
  };
  return { directory, countCalls };
}

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

async function run(entries: ReadLogEntry[], batchSize?: number) {
  const { directory, countCalls } = fakeDirectory();
  const summary = await runChecks(entries, config, directory, { batchSize });
  const findings = summary.findings.filter((f) => f.check === "row-ceiling");
  return { summary, findings, countCalls };
}

describe("check 2: more rows than the caller's tenants hold", () => {
  it("reports nothing while the rows fit inside the caller's tenants", async () => {
    const { findings } = await run([
      read({ contentRange: "0-1/*" }),
      read({ contentRange: "0-0/*" }),
    ]);
    expect(findings).toEqual([]);
  });

  it("reports crossed when an unfiltered read returns more rows than that", async () => {
    const { findings } = await run([read({ contentRange: "0-2/*" })]);
    expect(findings).toMatchObject([
      {
        check: "row-ceiling",
        kind: "crossed",
        rows: 3,
        visibleAtLeast: 3,
        ceiling: 2,
        memberTenants: ["org-a"],
      },
    ]);
  });

  it("uses the offset: a later page proves the whole result was larger", async () => {
    const { findings } = await run([
      read({
        search: "?select=*&offset=100&limit=10",
        contentRange: "100-109/*",
      }),
    ]);
    expect(findings).toMatchObject([
      { kind: "crossed", rows: 10, visibleAtLeast: 110, ceiling: 2 },
    ]);
  });

  it("ignores the total after the slash, which may be an estimate", async () => {
    const { findings } = await run([read({ contentRange: "0-0/5000" })]);
    expect(findings).toEqual([]);
  });

  it("sums the ceiling over every tenant the caller belongs to", async () => {
    const { findings } = await run([
      read({ userId: "bob", contentRange: "0-6/*" }),
      read({ userId: "bob", contentRange: "0-7/*" }),
    ]);
    expect(findings).toMatchObject([{ visibleAtLeast: 8, ceiling: 7 }]);
  });

  it("works on the tenants table itself", async () => {
    const { findings } = await run([
      read({ table: "orgs", contentRange: "0-0/*" }),
      read({ table: "orgs", contentRange: "0-1/*" }),
    ]);
    expect(findings).toMatchObject([
      { kind: "crossed", table: "orgs", visibleAtLeast: 2, ceiling: 1 },
    ]);
  });

  it("holds back to unconfirmed for a user with no membership rows", async () => {
    const { summary, findings } = await run([
      read({ userId: "carol", contentRange: "0-0/*" }),
    ]);
    expect(findings).toMatchObject([{ kind: "unconfirmed", ceiling: 0 }]);
    expect([...summary.usersWithoutMembership]).toEqual(["carol"]);
  });

  it("skips reads with no rows or an unreadable range, without counting", async () => {
    const { findings, countCalls } = await run([
      read({ contentRange: "*/*" }),
      read({ contentRange: "" }),
      read({ contentRange: "*/40" }),
    ]);
    expect(findings).toEqual([]);
    expect(countCalls).toEqual([]);
  });

  it("counts each table and tenant once across the run", async () => {
    // One entry per batch, so the cache has to carry across batches.
    const { countCalls } = await run(
      [
        read({ contentRange: "0-0/*" }),
        read({ contentRange: "0-1/*" }),
        read({ userId: "bob", contentRange: "0-0/*" }),
      ],
      1,
    );
    expect(countCalls).toEqual([
      ["projects", ["org-a"]],
      ["projects", ["org-b"]],
    ]);
  });

  it("reports both checks when one read trips both", async () => {
    const { summary } = await run([
      read({ search: "?id=eq.p-b1", contentRange: "0-2/*" }),
    ]);
    expect(summary.findings.map((f) => [f.check, f.kind])).toEqual([
      ["named-tenant", "crossed"],
      ["row-ceiling", "crossed"],
    ]);
    const text = formatText(summary, {
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2026-01-02T00:00:00Z"),
    });
    expect(text).toContain("Data crossed tenants: 1\n");
  });

  it("holds back to unconfirmed when the table holds no rows in the caller's tenants", async () => {
    // Most often the read-only role has no RLS policy on the table.
    const { summary, findings } = await run([
      read({ table: "tasks", contentRange: "0-4/*" }),
    ]);
    expect(findings).toMatchObject([
      { kind: "unconfirmed", ceiling: 0, memberTenants: ["org-a"] },
    ]);
    expect([...summary.tablesWithEmptyCeiling]).toEqual(["tasks"]);
    expect([...summary.usersWithoutMembership]).toEqual([]);
  });
});
