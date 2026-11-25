import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import type { TenantDirectory } from "../src/directory.js";
import { redactSearch } from "../src/redact.js";
import { runChecks } from "../src/run-checks.js";

const tasks = {
  tenantColumn: "org_id",
  references: { project_id: "projects" },
};

describe("redactSearch", () => {
  it("keeps values on the tenant, id and reference columns", () => {
    expect(
      redactSearch("?org_id=eq.org-a&id=eq.t-1&project_id=in.(p-1,p-2)", tasks),
    ).toBe("?org_id=eq.org-a&id=eq.t-1&project_id=in.(p-1,p-2)");
  });

  it("hides values on any other column, keeping the operator", () => {
    expect(
      redactSearch(
        "?email=eq.someone%40example.com&name=ilike.%2Asmith%2A&org_id=eq.org-a",
        tasks,
      ),
    ).toBe("?email=eq.***&name=ilike.***&org_id=eq.org-a");
  });

  it("keeps negations and modifiers but hides what follows", () => {
    expect(
      redactSearch(
        "?name=not.in.%28a%2Cb%29&tags=like(any).%7Ba%2Cb%7D&body=fts(english).secret",
        tasks,
      ),
    ).toBe("?name=not.in.***&tags=like(any).***&body=fts(english).***");
  });

  it("hides a value with dots in it whole", () => {
    expect(redactSearch("?note=eq.call.me.at.home", tasks)).toBe(
      "?note=eq.***",
    );
  });

  it("hides a value that has no recognizable operator", () => {
    expect(redactSearch("?name=Smith", tasks)).toBe("?name=***");
  });

  it("leaves select, order, limit and offset alone", () => {
    expect(
      redactSearch(
        "?select=id%2Cname&order=name.asc&limit=10&offset=20",
        tasks,
      ),
    ).toBe("?select=id,name&order=name.asc&limit=10&offset=20");
  });

  it("redacts inside and=(…) / or=(…), keeping mapped columns", () => {
    expect(
      redactSearch(
        "?and=%28org_id.eq.org-a%2Cname.eq.%22Smith%2C%20J%22%2Cor%28email.eq.x%2Cid.eq.t-1%29%29",
        tasks,
      ),
    ).toBe("?and=(org_id.eq.org-a,name.eq.***,or(email.eq.***,id.eq.t-1))");
  });

  it("keeps mapped columns in a negated tree", () => {
    expect(
      redactSearch("?not.or=%28org_id.eq.org-a%2Cname.eq.x%29", tasks),
    ).toBe("?not.or=(org_id.eq.org-a,name.eq.***)");
  });

  it("hides every value on embedded resources, even a column named like a mapped one", () => {
    expect(
      redactSearch(
        "?owner.org_id=eq.org-b&owner.or=%28org_id.eq.org-b%2Cname.eq.x%29",
        tasks,
      ),
    ).toBe("?owner.org_id=eq.***&owner.or=(org_id.eq.***,name.eq.***)");
  });

  it("hides everything but structure on a table missing from the config", () => {
    expect(redactSearch("?org_id=eq.org-a&select=*", undefined)).toBe(
      "?org_id=eq.***&select=*",
    );
  });

  it("returns an empty search as is", () => {
    expect(redactSearch("", tasks)).toBe("");
    expect(redactSearch("?", tasks)).toBe("?");
  });
});

describe("runChecks redacts the search in findings", () => {
  it("hides values on unmapped columns in what it reports", async () => {
    const config = parseConfig({
      projectRef: "abcdefghijklmnopqrst",
      membership: {
        table: "memberships",
        userColumn: "user_id",
        tenantColumn: "org_id",
      },
      tables: { projects: { tenantColumn: "org_id" } },
    });
    const directory: TenantDirectory = {
      async membershipsOf(userIds) {
        return new Map(userIds.map((u) => [u, new Set(["org-a"])]));
      },
      async tenantsOfRows() {
        return new Map();
      },
      async rowCounts(_table, tenants) {
        return new Map(tenants.map((t) => [t, 1]));
      },
      async canonicalTenantIds(values) {
        return new Map(values.map((v) => [v, v]));
      },
      async close() {},
    };
    const summary = await runChecks(
      [
        {
          timestamp: "2026-01-01T00:00:00.000000",
          id: "log-1",
          userId: "alice",
          table: "projects",
          search: "?org_id=eq.org-b&name=eq.Secret%20Project",
          contentRange: "0-4/*",
          status: 200,
        },
      ],
      config,
      directory,
    );
    expect(summary.findings.length).toBe(2);
    for (const finding of summary.findings) {
      expect(finding.search).toBe("?org_id=eq.org-b&name=eq.***");
    }
  });
});
