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
ids matched with `eq`, `neq`, `in` or `is` on the table's `tenantColumn`, `idColumn`,
`references` and `tenantVia` column — what you need to follow it up. Any other value may be a name or an
email, and the report often ends up in CI logs: `?org_id=eq.…&name=ilike.***`. Use the
log id to see the full request in the Supabase dashboard.

The command exits with status 1 when data crossed, 0 otherwise, and 2 on error, so a
scheduled job can fail loudly. Status 3 is described below: a finding held back from
"data crossed" by the role's setup, or any coverage gap with `--strict`.

### What "nothing found" covers

No findings means no evidence among the reads that were checked — not that nothing
leaked. The report says how many that was:

- **Signed-in reads scanned** — every signed-in `GET` to `/rest/v1/` in the logs for
  the range, and when the first and last were found. This is the whole denominator:
  writes, anonymous reads, secret-key requests and anything else on the list below
  are outside it.
- **Fully checked** — reads on configured tables with a row count, or that failed
  (4xx/5xx) and so returned nothing.
- **On tables missing from the config** — not checked at all.
- **On tables the config ignores** — not checked, by your choice.
- **Without a row count** — reads that did not fail but whose `content_range` was
  missing or unreadable. Check 2 cannot judge them, and check 1 cannot call them
  crossed.

When no reads are found, the range may be older than your logs: the logs API returns
an empty result rather than an error once logs are no longer kept. The same goes for
part of a range: if the first read is more than a day after the start, the report says
so, but it is not a coverage gap, because a quiet project looks the same.

The report ends with the coverage gaps it found: `no-reads`, `unmapped-tables`,
`no-row-count`, `users-without-membership`, `empty-ceiling` (these two are the
warnings above, and only cover users and tables that show up in findings) and
`limited-visibility`. With `--strict`, a run that found no crossed data but has a gap
exits with status 3, so a scheduled job also fails when it could not look properly.
Crossed data still exits with 1.

`limited-visibility` comes from Postgres's catalog, read before any log: the
membership table, or a table this run read, where RLS may hide rows from the read-only
role — no SELECT policy for it, or none that is plainly `using (true)`, or a
restrictive policy on top — or whose catalog entries could not be read. For a
`tenantVia` table, every table it reaches the tenant through counts too. Check 2 counts
the caller's rows through that role, so a role that sees only some of them would turn
honest reads into "data crossed". Findings that depend on such a table are held back
to "not provably foreign"; if it is the membership table, that is every finding. A
held-back finding that would have been "data crossed" exits with status 3 even
without `--strict`, so it cannot pass a scheduled run unnoticed.

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
-- A table with no tenant column (`tenantVia` below): its id and the column it
-- reaches the tenant through.
grant select (id, task_id) on public.comments to supatripwire;

-- With RLS on, a role without a policy sees zero rows. Let this role see every
-- row; the column grants above still limit it to the id and tenant columns.
create policy supatripwire_read on public.memberships for select to supatripwire using (true);
create policy supatripwire_read on public.projects for select to supatripwire using (true);
create policy supatripwire_read on public.tasks for select to supatripwire using (true);
create policy supatripwire_read on public.comments for select to supatripwire using (true);
```

Column-level `GRANT` is enough: supatripwire selects only the columns named in the
config. Without the policies, every user looks like a member of no tenant. The report
warns when users with no membership rows show up, and their reads are never reported
as crossed. A data table without the policy looks empty; the report names such tables.

Once the role and the config are in place, `npx supatripwire doctor` checks them: that
it connects (and not as a superuser), that every table and column in the config
exists and is readable, that RLS lets the role see every row, and that the logs API
answers. It reads the catalog and at most one log line, never table rows. It cannot
tell whether the config matches your app — which column really holds the tenant, or
whether the membership table is complete — and says so.

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
    },
    "comments": { "tenantVia": { "column": "task_id", "table": "tasks" } }
  },
  "ignore": ["countries", "rpc"]
}
```

- `tables` is keyed by the name in the request path (`/rest/v1/<name>`).
- `tenantColumn` — the column holding the tenant id. On the tenants table itself, use
  its primary key.
- `tenantVia` — instead of `tenantColumn`, for a table with no tenant column whose
  rows belong to the tenant of a row they reference. `column` holds the id of a row in
  `table`. `table` may itself use `tenantVia`, as long as the chain ends at a table
  with a `tenantColumn` and never comes back to a table it passed. Check 1 resolves an
  id through that chain, and a filter on `column` counts as a reference. Check 2
  counts the table's rows by joining along the chain, so a row whose `column` is null
  — or whose chain breaks further on — is in no tenant's ceiling, and the role must see
  every row of every table on the chain. If `column` and the referenced id differ in
  type (a `text` column holding uuids), they are compared as text, so values spelled
  differently do not match.
- `idColumn` — the primary key, if it is not `id`.
- `references` — columns holding the id of a row in another listed table. A filter on
  such a column is resolved through that table.
- `rowCeiling` — optional. `false` turns check 2 off for the table, for one whose RLS
  lets every tenant read some rows (see
  [What it cannot see](#what-it-cannot-see)). Check 1 still runs on it. A `tenantVia`
  table counts through its own rows, so set it there too if it has the same shared rows.

- `ignore` — optional. Names in the request path you deliberately leave unchecked:
  tables every tenant may read, or `rpc` for every function under `/rest/v1/rpc/`.
  Functions can only be ignored all at once; `rpc/name` is rejected. If every read in
  the range was on an ignored name, nothing was checked, and that is still the
  `no-reads` gap.

Reads on tables missing from the config are counted and listed in the report, not
checked, and are a coverage gap. Reads on names in `ignore` are counted on their own
and are not a gap, so `--strict` does not fail on a lookup table every tenant shares.
Anything you put there is no longer watched: list only names that hold no tenant data.

## Usage

```sh
export SUPABASE_ACCESS_TOKEN=…
export SUPATRIPWIRE_DATABASE_URL=postgres://supatripwire:…@…/postgres

npx supatripwire doctor                # check the setup first
npx supatripwire check                 # the last 24 hours
npx supatripwire check --since 7d
npx supatripwire check --from 2026-01-01T00:00:00Z --to 2026-01-02T00:00:00Z
npx supatripwire check --json
npx supatripwire check --strict        # also fail (status 3) on coverage gaps
```

How far back you can look depends on your plan's
[log retention](https://supabase.com/docs/guides/telemetry/logs): 1 day on Free, 7 on
Pro, 28 on Team, 90 on Enterprise.

### On a schedule with GitHub Actions

[`examples/github-actions.yml`](examples/github-actions.yml) runs `check --strict`
every hour over the last 3 hours, and fails the job on crossed data, a held-back
finding or a coverage gap. Copy it to `.github/workflows/` and add the two variables
above as repository secrets.

- **Use a private repository.** The report names user ids, tenant ids and tables, and
  the run logs of a public repository are public. GitHub also turns off scheduled
  workflows in a public repository after 60 days without activity.
- **Connect through the shared pooler in session mode.** GitHub's runners reach IPv4
  only, and the direct connection (`db.<ref>.supabase.co`) is IPv6 unless the project
  has the IPv4 add-on
  ([Supabase docs](https://supabase.com/docs/guides/troubleshooting/supabase--your-network-ipv4-and-ipv6-compatibility-cHe3BP)).
  Through the pooler the user name carries the project ref:
  `postgresql://supatripwire.<project-ref>:…@<pooler-host>:5432/postgres`.
  Copy the pooler host from the project's Connect dialog.
- **Why 3 hours every hour.** GitHub can delay scheduled runs, or drop them under load
  ([GitHub docs](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)).
  The overlap keeps two missed runs, and logs that arrive late, inside some run's
  range. The cost is that one finding fails up to three runs in a row.
- GitHub notifies the user who last changed the `cron` line.

The template has not yet been run against a hosted project. Run `doctor` locally with
the same connection string first; the workflow can then be started by hand from the
Actions tab before the first scheduled run.

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
  and reads that include them are reported. Set `"rowCeiling": false` on such a table
  to turn check 2 off for it; check 1 still runs.
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
