import { describe, expect, it } from "vitest";
import { rowsReturned } from "../src/content-range.js";

describe("rowsReturned", () => {
  it("counts the rows in a range", () => {
    expect(rowsReturned("0-4/*")).toBe(5);
    expect(rowsReturned("10-10/120")).toBe(1);
  });

  it("reads an empty range as zero rows", () => {
    expect(rowsReturned("*/*")).toBe(0);
    expect(rowsReturned("*/0")).toBe(0);
  });

  it("returns null when the header is missing or unreadable", () => {
    expect(rowsReturned(undefined)).toBeNull();
    expect(rowsReturned("")).toBeNull();
    expect(rowsReturned("bytes 0-4/5")).toBeNull();
    expect(rowsReturned("5-2/*")).toBeNull();
  });
});
