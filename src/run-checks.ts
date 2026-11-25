import { evaluateNamedTenant } from "./check-named-tenant.js";
import { evaluateRowCeiling } from "./check-row-ceiling.js";
import type { Config } from "./config.js";
import type { TenantDirectory } from "./directory.js";
import type { CheckSummary } from "./findings.js";
import type { ReadLogEntry } from "./logs.js";
import { Lookups } from "./lookups.js";

const DEFAULT_BATCH_SIZE = 500;

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
        evaluateRowCeiling(entry, lookups),
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
    if (!config.tables[entry.table]) {
      summary.readsOnUnmappedTables++;
      summary.unmappedTables.set(
        entry.table,
        (summary.unmappedTables.get(entry.table) ?? 0) + 1,
      );
      continue;
    }
    batch.push(entry);
    if (batch.length >= batchSize) await flush();
  }
  await flush();
  return summary;
}
