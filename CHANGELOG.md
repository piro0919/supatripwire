# Changelog

## Unreleased

- Config: `tenantVia` maps a table with no tenant column of its own to the tenant of
  a row it references (`{ "column": "task_id", "table": "tasks" }`), one hop. Check 1
  resolves ids through that row; check 2 counts rows with a join, and holds back when
  the role may not see every row of either table. In the exported `TableConfig` type,
  `tenantColumn` is now absent on such tables.
- `supatripwire doctor` checks the setup: the role (not a superuser), the configured
  tables and columns, whether RLS lets the role see every row, and the logs API. It
  says what it cannot check: whether the config matches the app.
- `check` reads the same catalog facts first. Findings that depend on a table the role
  may not see in full are held back from "crossed", and the table is a
  `limited-visibility` coverage gap. Before, a role that saw only some rows made check
  2 report honest reads as crossed. A finding held back this way exits with status 3
  even without `--strict`.
- Config: `ignore` lists names in the request path that are deliberately not checked,
  such as a shared lookup table or `rpc`. Reads on them are counted apart and are not
  a coverage gap.
- A read on a path named after an Object property (`/rest/v1/constructor?id=eq.1`) no
  longer crashes the run. Such names were found on the config's prototype.
- The report shows what was checked: when the first and last reads were found, how
  many were fully checked, and how many reads that did not fail had no row count. It ends
  with the coverage gaps found, also listed in the JSON as `coverageGaps`.
- `--strict` exits with status 3 when nothing crossed but the run has a coverage gap,
  such as no reads found at all — which is also what an expired log range looks like.
- Findings show the request's query with filter values hidden, except on the table's
  tenant, id and reference columns, so names or emails an app filtered on do not end
  up in CI logs.
- `supatripwire/fetch`: `tripwireFetch` wraps the `fetch` passed to `createServerClient`
  and adds `x-forwarded-for` (the end user's IP) and `traceparent` (from the active
  OpenTelemetry span), so a log line can be traced back to a user and a page request.
- Check 2 — reports reads that saw more rows than the table holds inside the caller's
  tenants, using the returned range as a floor (`100-109/*` → at least 110 rows).
- `supatripwire check`: check 1 — reports signed-in reads whose filter named a tenant
  the caller does not belong to, classified as crossed, not provably foreign, or
  nothing returned.
