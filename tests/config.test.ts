import { describe, expect, it } from "vitest";
import {
  ConfigError,
  parseConfig,
  referencedTable,
  tableConfig,
} from "../src/config.js";

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
    expect(parseConfig(valid)).toEqual({ ...valid, ignore: [] });
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

  it("reads ignore, and rejects a name that is also in tables or not a string", () => {
    expect(
      parseConfig({ ...valid, ignore: ["countries", "rpc"] }).ignore,
    ).toEqual(["countries", "rpc"]);
    expect(() => parseConfig({ ...valid, ignore: ["projects"] })).toThrow(
      /also in tables/,
    );
    expect(() => parseConfig({ ...valid, ignore: "rpc" })).toThrow(
      /must be an array/,
    );
    expect(() => parseConfig({ ...valid, ignore: [""] })).toThrow(
      /ignore\[0\]/,
    );
  });

  it("never resolves a path name to something inherited from Object", () => {
    const config = parseConfig(valid);
    for (const name of [
      "constructor",
      "toString",
      "__proto__",
      "hasOwnProperty",
    ]) {
      expect(tableConfig(config, name)).toBeUndefined();
      expect(config.tables[name]).toBeUndefined();
    }
    const tasks = tableConfig(config, "tasks");
    expect(tasks && referencedTable(tasks, "constructor")).toBeUndefined();
    // A hand-built config with a plain object is guarded too.
    const handBuilt = {
      ...config,
      tables: { projects: { tenantColumn: "org_id" } },
    };
    expect(tableConfig(handBuilt, "constructor")).toBeUndefined();
  });
});
