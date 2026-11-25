# supatripwire

Detects cross-tenant reads in a Supabase project from the outside. It reads the project's
API gateway logs and a few id-to-tenant mappings from the database, and reports reads that
named a tenant the caller does not belong to — or returned more rows than the caller could
possibly see. Nothing sits in the request path and no row contents are read.

Status: agreed in a sounding-board session on 2026-11-25. Package skeleton and both checks
implemented; the helper not yet. Not published.

## Why this exists

A broken authorization check returns 200. Error monitoring never sees it, and in a
multi-tenant app the most common breach is one tenant reading another's rows through a
missing or wrong RLS policy. Static scanners catch RLS that is off or always true; they
do not catch a policy that is subtly wrong, or a leak that is happening right now.

The product sells "you find out early", not "it never happens".

## What it is

An npm package whose main part is a **CLI that detects**, plus a small helper.

- **Inputs**
  - A Supabase personal access token — to read `edge_logs` through the Management API.
  - A connection string for a **read-only database role the customer creates**. Grant it
    only the id and tenant columns of the tables involved and the membership table,
    using column-level `GRANT`. Names, notes and the like stay unreadable.
- **Config** — the customer declares which column on which table holds the tenant, and
  where membership (user → tenants) lives. This declaration is the source of truth; we do
  not try to infer the app's authorization rules.
- **Output** — a report of suspicious reads.

### The two checks

1. **Named another tenant.** `request.search` holds the PostgREST filter verbatim
   (`tenant_id=eq.…`, `resident_id=eq.…`, `id=in.(…)`). Resolve every id in it to a tenant
   via the read-only role and compare with the caller's memberships. If it names a tenant
   outside them and `response.headers.content_range` shows one or more rows, data crossed
   — certain. Zero rows means RLS stopped an attempt; report it as an attempt.
   Refined while implementing: "certain" holds only when **one filter names nothing but
   other tenants**. Filters on different columns are ANDed and an `in` list is ORed, so
   `id=in.(own,foreign)` returning rows proves nothing — correct RLS returns the own row.
   That case, and rows returned with no readable `content_range`, is reported as
   `unconfirmed`, not `crossed`. So is any read by a user with **no membership rows**:
   that almost always means the membership mapping is wrong or the read-only role cannot
   see the rows (RLS on, no policy for the role), and the report warns about it.
   Pinning filters are read at the top level, inside `and=(…)`, and from an `or=(…)` whose
   branches all pin one column. Tenant-column values are canonicalized through the
   membership column's type before comparing (`3F2A…` → `3f2a…`).
2. **More rows than the caller can see.** Filters only ever narrow. So with correct RLS the
   rows returned can never exceed the rows of that table inside the caller's tenants. If
   they do, data crossed — certain, whatever the filter said. This also catches requests
   with no filter at all.
   As implemented: the "rows seen" side is `last + 1` from `content_range` (`100-109/*`
   → at least 110 visible), so paging with an offset is caught even when each page is
   small. The total after the slash is ignored: with `count=planned` or `estimated` it is
   a planner estimate, and the log does not say which was asked for. The ceiling is
   counted when the check runs, so hard deletes between the read and the check, leaving
   a tenant after the read, and rows RLS lets every tenant see (null tenant), can cause
   findings; all are in the README. A ceiling of 0 is reported as `unconfirmed`, not
   `crossed`: it usually means the read-only role has no RLS policy on that table, and
   the report names the table.

### The helper

A function that wraps the `fetch` passed to `createServerClient` and adds two headers:

- `traceparent` — its trace id lands in the log's `trace_id`, so a log line can be joined
  to the hosting platform's (e.g. Vercel's) request log.
- `x-forwarded-for` — the end user's IP lands in `request.headers.x_forwarded_for`.
  The real sender stays in `request.headers.cf_connecting_ip`.

Undecided: ship the helper in the same package as the CLI, or separately.

## Verified facts (2026-11-25)

Checked against real projects, not just docs.

- `edge_logs` carries, for a signed-in request:
  `request.sb.jwt.authorization.payload.subject`, `.session_id`, `.role`, `.amr_methods`,
  plus `request.search`, `request.method`, `response.status_code`,
  `response.headers.content_range`. The tenant is **not** in the logged JWT — membership
  has to come from the database.
- A `traceparent` sent by the client is recorded as `trace_id`; an `x-forwarded-for` sent
  by the client is recorded as `request.headers.x_forwarded_for` (tested with one probe
  request). Without them, `trace_id` is a fresh value per request.
- In a Next.js app using `@supabase/ssr`, almost every PostgREST request comes from the
  server (`createServerClient`, user agent `node`). The IP in Supabase's logs is then the
  server's, not the user's — a single user shows up behind many server IPs. Hence the
  helper.
- Management API log query: one call covers at most 24 hours
  ([docs](https://supabase.com/docs/reference/api/v1-get-project-logs)). Log retention is
  1 day on Free, 7 on Pro, 28 on Team, 90 on Enterprise
  ([docs](https://supabase.com/docs/guides/telemetry/logs)). Rate limit 120 requests per
  minute per user, project and endpoint.
- The OAuth scope table has no row for logs, and running SQL falls under Database write
  ([docs](https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration/oauth-scopes)).
  So a third-party OAuth app reading logs is not documented — hence a personal access
  token, and hence a read-only DB role rather than SQL over the Management API.
  Update 2026-11-25: the Management API's OpenAPI spec (`api.supabase.com/api/v1-json`)
  marks `GET`/`POST /v1/projects/{ref}/analytics/endpoints/logs` with
  `x-oauth-scope: analytics:read`. The scopes guide above still lacks that row. Not yet
  decided whether this changes the PAT choice.
- Logs are queried with ClickHouse SQL on a single `logs` table, `source = 'edge_logs'`,
  fields in `log_attributes['…']` (all strings). `logs.all` is gone (410). `select *`
  and `count(*)` are rejected; no maximum row count is documented, so the CLI pages
  1000 rows at a time with a `(timestamp, toString(id))` cursor. A tuple comparison
  `(timestamp, id) > (…)` fails on the logs backend; the expanded `or` form works.
- `request.search` is logged with its leading `?` and URL-encoded (`in.%28a%2Cb%29`).
  Embedded-resource filters appear as `other.col=eq.…`.
- `response.headers.content_range` on a 200 GET is `N-M/*` for rows, `*/*` for none,
  and `N-M/T` or `*/T` when a count was asked for.

## What it cannot see — say so in the README

- **Writes.** Request bodies are not logged, so a row inserted or updated into another
  tenant is invisible.
- **Requests made with the secret / service_role key.** They bypass RLS and carry no user.
- **Small leaks under check 2.** One foreign row mixed into a result that stays under the
  ceiling is not detectable.
- **Embedded selects** (`select=*,other(*)`) — `content_range` counts top-level rows only.
- **RPC and views** — need their own tenant mapping in config.
- **Breaches at a third party** the data was sent to. Monitoring your own project cannot
  see reads in someone else's.

## Rejected

- **A proxy in the request path.** Gives row-level truth, but an outage of ours becomes an
  outage of theirs, and it is not "connect and go".
- **An SDK as the main sensor.** Attackers call PostgREST directly with the anon key; an
  in-app SDK never sees that path.
- **Volume thresholds.** Shared devices that stay open all day (care facilities, shops)
  make one account look like a heavy scraper in normal use. Thresholds would open with
  false positives.
- **Romanised Japanese names.** The name should read globally and point at Supabase.

## Constraints

- Never put data from the projects used during verification into this repository — no
  table names, counts or ids in the README, tests or fixtures. Build fixtures from a test
  project.
- Write "Supabase" as one word with a capital S. Do not use Supabase's logo
  ([brand guidelines](https://supabase.com/brand)).
- Everything in this repository is in English.

## Code

```text
src/
├── cli.ts                 # `supatripwire check`; exit 0 / 1 (crossed) / 2 (error)
├── index.ts               # library exports
├── config.ts              # supatripwire.json parsing; names must be plain identifiers
├── logs.ts                # Management API log reader: 24h windows, paged by cursor
├── search.ts              # eq / in filters out of request.search, incl. and=() / or=()
├── content-range.ts       # rows returned; fewest rows visible (last + 1)
├── directory.ts           # read-only role lookups (memberships, row → tenant, counts)
├── lookups.ts             # per-run cache; prefetches what a batch of entries needs
├── run-checks.ts          # one pass over the logs, both checks per entry
├── findings.ts            # finding and summary types
├── check-named-tenant.ts  # check 1
├── check-row-ceiling.ts   # check 2
└── report.ts              # text and JSON output
tests/                     # vitest; directory.test.ts needs SUPATRIPWIRE_TEST_DATABASE_URL
```

- TypeScript, ESM only, Node >= 20. Runtime dependency: `pg`. Biome, tsup, vitest,
  lefthook — same setup as the other piro0919 packages.
- `directory.ts` compares ids in the column's own type (`u.input::<type>`) so the
  primary-key index is used, keys results by the string the log spelled, and falls back
  to text comparison when a value does not parse. Only the id and tenant columns are
  ever selected, which is what lets the customer's role be column-granted.
- Locally, `tests/directory.test.ts` runs against any throwaway Postgres
  (`initdb` + `pg_ctl` in a temp dir is enough); CI uses a `postgres:17` service.
- When changing the check, break it deliberately and confirm the tests fail.

```bash
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm lint        # biome check
pnpm build:lib   # tsup -> dist
pnpm check:package
```

## Open questions

- Helper in the same package or separate (above).
- How the CLI is run on a schedule — left to the user (cron, GitHub Actions), or built in.
- Whether this stays OSS only or later gets a hosted version.
