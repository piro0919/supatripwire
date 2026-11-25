import pg from "pg";
import {
  type FullAccessReason,
  inspectAccess,
  type TableAccess,
  VISIBILITY_TEXT,
} from "./access.js";
import type { Config } from "./config.js";
import { fetchReadLogs } from "./logs.js";

const HOUR_MS = 3_600_000;

export type DoctorResult = {
  /** Lines to print. */
  lines: string[];
  /** True when nothing needs fixing. */
  ok: boolean;
};

export type DoctorOptions = {
  config: Config;
  databaseUrl: string;
  /** Without it, the logs API is not tried. */
  accessToken?: string;
  fetch?: typeof globalThis.fetch;
  now?: Date;
};

/**
 * Full access that comes from the role rather than a policy also lets it read
 * every column, against the column-granted role the README asks for.
 */
const BROAD_ROLE: Partial<Record<FullAccessReason, string>> = {
  owner:
    "the role holds the table owner's privileges, so column grants do not limit it",
  bypassrls:
    "the role has BYPASSRLS; drop it and give a `using (true)` policy instead",
};

/**
 * Checks the setup the way `check` will use it: the read-only role, the
 * tables and columns the config names, what RLS lets the role see, and the
 * logs API. Reads only the catalog and at most one log line; never table rows.
 *
 * It cannot tell whether the config describes the app's authorization
 * correctly — which column really holds the tenant, or whether membership is
 * complete. Those stay the user's to confirm.
 */
export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const lines: string[] = [];
  let ok = true;

  const pool = new pg.Pool({
    connectionString: options.databaseUrl,
    max: 1,
  });
  try {
    const who = await pool.query<{ user: string; superuser: boolean }>(
      "select current_user as user, rolsuper as superuser from pg_roles where rolname = current_user",
    );
    const role = who.rows[0];
    lines.push(`Database: connected as ${role?.user ?? "(unknown)"}`);
    if (role?.superuser) {
      ok = false;
      lines.push(
        "  ✗ the role is a superuser. Use a role that can read only the id and tenant columns.",
      );
    }
    const access = await inspectAccess(pool, options.config);
    for (const table of access) {
      const problems = columnProblems(table);
      const broad = table.reason ? BROAD_ROLE[table.reason] : undefined;
      if (broad) problems.push(broad);
      if (table.error) problems.push(table.error);
      const good = table.visibility === "all" && problems.length === 0;
      if (!good) ok = false;
      lines.push(
        `  ${good ? "✓" : "✗"} ${table.table}: ${VISIBILITY_TEXT[table.visibility]}`,
      );
      for (const p of problems) lines.push(`      ${p}`);
    }
  } catch (error) {
    ok = false;
    lines.push(`Database: ✗ ${(error as Error).message}`);
  } finally {
    await pool.end();
  }

  if (!options.accessToken) {
    ok = false;
    lines.push("Logs API: ✗ SUPABASE_ACCESS_TOKEN is not set");
  } else {
    const to = options.now ?? new Date();
    try {
      let found = false;
      for await (const _ of fetchReadLogs({
        projectRef: options.config.projectRef,
        accessToken: options.accessToken,
        from: new Date(to.getTime() - HOUR_MS),
        to,
        pageSize: 1,
        fetch: options.fetch,
      })) {
        found = true;
        break;
      }
      lines.push(
        found
          ? "Logs API: ✓ reachable; signed-in reads found in the last hour"
          : "Logs API: ✓ reachable; no signed-in reads in the last hour (fine if the project was quiet)",
      );
    } catch (error) {
      ok = false;
      lines.push(`Logs API: ✗ ${(error as Error).message}`);
    }
  }

  lines.push("");
  lines.push(
    "Not checked: whether the config matches your app — which column holds the tenant,",
  );
  lines.push(
    "and whether the membership table is complete. Confirm those yourself.",
  );
  return { lines, ok };
}

function columnProblems(table: TableAccess): string[] {
  return [
    ...table.missingColumns.map((c) => `column ${c} does not exist`),
    ...table.unreadableColumns.map((c) => `no SELECT on column ${c}`),
  ];
}
