import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectAccess } from "../src/access.js";
import { parseConfig } from "../src/config.js";
import { runDoctor } from "../src/doctor.js";

/**
 * Runs against a real Postgres, like directory.test.ts: each table gets the
 * RLS setup whose visibility the catalog check must name.
 */
const adminUrl = process.env.SUPATRIPWIRE_TEST_DATABASE_URL;

const tables = {
  open_all: "all", // using (true) for the role
  no_rls: "all", // RLS off
  via_group: "all", // using (true) for a role the reader is a member of
  public_all: "all", // for all to public using (true)
  no_policy: "none", // RLS on, nothing for the role
  other_role: "none", // RLS on, policy for someone else
  narrowed: "partial", // using (org_id = …)
  restricted: "partial", // using (true), but a restrictive policy narrows it
} as const;

const config = parseConfig({
  projectRef: "abcdefghijklmnopqrst",
  membership: {
    table: "open_all",
    userColumn: "id",
    tenantColumn: "org_id",
  },
  tables: {
    ...Object.fromEntries(
      Object.keys(tables).map((t) => [t, { tenantColumn: "org_id" }]),
    ),
    no_such_table: { tenantColumn: "org_id" },
    hidden_column: { tenantColumn: "org_id" },
  },
});

describe.skipIf(!adminUrl)("inspectAccess against Postgres", () => {
  let admin: pg.Client;
  let reader: pg.Pool;
  let readerUrl: string;
  const schema = `supatripwire_access_${process.pid}`;
  const role = `supatripwire_access_reader_${process.pid}`;
  const group = `supatripwire_access_group_${process.pid}`;
  const other = `supatripwire_access_other_${process.pid}`;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    const ddl = [
      `create schema ${schema}`,
      `set search_path = ${schema}`,
      `create role ${role} login password 'pw'`,
      `create role ${group}`,
      `create role ${other}`,
      `grant ${group} to ${role}`,
      `grant usage on schema ${schema} to ${role}`,
      `alter role ${role} set search_path = ${schema}`,
    ];
    for (const t of [...Object.keys(tables), "hidden_column"]) {
      ddl.push(`create table ${t} (id int primary key, org_id int, note text)`);
      ddl.push(`grant select (id, org_id) on ${t} to ${role}`);
      if (t !== "no_rls")
        ddl.push(`alter table ${t} enable row level security`);
    }
    ddl.push(
      `revoke select (org_id) on hidden_column from ${role}`,
      `create policy p on hidden_column for select to ${role} using (true)`,
      `create policy p on open_all for select to ${role} using (true)`,
      `create policy p on via_group for select to ${group} using (true)`,
      `create policy p on public_all for all to public using (true)`,
      `create policy p on other_role for select to ${other} using (true)`,
      `create policy p on narrowed for select to ${role} using (org_id = 1)`,
      `create policy p on restricted for select to ${role} using (true)`,
      `create policy r on restricted as restrictive for select to ${role} using (org_id < 5)`,
    );
    await admin.query(ddl.join(";\n"));
    const url = new URL(adminUrl as string);
    url.username = role;
    url.password = "pw";
    readerUrl = url.toString();
    reader = new pg.Pool({ connectionString: readerUrl, max: 1 });
  });

  afterAll(async () => {
    await reader?.end();
    await admin?.query(
      `drop schema if exists ${schema} cascade; drop role if exists ${role}; drop role if exists ${group}; drop role if exists ${other};`,
    );
    await admin?.end();
  });

  it("names what the role can see of each table", async () => {
    const access = await inspectAccess(reader, config);
    const byTable = Object.fromEntries(
      access.map((a) => [a.table, a.visibility]),
    );
    expect(byTable).toEqual({
      ...tables,
      no_such_table: "missing",
      hidden_column: "all",
    });
  });

  it("names columns that are missing or not readable", async () => {
    const withMissing = parseConfig({
      ...config,
      tables: { open_all: { tenantColumn: "tenant", idColumn: "id" } },
    });
    const [membership] = await inspectAccess(reader, withMissing);
    expect(membership?.missingColumns).toEqual(["tenant"]);
    const hidden = (await inspectAccess(reader, config)).find(
      (a) => a.table === "hidden_column",
    );
    expect(hidden?.unreadableColumns).toEqual(["org_id"]);
  });

  it("doctor fails on any table the role cannot fully see, and says what it cannot check", async () => {
    const result = await runDoctor({ config, databaseUrl: readerUrl });
    expect(result.ok).toBe(false);
    const text = result.lines.join("\n");
    expect(text).toContain(`Database: connected as ${role}`);
    expect(text).toContain("✓ open_all: sees every row");
    expect(text).toContain("✗ narrowed: may see only some rows");
    expect(text).toContain("✗ no_policy: sees no rows");
    expect(text).toContain("✗ no_such_table: not found");
    expect(text).toContain("no SELECT on column org_id");
    expect(text).toContain("Logs API: ✗ SUPABASE_ACCESS_TOKEN is not set");
    expect(text).toContain("Not checked: whether the config matches your app");
  });

  it("doctor passes a correct setup", async () => {
    const good = parseConfig({
      ...config,
      tables: { open_all: { tenantColumn: "org_id" } },
    });
    const result = await runDoctor({
      config: good,
      databaseUrl: readerUrl,
      accessToken: "token",
      fetch: async () =>
        new Response(JSON.stringify({ result: [] }), { status: 200 }),
    });
    expect(result.lines.join("\n")).toContain("Logs API: ✓ reachable");
    expect(result.ok).toBe(true);
  });
});
