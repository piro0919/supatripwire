# supatripwire

Detects cross-tenant reads in a Supabase project from the outside. It reads the project's
API gateway logs and a few id-to-tenant mappings from the database, and reports reads that
named a tenant the caller does not belong to — or returned more rows than the caller could
possibly see. Nothing sits in the request path and no row contents are read.

Status: agreed in a sounding-board session on 2026-11-25. No code yet.

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
2. **More rows than the caller can see.** Filters only ever narrow. So with correct RLS the
   rows returned can never exceed the rows of that table inside the caller's tenants. If
   they do, data crossed — certain, whatever the filter said. This also catches requests
   with no filter at all.

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

## Open questions

- Helper in the same package or separate (above).
- How the CLI is run on a schedule — left to the user (cron, GitHub Actions), or built in.
- Whether this stays OSS only or later gets a hosted version.
