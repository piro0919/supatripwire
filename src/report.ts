import { VISIBILITY_TEXT } from "./access.js";
import { coverageGaps } from "./coverage.js";
import type { CheckSummary, Finding } from "./findings.js";

const DAY_MS = 86_400_000;

const ORDER = { crossed: 0, unconfirmed: 1, attempt: 2 } as const;

const HEADINGS = {
  crossed: "Data crossed tenants",
  unconfirmed: "Points at another tenant, not proven",
  attempt: "Another tenant named, nothing returned",
} as const;

export function formatText(
  summary: CheckSummary,
  range: { from: Date; to: Date },
): string {
  const lines: string[] = [];
  lines.push(
    `supatripwire — ${range.from.toISOString()} to ${range.to.toISOString()}`,
  );
  lines.push(`Signed-in reads scanned: ${summary.readsScanned}`);
  if (summary.firstReadAt && summary.lastReadAt) {
    lines.push(
      `  found from ${summary.firstReadAt} to ${summary.lastReadAt} (UTC)`,
    );
    const firstAt = Date.parse(`${summary.firstReadAt}Z`);
    if (firstAt - range.from.getTime() > DAY_MS) {
      lines.push(
        "  Nothing before that. Either nothing was read, or those logs are no longer",
      );
      lines.push("  kept. This is not a coverage gap, even with --strict.");
    }
  } else {
    lines.push(
      "  None found. Either nothing was read, or the logs for this range are no",
    );
    lines.push(
      "  longer kept: the logs API returns an empty result for both. Nothing was checked.",
    );
  }
  if (summary.readsScanned > 0) {
    const checked =
      summary.readsScanned -
      summary.readsOnIgnoredTables -
      summary.readsOnUnmappedTables -
      summary.readsWithoutRowCount;
    lines.push(`  fully checked: ${checked}`);
    lines.push(
      `  on tables missing from the config: ${summary.readsOnUnmappedTables}`,
    );
    lines.push(`  without a row count: ${summary.readsWithoutRowCount}`);
    lines.push(
      `  on tables the config ignores: ${summary.readsOnIgnoredTables}${formatCounts(summary.ignoredTables)}`,
    );
  }

  const sorted = [...summary.findings].sort(
    (a, b) =>
      ORDER[a.kind] - ORDER[b.kind] || a.timestamp.localeCompare(b.timestamp),
  );
  for (const kind of ["crossed", "unconfirmed", "attempt"] as const) {
    const group = sorted.filter((f) => f.kind === kind);
    // A read both checks flag is listed twice but counted once.
    const reads = new Set(group.map((f) => f.logId)).size;
    lines.push("");
    lines.push(`${HEADINGS[kind]}: ${reads}`);
    for (const f of group) lines.push(...formatFinding(f));
  }

  if (summary.unmappedTables.size > 0) {
    lines.push("");
    lines.push(
      `Not checked — ${summary.readsOnUnmappedTables} reads on tables missing from the config:`,
    );
    const tables = [...summary.unmappedTables].sort((a, b) => b[1] - a[1]);
    for (const [table, count] of tables) lines.push(`  ${table} (${count})`);
  }

  if (summary.tablesWithoutRowCount.size > 0) {
    lines.push("");
    lines.push(
      `Not fully checked — ${summary.readsWithoutRowCount} successful reads logged no readable row count (content_range):`,
    );
    const tables = [...summary.tablesWithoutRowCount].sort(
      (a, b) => b[1] - a[1],
    );
    for (const [table, count] of tables) lines.push(`  ${table} (${count})`);
    lines.push(
      "  Check 2 cannot judge them, and check 1 cannot call them crossed.",
    );
  }

  if (summary.usersWithoutMembership.size > 0) {
    lines.push("");
    lines.push(
      `Warning — ${summary.usersWithoutMembership.size} users in the findings have no membership rows.`,
    );
    lines.push(
      "  Their reads are never reported as crossed. If this is most users, check",
    );
    lines.push(
      "  membership.userColumn holds the auth user id, and that the read-only role",
    );
    lines.push("  can see the rows (RLS policy for the role).");
  }

  if (summary.tablesWithEmptyCeiling.size > 0) {
    lines.push("");
    lines.push(
      `Warning — rows came back from tables that hold none in the caller's tenants: ${[...summary.tablesWithEmptyCeiling].sort().join(", ")}.`,
    );
    lines.push(
      "  Those reads are not reported as crossed. Check that the read-only role can",
    );
    lines.push("  see the table's rows (RLS policy for the role).");
  }

  if (summary.tablesWithLimitedVisibility.size > 0) {
    lines.push("");
    lines.push(
      "Warning — the read-only role may not see every row of these tables (from the catalog):",
    );
    const tables = [...summary.tablesWithLimitedVisibility].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    for (const [table, visibility] of tables) {
      lines.push(`  ${table}: ${VISIBILITY_TEXT[visibility]}`);
    }
    if (summary.crossedHeldBack > 0) {
      lines.push(
        `  ${summary.crossedHeldBack} findings would be "data crossed" but are held back; the run exits with 3.`,
      );
    }
    lines.push(
      "  Findings that depend on them are not reported as crossed. Give the role a",
    );
    lines.push(
      "  `for select to <role> using (true)` policy on each; `supatripwire doctor` checks it.",
    );
  }

  const gaps = coverageGaps(summary);
  if (gaps.length > 0) {
    lines.push("");
    lines.push(`Coverage gaps: ${gaps.join(", ")}.`);
    lines.push(
      "  With --strict, a run with gaps and no crossed data exits with status 3.",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** ` (countries 12, rpc 3)`, most reads first; empty for no entries. */
function formatCounts(counts: Map<string, number>): string {
  if (counts.size === 0) return "";
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  return ` (${sorted.map(([name, n]) => `${name} ${n}`).join(", ")})`;
}

const CHECK_LABELS = {
  "named-tenant": "named another tenant",
  "row-ceiling": "more rows than their tenants hold",
} as const;

function formatFinding(f: Finding): string[] {
  const evidence =
    f.check === "named-tenant"
      ? `    named tenants not theirs: ${f.foreignTenants.join(", ")}`
      : `    saw at least ${f.visibleAtLeast} rows; their tenants hold ${f.ceiling}`;
  return [
    `  ${f.timestamp}  ${f.table}  user ${f.userId}  (${CHECK_LABELS[f.check]})`,
    `    rows: ${f.rows ?? "unknown"}  status: ${f.status}  log id: ${f.logId}`,
    evidence,
    `    their tenants: ${f.memberTenants.length > 0 ? f.memberTenants.join(", ") : "(none)"}`,
    `    query: ${f.search}`,
  ];
}

export function formatJson(
  summary: CheckSummary,
  range: { from: Date; to: Date },
): string {
  return `${JSON.stringify(
    {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      readsScanned: summary.readsScanned,
      firstReadAt: summary.firstReadAt,
      lastReadAt: summary.lastReadAt,
      coverageGaps: coverageGaps(summary),
      readsWithoutRowCount: summary.readsWithoutRowCount,
      tablesWithoutRowCount: Object.fromEntries(summary.tablesWithoutRowCount),
      readsOnIgnoredTables: summary.readsOnIgnoredTables,
      ignoredTables: Object.fromEntries(summary.ignoredTables),
      readsOnUnmappedTables: summary.readsOnUnmappedTables,
      unmappedTables: Object.fromEntries(summary.unmappedTables),
      usersWithoutMembership: [...summary.usersWithoutMembership].sort(),
      tablesWithEmptyCeiling: [...summary.tablesWithEmptyCeiling].sort(),
      tablesWithLimitedVisibility: Object.fromEntries(
        summary.tablesWithLimitedVisibility,
      ),
      crossedHeldBack: summary.crossedHeldBack,
      findings: summary.findings,
    },
    null,
    2,
  )}\n`;
}
