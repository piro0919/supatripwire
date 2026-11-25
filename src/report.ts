import type {
  NamedTenantFinding,
  NamedTenantSummary,
} from "./check-named-tenant.js";

const ORDER = { crossed: 0, unconfirmed: 1, attempt: 2 } as const;

const HEADINGS = {
  crossed: "Data crossed tenants",
  unconfirmed: "Another tenant named, rows returned, not provably foreign",
  attempt: "Another tenant named, nothing returned",
} as const;

export function formatText(
  summary: NamedTenantSummary,
  range: { from: Date; to: Date },
): string {
  const lines: string[] = [];
  lines.push(
    `supatripwire — ${range.from.toISOString()} to ${range.to.toISOString()}`,
  );
  lines.push(`Signed-in reads scanned: ${summary.readsScanned}`);

  const sorted = [...summary.findings].sort(
    (a, b) =>
      ORDER[a.kind] - ORDER[b.kind] || a.timestamp.localeCompare(b.timestamp),
  );
  for (const kind of ["crossed", "unconfirmed", "attempt"] as const) {
    const group = sorted.filter((f) => f.kind === kind);
    lines.push("");
    lines.push(`${HEADINGS[kind]}: ${group.length}`);
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

  if (summary.usersWithoutMembership.size > 0) {
    lines.push("");
    lines.push(
      `Warning — ${summary.usersWithoutMembership.size} users named a tenant but have no membership rows.`,
    );
    lines.push(
      "  Their reads are never reported as crossed. If this is most users, check",
    );
    lines.push(
      "  membership.userColumn holds the auth user id, and that the read-only role",
    );
    lines.push("  can see the rows (RLS policy for the role).");
  }
  return `${lines.join("\n")}\n`;
}

function formatFinding(f: NamedTenantFinding): string[] {
  return [
    `  ${f.timestamp}  ${f.table}  user ${f.userId}`,
    `    rows: ${f.rows ?? "unknown"}  status: ${f.status}  log id: ${f.logId}`,
    `    named tenants not theirs: ${f.foreignTenants.join(", ")}`,
    `    their tenants: ${f.memberTenants.length > 0 ? f.memberTenants.join(", ") : "(none)"}`,
    `    query: ${f.search}`,
  ];
}

export function formatJson(
  summary: NamedTenantSummary,
  range: { from: Date; to: Date },
): string {
  return `${JSON.stringify(
    {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      readsScanned: summary.readsScanned,
      readsOnUnmappedTables: summary.readsOnUnmappedTables,
      unmappedTables: Object.fromEntries(summary.unmappedTables),
      usersWithoutMembership: [...summary.usersWithoutMembership].sort(),
      findings: summary.findings,
    },
    null,
    2,
  )}\n`;
}
