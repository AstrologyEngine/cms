import {
  placeholdersIn,
  type PlaceholdersOf,
} from "@astrologyengine/cms-contract/placeholders";
import { describe, expect, expectTypeOf, it } from "vitest";

// Type-level cases are checked by `bun run check`; each also asserts the
// runtime extractor agrees, so the two definitions can't drift apart.
type Ten<S extends string> = `${S}${S}${S}${S}${S}${S}${S}${S}${S}${S}`;
type Thousand<S extends string> = Ten<Ten<Ten<S>>>;
/** A literal type over 2,000 characters long. */
type Long = `${Thousand<"x">}{first}${Thousand<"y">}{second}`;
const long = `${"x".repeat(1000)}{first}${"y".repeat(1000)}{second}` as Long;

describe("PlaceholdersOf", () => {
  it("is never without placeholders", () => {
    expectTypeOf<PlaceholdersOf<"Plain text.">>().toEqualTypeOf<never>();
    expect(placeholdersIn("Plain text.")).toEqual([]);
  });

  it("names one placeholder", () => {
    expectTypeOf<PlaceholdersOf<"Hi {name}!">>().toEqualTypeOf<"name">();
    expect(placeholdersIn("Hi {name}!")).toEqual(["name"]);
  });

  it("deduplicates repeats and handles adjacent placeholders", () => {
    expectTypeOf<PlaceholdersOf<"{a}{b} and {a}">>().toEqualTypeOf<"a" | "b">();
    expect(placeholdersIn("{a}{b} and {a}")).toEqual(["a", "b"]);
  });

  it("ignores braces that don't hold an identifier", () => {
    expectTypeOf<
      PlaceholdersOf<"{ c } {1x} {} {ok_1} {a-b}">
    >().toEqualTypeOf<"ok_1">();
    expect(placeholdersIn("{ c } {1x} {} {ok_1} {a-b}")).toEqual(["ok_1"]);
  });

  it("finds the innermost identifier in nested or unbalanced braces", () => {
    expectTypeOf<PlaceholdersOf<"{a{b} {{c}}">>().toEqualTypeOf<"b" | "c">();
    expect(placeholdersIn("{a{b} {{c}}")).toEqual(["b", "c"]);
  });

  it("handles long text", () => {
    expect(long.length).toBeGreaterThan(2000);
    expectTypeOf<PlaceholdersOf<Long>>().toEqualTypeOf<"first" | "second">();
    expect(placeholdersIn(long)).toEqual(["first", "second"]);
  });

  it("is string for non-literal text", () => {
    expectTypeOf<PlaceholdersOf<string>>().toEqualTypeOf<string>();
  });
});
