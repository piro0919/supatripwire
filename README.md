# supatripwire

Detect cross-tenant reads in a Supabase project from the outside.

A broken authorization check returns 200. Error monitoring never sees it, and in a
multi-tenant app the most common breach is one tenant reading another's rows through a
missing or subtly wrong RLS policy. supatripwire reads your project's API gateway logs
and a few id-to-tenant mappings from your database, and reports reads that named a
tenant the caller does not belong to, or saw more rows than the caller's tenants hold.

Nothing sits in the request path, and no row contents are read.

> **Status: early.** Both checks and the request-header helper are implemented. Not yet
> published.

## What it reports

For every signed-in `GET` to PostgREST in the time range, supatripwire runs two checks.

**Check 1 — the read named another tenant.** supatripwire reads the filter the request
sent (`tenant_id=eq.…`, `id=eq.…`, `project_id=in.(…)`), resolves
each id to a tenant, and compares the result with the caller's memberships.

| Result                   | Meaning                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Data crossed tenants** | Rows came back, and one filter named only tenants the caller is not in. Every returned row matched that filter, so every returned row belongs to another tenant.                           |
| **Not provably foreign** | Another tenant was named and rows came back, but the same filter also named the caller's own tenant, or the row count was not logged. With correct RLS the rows would be the caller's own. |
| **Nothing returned**     | Another tenant was named and zero rows came back. RLS stopped it — an attempt worth knowing about.                                                                                         |

**Check 2 — the read saw more rows than the caller's tenants hold.** Filters only ever
narrow, so with correct RLS a query can never see more rows than the table holds inside
the caller's tenants. The returned range gives a floor on what the query saw: a response
with `Content-Range: 100-109/*` means at least 110 rows were visible, even though only
10 came back. When that floor is above the caller's rows, rows from other tenants were
visible — whatever the filter said, and also for requests with no filter at all. This
is reported as data crossed. The total after the slash is ignored, because with
`Prefer: count=planned` or `count=estimated` it is an estimate.

For a user with no membership rows at all, both checks hold back to "not provably
foreign": that more often means the membership mapping or the role's access is wrong.
Check 2 does the same when the table holds no rows in the caller's tenants, and the
report names those tables.

Each finding shows the request's query with filter values hidden (`***`), except the
ids matched with `eq`, `neq`, `in` or `is` on the table's `tenantColumn`, `idColumn`
and `references` — what you need to follow it up. Any other value may be a name or an
email, and the report often ends up in CI logs: `?org_id=eq.…&name=ilike.***`. Use the
log id to see the full request in the Supabase dashboard.

The command exits with status 1 when data crossed, 0 otherwise, and 2 on error, so a
scheduled job can fail loudly.

## Setup

### 1. A read-only database role

Create a role that can read **only** the id and tenant columns of the tables involved,
and the membership table. Names, notes and everything else stay unreadable.

```sql
create role supatripwire login password '…';
grant usage on schema public to supatripwire;
grant select (user_id, org_id) on public.memberships to supatripwire;
grant select (id, org_id) on public.projects to supatripwire;
grant select (id, org_id) on public.tasks to supatripwire;

-- With RLS on, a role without a policy sees zero rows. Let this role see every
-- row; the column grants above still limit it to the id and tenant columns.
create policy supatripwire_read on public.memberships for select to supatripwire using (true);
create policy supatripwire_read on public.projects for select to supatripwire using (true);
create policy supatripwire_read on public.tasks for select to supatripwire using (true);
```

Column-level `GRANT` is enough: supatripwire selects only the columns named in the
config. Without the policies, every user looks like a member of no tenant. The report
warns when users with no membership rows show up, and their reads are never reported
as crossed. A data table without the policy looks empty; the report names such tables.

### 2. A personal access token

Create one at [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens).
It is used to read the project's logs through the
[Management API](https://supabase.com/docs/reference/api/v1-get-project-logs).

### 3. A config file

`supatripwire.json` declares which column on which table holds the tenant, and where
membership lives. This declaration is the source of truth; supatripwire does not try to
infer your authorization rules.

```json
{
  "projectRef": "abcdefghijklmnopqrst",
  "membership": {
    "table": "memberships",
    "userColumn": "user_id",
    "tenantColumn": "org_id"
  },
  "tables": {
    "orgs": { "tenantColumn": "id" },
    "projects": { "tenantColumn": "org_id" },
    "tasks": {
      "tenantColumn": "org_id",
      "references": { "project_id": "projects" }
    }
  }
}
```

- `tables` is keyed by the name in the request path (`/rest/v1/<name>`).
- `tenantColumn` — the column holding the tenant id. On the tenants table itself, use
  its primary key.
- `idColumn` — the primary key, if it is not `id`.
- `references` — columns holding the id of a row in another listed table. A filter on
  such a column is resolved through that table.

Reads on tables missing from the config are counted and listed in the report, not
checked.

## Usage

```sh
export SUPABASE_ACCESS_TOKEN=…
export SUPATRIPWIRE_DATABASE_URL=postgres://supatripwire:…@…/postgres

npx supatripwire check                 # the last 24 hours
npx supatripwire check --since 7d
npx supatripwire check --from 2026-01-01T00:00:00Z --to 2026-01-02T00:00:00Z
npx supatripwire check --json
```

How far back you can look depends on your plan's
[log retention](https://supabase.com/docs/guides/telemetry/logs): 1 day on Free, 7 on
Pro, 28 on Team, 90 on Enterprise.

## Tracing a finding back to a request

In a Next.js app using `@supabase/ssr`, almost every request to Supabase comes from your
server, so Supabase's logs show your server's IP, not the user's, and nothing ties a log
line to the page request that caused it. `tripwireFetch` wraps the `fetch` that
`createServerClient` uses and adds two headers:

- `x-forwarded-for` — the end user's IP, logged as `request.headers.x_forwarded_for`.
  The real sender stays in `request.headers.cf_connecting_ip`.
- `traceparent` — from the active OpenTelemetry span, logged as `trace_id`. With
  OpenTelemetry set up (for example `@vercel/otel` in `instrumentation.ts`), that is
  the trace id of the page request on your hosting platform. Without it, nothing is
  added.

```ts
import { createServerClient } from "@supabase/ssr";
import { headers } from "next/headers";
import { tripwireFetch } from "supatripwire/fetch";

export async function createClient() {
  const clientIp = (await headers()).get("x-forwarded-for");
  return createServerClient(url, key, {
    cookies: {
      // as in Supabase's Next.js guide
    },
    global: { fetch: tripwireFetch({ clientIp }) },
  });
}
```

On Vercel, `x-forwarded-for` on the incoming request is the client's IP. If you run your
own proxy in front, pass the header that proxy sets instead: elsewhere
`x-forwarded-for` is a chain the client can write to. Headers you already set are kept,
and no other propagated field, such as `baggage`, is sent. The entry point does not
load the CLI or `pg`.

`@opentelemetry/api` is a peer dependency, so the helper uses your app's copy — a
different copy would not see the tracing your app registered. npm and pnpm install it
for you; with Yarn, add it yourself.

The report gives each finding's log id; look it up in the project's logs in the
Supabase dashboard to see these two fields.

## What it cannot see

- **Writes.** Request bodies are not logged, so a row inserted or updated into another
  tenant is invisible.
- **Requests made with the secret / `service_role` key.** They bypass RLS and carry no
  user.
- **Filters it cannot pin to a tenant.** Only `eq` and `in` on a configured column
  name a tenant, at the top level or inside `and=(…)`. An `or=(…)` counts only when
  every branch pins the same column. Negations, ranges and pattern matches are not
  read.
- **Embedded selects** (`select=*,other(*)`). The row count covers top-level rows
  only, and filters on the embedded resource are skipped.
- **RPC and views** — they need their own entry in `tables`.
- **Schemas other than the default one.** The table is taken from the request path.
- **Past memberships.** Membership is read as it is now. A user who has since left a
  tenant shows up as reading a tenant they do not belong to (check 1), and their
  earlier reads can exceed the rows of the tenants they still have (check 2).
- **Rows deleted since the read** (check 2). Row counts are taken when the check runs.
  If a tenant's rows were hard-deleted between the read and the check, an honest read
  can exceed the smaller count. Running the check soon after the reads keeps this rare.
- **Rows every tenant may see** (check 2). If your RLS lets everyone read some rows of a
  table — shared templates with a null tenant, say — those rows are not in the ceiling,
  and reads that include them are reported. There is no per-table switch for check 2
  yet; leaving the table out of the config turns off check 1 for it as well.
- **Small leaks under check 2.** One foreign row mixed into a result that stays under
  the ceiling is not detectable.
- **Breaches at a third party** the data was sent to. Monitoring your own project
  cannot see reads in someone else's.

## Development

```sh
pnpm test        # vitest
pnpm typecheck
pnpm lint        # biome
pnpm build:lib   # tsup -> dist
```

`tests/directory.test.ts` runs against a real Postgres when
`SUPATRIPWIRE_TEST_DATABASE_URL` points at a throwaway database you can create roles in.
CI provides one.

## License

MIT
