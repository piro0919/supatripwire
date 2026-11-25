import { describe, expect, it } from "vitest";
import { checkNamedTenant } from "../src/check-named-tenant.js";
import { parseConfig } from "../src/config.js";
import type { TenantDirectory } from "../src/directory.js";
import type { ReadLogEntry } from "../src/logs.js";

// A made-up project: two orgs, each with projects, each project with tasks.
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
    tasks: { tenantColumn: "org_id", references: { project_id: "projects" } },
  },
});

const memberships: Record<string, string[]> = {
  alice: ["org-a"],
  bob: ["org-b"],
};
const rows: Record<string, Record<string, string>> = {
  projects: { "p-a1": "org-a", "p-a2": "org-a", "p-b1": "org-b" },
  tasks: { "t-a1": "org-a", "t-b1": "org-b" },
};

function fakeDirectory() {
  const calls: Array<[string, string[]]> = [];
  const directory: TenantDirectory = {
    async membershipsOf(userIds) {
      calls.push(["memberships", userIds]);
      return new Map(userIds.map((u) => [u, new Set(memberships[u] ?? [])]));
    },
    async tenantsOfRows(table, ids) {
      calls.push([table, ids]);
      const result = new Map<string, string>();
      for (const id of ids) {
        const tenant = rows[table]?.[id];
        if (tenant) result.set(id, tenant);
      }
      return result;
    },
    async canonicalTenantIds(values) {
      calls.push(["canonical", values]);
      // Tenant ids here are case-insensitive, like uuids.
      return new Map(values.map((v) => [v, v.toLowerCase()]));
    },
    async close() {},
  };
  return { directory, calls };
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

async function run(entries: ReadLogEntry[]) {
  const { directory, calls } = fakeDirectory();
  const summary = await checkNamedTenant(entries, config, directory);
  return { summary, calls };
}

describe("checkNamedTenant", () => {
  it("reports nothing when the filter names only the caller's tenant", async () => {
    const { summary } = await run([
      read({ search: "?select=*&org_id=eq.org-a", contentRange: "0-9/*" }),
      read({ search: "?select=*&id=eq.p-a1" }),
      read({ table: "tasks", search: "?project_id=in.%28p-a1%2Cp-a2%29" }),
    ]);
    expect(summary.findings).toEqual([]);
    expect(summary.readsScanned).toBe(3);
  });

  it("reports crossed when the tenant column names another tenant and rows came back", async () => {
    const { summary } = await run([
      read({ search: "?select=*&org_id=eq.org-b", contentRange: "0-2/*" }),
    ]);
    expect(summary.findings).toMatchObject([
      {
        kind: "crossed",
        rows: 3,
        foreignTenants: ["org-b"],
        memberTenants: ["org-a"],
        userId: "alice",
      },
    ]);
  });

  it("reports an attempt when another tenant is named and nothing came back", async () => {
    const { summary } = await run([
      read({ search: "?org_id=eq.org-b", contentRange: "*/*" }),
      read({ search: "?org_id=eq.org-b", contentRange: "", status: 401 }),
    ]);
    expect(summary.findings.map((f) => f.kind)).toEqual(["attempt", "attempt"]);
  });

  it("resolves the primary key to the row's tenant", async () => {
    const { summary } = await run([read({ search: "?id=eq.p-b1" })]);
    expect(summary.findings).toMatchObject([
      { kind: "crossed", foreignTenants: ["org-b"] },
    ]);
  });

  it("resolves a referencing column through the referenced table", async () => {
    const { summary } = await run([
      read({ table: "tasks", search: "?project_id=eq.p-b1&select=*" }),
    ]);
    expect(summary.findings).toMatchObject([
      { kind: "crossed", table: "tasks", foreignTenants: ["org-b"] },
    ]);
  });

  it("treats a tenants table whose id is the tenant", async () => {
    const { summary } = await run([
      read({ table: "orgs", search: "?id=eq.org-b" }),
    ]);
    expect(summary.findings).toMatchObject([
      { kind: "crossed", foreignTenants: ["org-b"] },
    ]);
  });

  it("does not call a mixed in-list crossed, since the rows may all be the caller's own", async () => {
    const { summary } = await run([
      read({ search: "?id=in.%28p-a1%2Cp-b1%29", contentRange: "0-0/*" }),
    ]);
    expect(summary.findings).toMatchObject([
      { kind: "unconfirmed", foreignTenants: ["org-b"] },
    ]);
  });

  it("calls it crossed when one filter is all foreign even if another names the caller's tenant", async () => {
    // Filters on different columns are ANDed: every row matched project_id=p-b1.
    const { summary } = await run([
      read({ table: "tasks", search: "?org_id=eq.org-a&project_id=eq.p-b1" }),
    ]);
    expect(summary.findings).toMatchObject([{ kind: "crossed" }]);
  });

  it("does not call it crossed when the row count is unknown", async () => {
    const { summary } = await run([
      read({ search: "?org_id=eq.org-b", contentRange: "" }),
    ]);
    expect(summary.findings).toMatchObject([
      { kind: "unconfirmed", rows: null },
    ]);
  });

  it("ignores ids that resolve to no row", async () => {
    const { summary } = await run([read({ search: "?id=eq.p-missing" })]);
    expect(summary.findings).toEqual([]);
  });

  it("never calls it crossed for a user with no membership, and lists the user", async () => {
    const { summary } = await run([
      read({ userId: "carol", search: "?org_id=eq.org-a" }),
    ]);
    expect(summary.findings).toMatchObject([
      { kind: "unconfirmed", memberTenants: [] },
    ]);
    expect([...summary.usersWithoutMembership]).toEqual(["carol"]);
  });

  it("compares tenant ids as the database spells them", async () => {
    const { summary } = await run([
      read({ search: "?org_id=eq.ORG-A" }),
      read({ search: "?org_id=eq.ORG-B" }),
    ]);
    expect(summary.findings).toMatchObject([
      { kind: "crossed", foreignTenants: ["org-b"] },
    ]);
  });

  it("reads a tenant named inside and=(…)", async () => {
    const { summary } = await run([
      read({ search: "?select=*&and=%28org_id.eq.org-b%29" }),
    ]);
    expect(summary.findings).toMatchObject([{ kind: "crossed" }]);
  });

  it("counts reads on tables missing from the config instead of checking them", async () => {
    const { summary, calls } = await run([
      read({ table: "invoices", search: "?org_id=eq.org-b" }),
      read({ table: "invoices" }),
    ]);
    expect(summary.findings).toEqual([]);
    expect(summary.readsOnUnmappedTables).toBe(2);
    expect(summary.unmappedTables.get("invoices")).toBe(2);
    expect(calls).toEqual([]);
  });

  it("ignores filters on columns the config does not map", async () => {
    const { summary, calls } = await run([
      read({ search: "?name=eq.org-b&status=in.%28a%2Cb%29" }),
    ]);
    expect(summary.findings).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("looks each user and id up once across the run", async () => {
    const { directory, calls } = fakeDirectory();
    await checkNamedTenant(
      [
        read({ search: "?id=eq.p-b1" }),
        read({ search: "?id=eq.p-b1" }),
        read({ search: "?id=eq.p-a1" }),
        read({ search: "?id=eq.p-b1" }),
      ],
      config,
      directory,
      { batchSize: 2 },
    );
    expect(calls).toEqual([
      ["memberships", ["alice"]],
      ["projects", ["p-b1"]],
      ["projects", ["p-a1"]],
    ]);
  });

  it("reads entries from an async source", async () => {
    async function* source() {
      yield read({ search: "?org_id=eq.org-b" });
    }
    const { directory } = fakeDirectory();
    const summary = await checkNamedTenant(source(), config, directory);
    expect(summary.findings).toHaveLength(1);
  });

  it("works when a referenced table is literally named tenant", async () => {
    const named = parseConfig({
      projectRef: "abcdefghijklmnopqrst",
      membership: {
        table: "memberships",
        userColumn: "user_id",
        tenantColumn: "org_id",
      },
      tables: {
        tenant: { tenantColumn: "org_id" },
        notes: { tenantColumn: "org_id", references: { tenant_id: "tenant" } },
      },
    });
    const directory: TenantDirectory = {
      async membershipsOf(userIds) {
        return new Map(userIds.map((u) => [u, new Set(["org-a"])]));
      },
      async tenantsOfRows(table, ids) {
        return new Map(
          table === "tenant" ? ids.map((id) => [id, "org-b"]) : [],
        );
      },
      async canonicalTenantIds(values) {
        return new Map(values.map((v) => [v, v]));
      },
      async close() {},
    };
    const summary = await checkNamedTenant(
      [read({ table: "notes", search: "?tenant_id=eq.x1" })],
      named,
      directory,
    );
    expect(summary.findings).toMatchObject([
      { kind: "crossed", foreignTenants: ["org-b"] },
    ]);
  });
});
