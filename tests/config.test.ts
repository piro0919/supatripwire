import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.js";

const valid = {
  projectRef: "abcdefghijklmnopqrst",
  membership: {
    table: "memberships",
    userColumn: "user_id",
    tenantColumn: "org_id",
  },
  tables: {
    orgs: { tenantColumn: "id" },
    projects: { tenantColumn: "org_id" },
    tasks: { tenantColumn: "org_id", references: { project_id: "projects" } },
  },
};

describe("parseConfig", () => {
  it("accepts a valid config", () => {
    expect(parseConfig(valid)).toEqual(valid);
  });

  it("rejects a reference to a table that is not listed", () => {
    const config = structuredClone(valid);
    config.tables.tasks.references = { project_id: "nowhere" };
    expect(() => parseConfig(config)).toThrow(/not in tables/);
  });

  it("rejects names that are not plain identifiers", () => {
    const config = structuredClone(valid);
    config.membership.tenantColumn = 'org_id"; drop table x; --';
    expect(() => parseConfig(config)).toThrow(ConfigError);
  });

  it("rejects a malformed project ref", () => {
    expect(() => parseConfig({ ...valid, projectRef: "ABC" })).toThrow(
      /projectRef/,
    );
  });

  it("rejects an empty table list", () => {
    expect(() => parseConfig({ ...valid, tables: {} })).toThrow(
      /at least one table/,
    );
  });
});
