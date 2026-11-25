import { describe, expect, it } from "vitest";
import { parsePinningFilters } from "../src/search.js";

describe("parsePinningFilters", () => {
  it("reads eq and in filters from an encoded search string", () => {
    expect(
      parsePinningFilters(
        "?select=id%2Cname&org_id=eq.org-a&id=in.%28p1%2Cp2%29&order=name.asc",
      ),
    ).toEqual([
      { column: "org_id", values: ["org-a"] },
      { column: "id", values: ["p1", "p2"] },
    ]);
  });

  it("accepts a search string without the leading ?", () => {
    expect(parsePinningFilters("org_id=eq.org-a")).toEqual([
      { column: "org_id", values: ["org-a"] },
    ]);
  });

  it("skips reserved parameters, embedded filters and non-pinning operators", () => {
    expect(
      parsePinningFilters(
        "?select=*&limit=10&offset=0&or=%28a.eq.1%2Cb.eq.2%29&tasks.org_id=eq.org-b&org_id=neq.org-b&id=not.eq.p1&name=like.*x*&deleted_at=is.null",
      ),
    ).toEqual([]);
  });

  it("splits quoted in values that contain commas", () => {
    expect(parsePinningFilters('?name=in.("a,b",c,"d\\"e")')).toEqual([
      { column: "name", values: ["a,b", "c", 'd"e'] },
    ]);
  });

  it("returns an empty list for an empty search", () => {
    expect(parsePinningFilters("")).toEqual([]);
  });

  it("reads every pinning item of a top-level and=(…)", () => {
    expect(
      parsePinningFilters(
        "?and=%28org_id.eq.org-b%2Cid.in.%28p1%2Cp2%29%2Cname.like.x*%29",
      ),
    ).toEqual([
      { column: "org_id", values: ["org-b"] },
      { column: "id", values: ["p1", "p2"] },
    ]);
  });

  it("reads an or=(…) that pins one column as an in list", () => {
    expect(
      parsePinningFilters("?or=%28org_id.eq.org-a%2Corg_id.in.%28org-b%29%29"),
    ).toEqual([{ column: "org_id", values: ["org-a", "org-b"] }]);
  });

  it("ignores an or=(…) across different columns or with a non-pinning branch", () => {
    expect(parsePinningFilters("?or=%28org_id.eq.org-a%2Cid.eq.p1%29")).toEqual(
      [],
    );
    expect(
      parsePinningFilters("?or=%28org_id.eq.org-a%2Corg_id.is.null%29"),
    ).toEqual([]);
  });

  it("follows groups nested inside and=(…)", () => {
    expect(
      parsePinningFilters(
        '?and=(status.eq.open,or(org_id.eq.org-a,org_id.eq."org,b"),and(id.eq.p1))',
      ),
    ).toEqual([
      { column: "status", values: ["open"] },
      { column: "org_id", values: ["org-a", "org,b"] },
      { column: "id", values: ["p1"] },
    ]);
  });

  it("skips logic trees on embedded resources and negated trees", () => {
    expect(
      parsePinningFilters(
        "?tasks.and=(org_id.eq.org-b)&not.and=(org_id.eq.org-b)",
      ),
    ).toEqual([]);
  });
});
