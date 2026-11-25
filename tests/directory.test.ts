import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { createPgDirectory, type TenantDirectory } from "../src/directory.js";
import { fetchReadLogs } from "../src/logs.js";
import { runChecks } from "../src/run-checks.js";

/**
 * Runs against a real Postgres. CI provides one; locally, point
 * SUPATRIPWIRE_TEST_DATABASE_URL at a throwaway database you can create roles in.
 * The test builds its own schema and a read-only role with column-level grants
 * only, as the README tells users to.
 */
const adminUrl = process.env.SUPATRIPWIRE_TEST_DATABASE_URL;

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const USER_1 = "10000000-0000-4000-8000-000000000001";
const USER_2 = "10000000-0000-4000-8000-000000000002";
const PROJECT_A = "20000000-0000-4000-8000-00000000000a";
const PROJECT_B = "20000000-0000-4000-8000-00000000000b";

const config = parseConfig({
  projectRef: "abcdefghijklmnopqrst",
  membership: {
    table: "memberships",
    userColumn: "user_id",
    tenantColumn: "org_id",
  },
  tables: {
    projects: { tenantColumn: "org_id" },
    tickets: { tenantColumn: "org_id" },
  },
});

describe.skipIf(!adminUrl)("createPgDirectory against Postgres", () => {
  let admin: pg.Client;
  let directory: TenantDirectory;
  const schema = `supatripwire_test_${process.pid}`;
  const role = `supatripwire_reader_${process.pid}`;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`
      create schema ${schema};
      set search_path = ${schema};
      create table memberships (user_id uuid not null, org_id uuid not null, note text);
      create table projects (id uuid primary key, org_id uuid not null, name text);
      create table tickets (id bigint primary key, org_id uuid not null, body text);
      insert into memberships values ('${USER_1}', '${ORG_A}', 'secret'), ('${USER_2}', '${ORG_A}', null), ('${USER_2}', '${ORG_B}', null);
      insert into projects values ('${PROJECT_A}', '${ORG_A}', 'secret'), ('${PROJECT_B}', '${ORG_B}', 'secret');
      insert into tickets values (7, '${ORG_B}', 'secret');
      create role ${role} login password 'pw';
      grant usage on schema ${schema} to ${role};
      grant select (user_id, org_id) on memberships to ${role};
      grant select (id, org_id) on projects to ${role};
      grant select (id, org_id) on tickets to ${role};
      -- As on Supabase: RLS on, with a select policy for the read-only role.
      alter table memberships enable row level security;
      alter table projects enable row level security;
      alter table tickets enable row level security;
      create policy reader on memberships for select to ${role} using (true);
      create policy reader on projects for select to ${role} using (true);
      create policy reader on tickets for select to ${role} using (true);
      alter role ${role} set search_path = ${schema};
    `);
    const url = new URL(adminUrl as string);
    url.username = role;
    url.password = "pw";
    directory = createPgDirectory(url.toString(), config);
  });

  afterAll(async () => {
    await directory?.close();
    await admin?.query(
      `drop schema if exists ${schema} cascade; drop role if exists ${role};`,
    );
    await admin?.end();
  });

  it("returns each user's tenants, and an empty set for a user with none", async () => {
    const result = await directory.membershipsOf([
      USER_1,
      USER_2,
      "30000000-0000-4000-8000-000000000003",
    ]);
    expect([...(result.get(USER_1) ?? [])]).toEqual([ORG_A]);
    expect([...(result.get(USER_2) ?? [])].sort()).toEqual([ORG_A, ORG_B]);
    expect(result.get("30000000-0000-4000-8000-000000000003")?.size).toBe(0);
  });

  it("maps uuid ids to tenants, keyed by the spelling in the log", async () => {
    const upper = PROJECT_B.toUpperCase();
    const result = await directory.tenantsOfRows("projects", [
      PROJECT_A,
      upper,
      "20000000-0000-4000-8000-0000000000ff",
    ]);
    expect(Object.fromEntries(result)).toEqual({
      [PROJECT_A]: ORG_A,
      [upper]: ORG_B,
    });
  });

  it("canonicalizes tenant ids by the membership column's type", async () => {
    const result = await directory.canonicalTenantIds([
      ORG_A.toUpperCase(),
      "not-a-uuid",
      ORG_B,
    ]);
    expect(Object.fromEntries(result)).toEqual({
      [ORG_A.toUpperCase()]: ORG_A,
      [ORG_B]: ORG_B,
    });
  });

  it("counts rows per tenant with only column grants and RLS on", async () => {
    const projects = await directory.rowCounts("projects", [
      ORG_A,
      ORG_B,
      "00000000-0000-4000-8000-0000000000ff",
    ]);
    expect(Object.fromEntries(projects)).toEqual({
      [ORG_A]: 1,
      [ORG_B]: 1,
      "00000000-0000-4000-8000-0000000000ff": 0,
    });
    const tickets = await directory.rowCounts("tickets", [ORG_A, ORG_B]);
    expect(Object.fromEntries(tickets)).toEqual({ [ORG_A]: 0, [ORG_B]: 1 });
  });

  it("keeps the other values typed when one does not parse", async () => {
    // As text, `3F2A…` would not match the uuid column and count 0.
    const counts = await directory.rowCounts("projects", [
      ORG_A.toUpperCase(),
      "",
      ORG_B,
    ]);
    expect(Object.fromEntries(counts)).toEqual({
      [ORG_A.toUpperCase()]: 1,
      "": 0,
      [ORG_B]: 1,
    });
    const rows = await directory.tenantsOfRows("projects", [
      "not-a-uuid",
      PROJECT_B.toUpperCase(),
    ]);
    expect(Object.fromEntries(rows)).toEqual({
      [PROJECT_B.toUpperCase()]: ORG_B,
    });
  });

  it("maps integer ids", async () => {
    const result = await directory.tenantsOfRows("tickets", ["7", "8"]);
    expect(Object.fromEntries(result)).toEqual({ "7": ORG_B });
  });

  it("falls back to text comparison when a value is not of the column's type", async () => {
    const result = await directory.tenantsOfRows("projects", [
      "not-a-uuid",
      PROJECT_A,
    ]);
    expect(Object.fromEntries(result)).toEqual({ [PROJECT_A]: ORG_A });
    const big = await directory.tenantsOfRows("tickets", [
      "99999999999999999999",
      "7",
    ]);
    expect(Object.fromEntries(big)).toEqual({ "7": ORG_B });
  });

  it("runs check 1 end to end: logs API → database → findings", async () => {
    const logRows = [
      // USER_1 (org A) reads org B's project and gets it back: crossed.
      logRow(
        1,
        USER_1,
        "/rest/v1/projects",
        `?select=*&id=eq.${PROJECT_B}`,
        "0-0/*",
      ),
      // USER_1 asks for org B's tickets and gets nothing: attempt.
      logRow(2, USER_1, "/rest/v1/tickets", `?org_id=eq.${ORG_B}`, "*/*"),
      // USER_2 belongs to both orgs: nothing to report.
      logRow(3, USER_2, "/rest/v1/projects", `?id=eq.${PROJECT_B}`, "0-0/*"),
      // USER_1 lists projects unfiltered and gets 2; org A holds 1: crossed.
      logRow(4, USER_1, "/rest/v1/projects", "?select=id", "0-1/*"),
      // USER_2 does the same; orgs A and B hold 2 between them: fine.
      logRow(5, USER_2, "/rest/v1/projects", "?select=id", "0-1/*"),
    ];
    const fetchFn = (async () =>
      new Response(JSON.stringify({ result: logRows }), {
        status: 200,
      })) as unknown as typeof fetch;

    const summary = await runChecks(
      fetchReadLogs({
        projectRef: config.projectRef,
        accessToken: "token",
        from: new Date("2026-01-01T00:00:00Z"),
        to: new Date("2026-01-01T01:00:00Z"),
        fetch: fetchFn,
      }),
      config,
      directory,
    );
    expect(summary.readsScanned).toBe(5);
    expect(summary.findings.map((f) => [f.check, f.kind, f.table])).toEqual([
      ["named-tenant", "crossed", "projects"],
      ["named-tenant", "attempt", "tickets"],
      ["row-ceiling", "crossed", "projects"],
    ]);
  });
});

function logRow(
  n: number,
  userId: string,
  path: string,
  search: string,
  contentRange: string,
) {
  return {
    timestamp: `2026-01-01T00:00:0${n}.000000`,
    id: `00000000-0000-0000-0000-00000000000${n}`,
    user_id: userId,
    path,
    // Supabase logs the search string URL-encoded.
    search: search.replace(/,/g, "%2C"),
    content_range: contentRange,
    status: "200",
  };
}
