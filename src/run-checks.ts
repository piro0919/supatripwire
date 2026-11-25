import { evaluateNamedTenant } from "./check-named-tenant.js";
import { evaluateRowCeiling } from "./check-row-ceiling.js";
import type { Config } from "./config.js";
import { rowsReturned } from "./content-range.js";
import type { TenantDirectory } from "./directory.js";
import type { CheckSummary } from "./findings.js";
import type { ReadLogEntry } from "./logs.js";
import { Lookups } from "./lookups.js";

const DEFAULT_BATCH_SIZE = 500;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;

/**
 * Runs both checks over the log entries in one pass.
 *
 * Entries are processed in batches so membership, id and count lookups are
 * grouped into a few queries; results are cached for the whole run. A read
 * can produce one finding from each check.
 */
export async function runChecks(
  entries: AsyncIterable<ReadLogEntry> | Iterable<ReadLogEntry>,
  config: Config,
  directory: TenantDirectory,
  options: { batchSize?: number } = {},
): Promise<CheckSummary> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const lookups = new Lookups(config, directory);
  const summary: CheckSummary = {
    findings: [],
    readsScanned: 0,
    firstReadAt: null,
    lastReadAt: null,
    readsWithoutRowCount: 0,
    tablesWithoutRowCount: new Map(),
    readsOnUnmappedTables: 0,
    unmappedTables: new Map(),
    usersWithoutMembership: new Set(),
    tablesWithEmptyCeiling: new Set(),
  };

  let batch: ReadLogEntry[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    await lookups.prefetch(batch);
    for (const entry of batch) {
      for (const finding of [
        evaluateNamedTenant(entry, config, lookups),
        evaluateRowCeiling(entry, config, lookups),
      ]) {
        if (!finding) continue;
        summary.findings.push(finding);
        if (finding.memberTenants.length === 0) {
          summary.usersWithoutMembership.add(finding.userId);
        } else if (finding.check === "row-ceiling" && finding.ceiling === 0) {
          summary.tablesWithEmptyCeiling.add(finding.table);
        }
      }
    }
    batch = [];
  };

  for await (const entry of entries) {
    summary.readsScanned++;
    // Entries come oldest first.
    summary.firstReadAt ??= entry.timestamp;
    summary.lastReadAt = entry.timestamp;
    if (!config.tables[entry.table]) {
      summary.readsOnUnmappedTables++;
      increment(summary.unmappedTables, entry.table);
      continue;
    }
    // An error response returned no rows, so it has nothing to judge.
    const succeeded =
      entry.status >= HTTP_OK_MIN && entry.status <= HTTP_OK_MAX;
    if (succeeded && rowsReturned(entry.contentRange) === null) {
      summary.readsWithoutRowCount++;
      increment(summary.tablesWithoutRowCount, entry.table);
    }
    batch.push(entry);
    if (batch.length >= batchSize) await flush();
  }
  await flush();
  return summary;
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
