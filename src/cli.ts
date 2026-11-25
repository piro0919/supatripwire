#!/usr/bin/env node
import { parseArgs } from "node:util";
import { ConfigError, loadConfig } from "./config.js";
import { exitCode } from "./coverage.js";
import { createPgDirectory } from "./directory.js";
import { fetchReadLogs, LogsApiError } from "./logs.js";
import { formatJson, formatText } from "./report.js";
import { runChecks } from "./run-checks.js";

const HELP = `Usage: supatripwire check [options]

Reads the project's API gateway logs and reports reads that named a tenant
the caller does not belong to, or saw more rows than the caller's tenants hold.

Options:
  -c, --config <path>   Config file (default: supatripwire.json)
      --since <span>    How far back to look: 30m, 6h, 7d (default: 24h)
      --from <iso>      Start of the range, instead of --since
      --to <iso>        End of the range (default: now)
      --json            Print the report as JSON
      --strict          Exit with 3 when the run has coverage gaps: no reads
                        found, reads on unconfigured tables or without a row
                        count, users without membership, or empty ceilings
  -h, --help            Show this help

Environment:
  SUPABASE_ACCESS_TOKEN       Personal access token, to read the logs
  SUPATRIPWIRE_DATABASE_URL   Connection string for the read-only role

Exit status: 0 when no data crossed, 1 when it did, 2 on error, and with
--strict, 3 when nothing crossed but the run has coverage gaps.
`;

function parseSpan(span: string): number {
  const match = /^(\d+)([mhd])$/.exec(span);
  if (!match)
    throw new ConfigError(
      `--since must look like 30m, 6h or 7d, got "${span}"`,
    );
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as "m" | "h" | "d"
  ];
  return Number(match[1]) * unit;
}

function parseDate(value: string, flag: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new ConfigError(`${flag} is not a valid date: "${value}"`);
  return date;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConfigError(`${name} is not set`);
  return value;
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c", default: "supatripwire.json" },
      since: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      json: { type: "boolean", default: false },
      strict: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
}

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    // Unknown or malformed flags: a usage error, not a crash.
    throw new ConfigError(`${(error as Error).message}\n\n${HELP.trimEnd()}`);
  }
  const { values, positionals } = parsed;

  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return values.help ? 0 : 2;
  }
  if (positionals[0] !== "check" || positionals.length > 1) {
    process.stderr.write(
      `Unknown command: ${positionals.join(" ")}\n\n${HELP}`,
    );
    return 2;
  }
  if (values.from && values.since)
    throw new ConfigError("Use either --from or --since, not both");

  const to = values.to ? parseDate(values.to, "--to") : new Date();
  const from = values.from
    ? parseDate(values.from, "--from")
    : new Date(to.getTime() - parseSpan(values.since ?? "24h"));
  if (from >= to)
    throw new ConfigError("The start of the range must be before its end");

  const config = await loadConfig(values.config);
  const accessToken = requireEnv("SUPABASE_ACCESS_TOKEN");
  const databaseUrl = requireEnv("SUPATRIPWIRE_DATABASE_URL");

  const directory = createPgDirectory(databaseUrl, config);
  try {
    const entries = fetchReadLogs({
      projectRef: config.projectRef,
      accessToken,
      from,
      to,
    });
    const summary = await runChecks(entries, config, directory);
    const range = { from, to };
    process.stdout.write(
      values.json ? formatJson(summary, range) : formatText(summary, range),
    );
    return exitCode(summary, values.strict);
  } finally {
    await directory.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const known = error instanceof ConfigError || error instanceof LogsApiError;
    process.stderr.write(
      `supatripwire: ${known ? (error as Error).message : String((error as Error)?.stack ?? error)}\n`,
    );
    process.exitCode = 2;
  },
);
