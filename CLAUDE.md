# supatripwire

Detects cross-tenant reads in a Supabase project from the outside. It reads the project's
API gateway logs and a few id-to-tenant mappings from the database, and reports reads that
named a tenant the caller does not belong to — or returned more rows than the caller could
possibly see. Nothing sits in the request path and no row contents are read.

Status: agreed in a sounding-board session on 2026-11-25. Package skeleton, both checks
and the helper implemented. 0.1.0 published to npm on 2026-11-26.

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
  not try to infer the app's authorization rules. A table with no tenant column uses
  `tenantVia: { column, table }` instead of `tenantColumn` (named 2026-11-26): its rows
  belong to the tenant of the row `column` references. `table` may itself use
  `tenantVia` (chains allowed 2026-11-26; first shipped as one hop); the chain must end at
  a table with its own `tenantColumn` and must not loop. Check 1 and check 2 join along
  the whole chain; check 2 holds back when any table on it is not fully visible to the
  role. `ignore` lists path names left
  unchecked on purpose (shared lookup tables, `rpc` as a whole), so `--strict` does not
  fail on them; a run where every read was ignored is still the `no-reads` gap.
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
   findings; all are in the README. `"rowCeiling": false` on a table turns check 2 off
   for it (added 2026-11-26, for null-tenant rows every tenant may read); check 1 still
   runs, and no counts are queried for it. A ceiling of 0 is reported as `unconfirmed`, not
   `crossed`: it usually means the read-only role has no RLS policy on that table, and
   the report names the table.
   Added 2026-11-25: a ceiling above 0 can still be too low when RLS shows the role only
   some rows. Before reading logs, `check` reads `pg_class` / `pg_policy` as the role
   (`access.ts`): RLS off, superuser, BYPASSRLS, holding the owner's privileges without
   FORCE, or a permissive `using (true)` SELECT/ALL policy for the role (or PUBLIC, or a
   role whose privileges it holds) with no narrowing restrictive one counts as seeing
   every row. Privileges, not bare membership: `pg_has_role(…, 'USAGE')`, because RLS
   does not exempt or apply through a NOINHERIT membership. Policies without USING
   (only WITH CHECK) take no part in reads. Anything else holds back check 2 on that
   table, and a limited membership table holds back every finding; a held-back crossed
   exits 3 even without `--strict`, so it never passes quietly. If the catalog cannot be
   read, every table is `unknown` and treated as limited. Tested on local Postgres 15
   and in CI on 17, and on a hosted Supabase test project on 2026-11-26: a
   column-granted role reads these catalogs there too, and `doctor` reported every
   table as `sees every row`.

### The helper

A function that wraps the `fetch` passed to `createServerClient` and adds two headers:

- `traceparent` — its trace id lands in the log's `trace_id`, so a log line can be joined
  to the hosting platform's (e.g. Vercel's) request log.
- `x-forwarded-for` — the end user's IP lands in `request.headers.x_forwarded_for`.
  The real sender stays in `request.headers.cf_connecting_ip`.

Decided 2026-11-25:

- Shipped in the same package as a separate entry, `supatripwire/fetch`, exporting
  `tripwireFetch({ clientIp, fetch })`. The entry imports only `@opentelemetry/api`, never
  the CLI or `pg`.
- The trace id comes from the **active OpenTelemetry span**, via
  `propagation.inject(context.active(), …)`. Vercel's request id is not a 32-hex trace
  id, so only an OpenTelemetry trace can be joined to Vercel's logs. With no propagator
  registered, no `traceparent` is added. `@vercel/otel` can do the same on its own with
  `fetch.propagateContextUrls`; the helper saves that configuration.
- `@opentelemetry/api` is a **required peer** (`^1.0.0`), so the helper uses the app's
  copy. Not a regular dependency: the API refuses a global registered by an older minor
  (`isCompatible`: own minor must be <= the global's), so our 1.10 next to an app's
  1.9.1 silently injected nothing — tested with `@vercel/otel`. Not an optional peer:
  a static import of a missing module breaks the build. npm and pnpm install a missing
  required peer on their own; tested that the helper then adds only `x-forwarded-for`.
- With `@vercel/otel`'s `propagateContextUrls` also covering Supabase, the request still
  carries one `traceparent`, with the page request's trace id (tested).
- The caller passes the IP (from `next/headers`); the package does not depend on Next.js.
- Headers the caller already set are kept. Only `traceparent` and `tracestate` are taken
  from the propagator — a composite one also writes `baggage`, which would leak the
  app's baggage to Supabase. An IP that is not a valid header value is left out rather
  than failing the request.
- Supabase Auth has its own `Sb-Forwarded-For` header for rate limiting by end-user IP
  (needs the secret key and a project setting). Not used: the goal here is the log, not
  rate limits. The helper also wraps auth-js's requests (`createClient` hands
  `global.fetch` to the auth client too). Auth's source
  (`internal/api/middleware.go`, `performRateLimiting`) keys its IP limits on
  `Sb-Forwarded-For` when enabled, else on the first value of the header named by
  `RATE_LIMIT_HEADER` (empty → no IP limit). Which header hosted Supabase configures
  there, and whether the gateway rewrites `x-forwarded-for` before Auth sees it, is not
  public — so whether our header shifts Auth's limits is still unverified. Settling it
  takes deliberate rate-limit hits against a test project.

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
  Checked 2026-11-25 through the Supabase MCP's `query_logs` (not the CLI's own call):
  a range with no logs — before the project existed — returns an empty result, not
  an error. So an expired range looks exactly like a quiet one; hence the `no-reads`
  coverage gap. On a Pro project, `edge_logs` from 85 days back were still returned,
  so the documented retention is a floor, not a cut-off we can rely on.
- The OAuth scope table has no row for logs, and running SQL falls under Database write
  ([docs](https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration/oauth-scopes)).
  So a third-party OAuth app reading logs is not documented — hence a personal access
  token, and hence a read-only DB role rather than SQL over the Management API.
  Update 2026-11-25: the Management API's OpenAPI spec (`api.supabase.com/api/v1-json`)
  marks `GET`/`POST /v1/projects/{ref}/analytics/endpoints/logs` with
  `x-oauth-scope: analytics:read`. The scopes guide above still lacks that row. Not yet
  decided whether this changes the PAT choice.
  Update 2026-11-26: scoped personal access tokens (public alpha,
  [docs](https://supabase.com/docs/guides/platform/personal-access-tokens)) can carry
  only **Logs: Read**. A token with nothing else ran `doctor` and `check` end to end
  against a hosted test project, so the README recommends that. Scoped tokens start
  with `sbp_fc`, which the secretlint `sbp_` pattern still matches.
- Logs are queried with ClickHouse SQL on a single `logs` table, `source = 'edge_logs'`,
  fields in `log_attributes['…']` (all strings). `logs.all` is gone (410). `select *`
  and `count(*)` are rejected; no maximum row count is documented, so the CLI pages
  1000 rows at a time with a `(timestamp, toString(id))` cursor. A tuple comparison
  `(timestamp, id) > (…)` fails on the logs backend; the expanded `or` form works.
- `request.search` is logged with its leading `?` and URL-encoded (`in.%28a%2Cb%29`).
  Embedded-resource filters appear as `other.col=eq.…`.
- `response.headers.content_range` on a 200 GET is `N-M/*` for rows, `*/*` for none,
  and `N-M/T` or `*/T` when a count was asked for.

## End-to-end run on hosted Supabase (2026-11-26)

A throwaway project (Tokyo, Free) with two made-up tenants, a leaking projects policy
(`using (auth.role() = 'authenticated')`), and the README's column-granted role,
reached through the shared pooler in session mode as `supatripwire.<ref>`. Nine reads
by one user; `check --since 2h` scanned all nine, reported two crossed (one by check 2
on an unfiltered read, one read caught by both checks) and three attempts, and exited 1.
The project was deleted afterwards. A policy written as
`org_id in (select org_id from memberships)` did **not** leak: the subquery runs under
memberships' own RLS, so it only sees the caller's rows.

## What it cannot see — say so in the README

- **Writes.** Request bodies are not logged, so a row inserted or updated into another
  tenant is invisible.
- **Requests made with the secret / service_role key.** They bypass RLS and carry no user.
- **Small leaks under check 2.** One foreign row mixed into a result that stays under the
  ceiling is not detectable.
- **Embedded selects** (`select=*,other(*)`) — `content_range` counts top-level rows only.
- **RPC and views** — need their own tenant mapping in config. Until then, `rpc` can
  only be ignored as a whole.
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
- Everything in this repository is in English, except the Japanese copy of the landing
  page (`lp/`), which is in English and Japanese like the other piro0919 landing pages
  (decided 2026-11-26).

## Code

```text
src/
├── cli.ts                 # `check` (exit 0 / 1 crossed / 2 error / 3 --strict gaps) and `doctor`
├── index.ts               # library exports
├── fetch.ts               # `supatripwire/fetch`: tripwireFetch (traceparent, x-forwarded-for)
├── config.ts              # supatripwire.json parsing; table and column names must be plain
│                          # identifiers; tables have no prototype (path names are untrusted)
├── logs.ts                # Management API log reader: 24h windows, paged by cursor
├── search.ts              # eq / in filters out of request.search, incl. and=() / or=()
├── redact.ts              # hides filter values in findings, except mapped id/tenant columns
├── content-range.ts       # rows returned; fewest rows visible (last + 1)
├── directory.ts           # read-only role lookups (memberships, row → tenant, counts)
├── lookups.ts             # per-run cache; prefetches what a batch of entries needs
├── run-checks.ts          # one pass over the logs, both checks per entry
├── findings.ts            # finding and summary types
├── coverage.ts            # coverage gaps and the exit status
├── access.ts              # what the role can see of each table, from the catalog
├── doctor.ts              # `supatripwire doctor`: role, tables, columns, RLS, logs API
├── check-named-tenant.ts  # check 1
├── check-row-ceiling.ts   # check 2
└── report.ts              # text and JSON output
tests/                     # vitest; directory.test.ts needs SUPATRIPWIRE_TEST_DATABASE_URL
examples/github-actions.yml  # scheduled `check --strict` for users to copy
lp/                        # landing page, supatripwire.kkweb.io (not published to npm)
```

- TypeScript, ESM only, Node >= 20. Runtime dependency: `pg`; peer:
  `@opentelemetry/api` (the helper only). Biome, tsup, vitest,
  lefthook — same setup as the other piro0919 packages.
- secretlint runs on staged files before each commit and on the whole tree in CI. The
  repository went public on 2026-11-26; GitHub secret scanning and push protection were
  turned on then (before that, private, they were unavailable and secretlint was the
  only check). Its recommended preset catches `postgres://` URLs with
  a password but not Supabase keys, so `.secretlintrc.json` adds patterns for
  `sbp_…` (personal access token) and `sb_secret_…` (secret API key). Legacy
  `service_role` keys are JWTs that cannot be told apart from the public anon key, so
  they are not matched. Since v14 the preset and the pattern rule are built into
  `secretlint`; the separate `@secretlint/secretlint-rule-*` packages are deprecated.
- commitlint checks commit messages (`@commitlint/config-conventional`, unchanged).
  The `subject-case: lower-case` override some sibling repos use is left out: it
  rejects subjects that name "Supabase" or other proper nouns.
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
pnpm secretlint  # secrets in the tree
pnpm build:lib   # tsup -> dist
pnpm check:package
```

### Releasing

- Bump `package.json`, turn `## Unreleased` in CHANGELOG into `## x.y.z - date`, commit
  `chore: release x.y.z`, push the `vx.y.z` tag. `publish.yml` publishes through npm
  trusted publishing (OIDC, no token, provenance attached) and skips a version already
  on npm.
- 0.1.0 was published by hand from a Mac on 2026-11-26: trusted publishing can only be
  configured once the package exists. npm turned it into a staged publish, released a
  few minutes later, which left a `0.0.0-stage` placeholder version (sibling packages
  have one too). No `NPM_TOKEN` secret exists, on purpose.

### Landing page (`lp/`)

- A pnpm workspace package: Next.js + next-intl, English and Japanese, set up like the
  other piro0919 landing pages (Poi, Owler). Its own Biome config, so the root
  `biome.json` ignores `lp/` and lefthook checks it from inside. `pnpm lp:dev`,
  `lp:build`, `lp:lint`, `lp:typecheck`; CI builds it.
- **The model is zizmor.sh** (agreed 2026-11-26, after the Poi/Owler black page with
  white round buttons was turned down). Colors and sizes come from zizmor's stylesheet;
  the terminal background `#282c34` was sampled from its screenshots. Light by default,
  dark from the system setting, no toggle.
- The terminals show real CLI output, not hand-written text: `formatText` and
  `runDoctor` run on made-up input (random uuids, a throwaway local Postgres, a stubbed
  logs API). See `lp/src/app/[locale]/terminal-output.ts`. Print them again if the
  report's wording changes.
- The Open Graph card follows the other piro0919 package cards (dark, name, one line
  and kkweb.io on the left, what the package does on the right), not the page's own
  look. Its right side is three lines of that same terminal output, so re-cut the Inter
  subset (`lp/assets/README.md`) when they change.
- Tailwind font-size and color tokens must not share a name: `text-footer` once
  resolved to the footer's background color and hid the footer links.

## Open questions

- How the CLI is run on a schedule — for now a GitHub Actions template
  (`examples/github-actions.yml`, added 2026-11-26): hourly at :17 UTC over the last 3
  hours with `--strict`, through the shared pooler in session mode, as GitHub's runners
  have no IPv6 and the direct connection is IPv6 without the add-on. The CLI has run
  against a hosted project through that pooler (from a local machine, 2026-11-26); the
  workflow itself has not run on GitHub. Whether to build scheduling in is still open.
- Whether this stays OSS only or later gets a hosted version.
