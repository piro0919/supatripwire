# Changelog

## Unreleased

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
