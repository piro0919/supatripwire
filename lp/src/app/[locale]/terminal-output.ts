/*
 * What the terminals on the page show. Not written by hand: the lines are what the CLI's own
 * `formatText` and `runDoctor` printed for made-up input — random uuids, a throwaway local
 * Postgres with the README's column-granted role, and a stubbed logs API. No data from a real
 * project. If the report's wording changes, print them again and paste the result here.
 */

export const CHECK_COMMAND = "npx supatripwire check --since 24h";

export const CHECK_REPORT = [
  "supatripwire — 2026-11-25T05:00:00.000Z to 2026-11-26T05:00:00.000Z",
  "Signed-in reads scanned: 1284",
  "  found from 2026-11-25 05:00:12 to 2026-11-26 04:58:40 (UTC)",
  "  fully checked: 1243",
  "  on tables missing from the config: 0",
  "  without a row count: 0",
  "  on tables the config ignores: 41 (countries 41)",
  "",
  "Data crossed tenants: 2",
  "  2026-11-26 03:12:08  projects  user 2d9a7c41-8e3b-4f06-b5d2-91a0c6e4f378  (named another tenant)",
  "    rows: 3  status: 200  log id: a41f0c9e-63d2-4b8a-9f17-5e2c08d3b6a1",
  "    named tenants not theirs: b83e5d10-27c4-4f9a-a6e1-3c9d0f4e7b52",
  "    their tenants: 6f1c2a9e-4b7d-4e21-9c3a-0d5e8f7b2a14",
  "    query: ?select=*&org_id=eq.b83e5d10-27c4-4f9a-a6e1-3c9d0f4e7b52",
  "  2026-11-26 03:14:51  tasks  user 2d9a7c41-8e3b-4f06-b5d2-91a0c6e4f378  (more rows than their tenants hold)",
  "    rows: 50  status: 200  log id: c7e2b815-0f4a-4d39-8c6e-2a91f5d0e743",
  "    saw at least 50 rows; their tenants hold 12",
  "    their tenants: 6f1c2a9e-4b7d-4e21-9c3a-0d5e8f7b2a14",
  "    query: ?select=*&order=created_at.desc&limit=50",
  "",
  "Points at another tenant, not proven: 0",
  "",
  "Another tenant named, nothing returned: 1",
  "  2026-11-26 03:20:33  tasks  user 2d9a7c41-8e3b-4f06-b5d2-91a0c6e4f378  (named another tenant)",
  "    rows: 0  status: 200  log id: e05d9a3c-71b8-4f62-a4d0-8c3e1b67f259",
  "    named tenants not theirs: b83e5d10-27c4-4f9a-a6e1-3c9d0f4e7b52",
  "    their tenants: 6f1c2a9e-4b7d-4e21-9c3a-0d5e8f7b2a14",
  "    query: ?select=*&org_id=eq.b83e5d10-27c4-4f9a-a6e1-3c9d0f4e7b52",
];

/** Where the parts of the report start, by their line in CHECK_REPORT. */
const CROSSED_HEADING = CHECK_REPORT.indexOf("Data crossed tenants: 2");
const LINES_PER_FINDING = 5;
const FIRST_FINDING = CROSSED_HEADING + 1;
const SECOND_FINDING = FIRST_FINDING + LINES_PER_FINDING;
const AFTER_CROSSED = SECOND_FINDING + LINES_PER_FINDING;

/** The hero shows the report down to the end of the crossed findings. */
export const HERO_REPORT = CHECK_REPORT.slice(0, AFTER_CROSSED);

/** Check 1: the heading and the first crossed finding. */
export const NAMED_TENANT_EXCERPT = CHECK_REPORT.slice(CROSSED_HEADING, SECOND_FINDING);

/** Check 2: the heading and the second crossed finding. */
export const ROW_CEILING_EXCERPT = [
  CHECK_REPORT[CROSSED_HEADING] ?? "",
  ...CHECK_REPORT.slice(SECOND_FINDING, AFTER_CROSSED),
];

export const DOCTOR_COMMAND = "npx supatripwire doctor";

export const DOCTOR_REPORT = [
  "Database: connected as supatripwire",
  "  ✓ memberships: sees every row",
  "  ✓ projects: sees every row",
  "  ✓ tasks: sees every row",
  "Logs API: ✓ reachable; signed-in reads found in the last hour",
  "",
  "Not checked: whether the config matches your app — which column holds the tenant,",
  "and whether the membership table is complete. Confirm those yourself.",
];
