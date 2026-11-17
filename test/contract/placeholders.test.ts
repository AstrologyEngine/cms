import {
  placeholdersIn,
  samePlaceholders,
} from "@astrologyengine/cms-contract/placeholders";
import { describe, expect, it } from "vitest";

describe("placeholdersIn", () => {
  it("extracts unique names in order of appearance", () => {
    expect(placeholdersIn("{b} and {a} then {b}; not { c } or {1x}")).toEqual([
      "b",
      "a",
    ]);
  });
});

describe("samePlaceholders", () => {
  it("compares as sets", () => {
    expect(samePlaceholders(["a", "b"], ["b", "a"])).toBe(true);
    expect(samePlaceholders(["a"], ["a", "b"])).toBe(false);
  });
});
