import type { CheckSummary } from "./findings.js";

/**
 * Something that kept the run from checking every read it found, or that
 * suggests the setup is wrong. "No findings" means less while any is present.
 *
 * - `no-reads` — no signed-in reads in the range outside the config's
 *   `ignore`. Nothing was read, or the logs for the range are no longer kept:
 *   the logs API returns an empty result, not an error, either way.
 * - `unmapped-tables` — reads on tables missing from the config.
 * - `no-row-count` — successful reads whose `content_range` was unreadable.
 * - `users-without-membership` — users in findings with no membership rows.
 * - `empty-ceiling` — tables that returned rows yet hold none in the caller's
 *   tenants, as the read-only role sees them.
 * - `limited-visibility` — by the catalog, the read-only role may not see
 *   every row of a table the checks read (or the table does not resolve).
 */
export type CoverageGap =
  | "no-reads"
  | "unmapped-tables"
  | "no-row-count"
  | "users-without-membership"
  | "empty-ceiling"
  | "limited-visibility";

export const EXIT_CLEAN = 0;
export const EXIT_CROSSED = 1;
export const EXIT_COVERAGE_GAPS = 3;

/**
 * The CLI's exit status for a finished run. Crossed data outranks coverage
 * gaps, and gaps fail the run only when `strict` asks for it.
 */
export function exitCode(summary: CheckSummary, strict: boolean): number {
  if (summary.findings.some((f) => f.kind === "crossed")) return EXIT_CROSSED;
  if (strict && coverageGaps(summary).length > 0) return EXIT_COVERAGE_GAPS;
  return EXIT_CLEAN;
}

export function coverageGaps(summary: CheckSummary): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  // Reads on ignored names were never going to be checked.
  if (summary.readsScanned - summary.readsOnIgnoredTables === 0)
    gaps.push("no-reads");
  if (summary.readsOnUnmappedTables > 0) gaps.push("unmapped-tables");
  if (summary.readsWithoutRowCount > 0) gaps.push("no-row-count");
  if (summary.usersWithoutMembership.size > 0)
    gaps.push("users-without-membership");
  if (summary.tablesWithEmptyCeiling.size > 0) gaps.push("empty-ceiling");
  if (summary.tablesWithLimitedVisibility.size > 0)
    gaps.push("limited-visibility");
  return gaps;
}
