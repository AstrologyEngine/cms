import { isShape, validateFields } from "@astrologyengine/cms-contract/shapes";
import { describe, expect, it } from "vitest";

const sun = {
  name: "Sun",
  insight: "The Sun symbolizes identity.",
  keywords: ["identity", "purpose"],
};

const pathsOf = (result: ReturnType<typeof validateFields>) =>
  result.ok ? [] : result.issues.map((issue) => issue.path);

describe("validateFields", () => {
  it("accepts each shape and returns the fields", () => {
    expect(validateFields("named", sun)).toEqual({ ok: true, fields: sun });
    expect(
      validateFields("reference", { insight: "Presence.", keywords: ["a"] }),
    ).toEqual({
      ok: true,
      fields: { insight: "Presence.", keywords: ["a"] },
    });
    expect(validateFields("text", { text: "Explore\nyour chart." })).toEqual({
      ok: true,
      fields: { text: "Explore\nyour chart." },
    });
  });

  it("accepts values at the limits", () => {
    expect(
      validateFields("named", {
        name: "n".repeat(100),
        insight: "i".repeat(2000),
        keywords: Array(8).fill("k".repeat(50)),
      }).ok,
    ).toBe(true);
    expect(validateFields("text", { text: "t".repeat(2000) }).ok).toBe(true);
  });

  it.each([
    ["missing field", { name: "Sun", keywords: ["a"] }, ["insight"]],
    [
      "unknown field",
      { name: "Sun", insight: "x", keywords: ["a"], extra: 1 },
      ["extra"],
    ],
    ["empty name", { name: "", insight: "x", keywords: ["a"] }, ["name"]],
    ["padded name", { name: " Sun", insight: "x", keywords: ["a"] }, ["name"]],
    [
      "blank insight",
      { name: "Sun", insight: "   ", keywords: ["a"] },
      ["insight"],
    ],
    ["non-string name", { name: 1, insight: "x", keywords: ["a"] }, ["name"]],
    ["no keywords", { name: "Sun", insight: "x", keywords: [] }, ["keywords"]],
    [
      "too many keywords",
      { name: "Sun", insight: "x", keywords: Array(9).fill("a") },
      ["keywords"],
    ],
    [
      "keywords not an array",
      { name: "Sun", insight: "x", keywords: "a" },
      ["keywords"],
    ],
    [
      "empty keyword",
      { name: "Sun", insight: "x", keywords: ["a", ""] },
      ["keywords.1"],
    ],
    [
      "long keyword",
      { name: "Sun", insight: "x", keywords: ["k".repeat(51)] },
      ["keywords.0"],
    ],
    [
      "long name",
      { name: "n".repeat(101), insight: "x", keywords: ["a"] },
      ["name"],
    ],
    [
      "long insight",
      { name: "Sun", insight: "i".repeat(2001), keywords: ["a"] },
      ["insight"],
    ],
    ["not an object", "Sun", [""]],
    ["an array", [sun], [""]],
    ["null", null, [""]],
  ])("rejects a named entry with %s", (_label, fields, paths) => {
    const result = validateFields("named", fields);
    expect(result.ok).toBe(false);
    expect(pathsOf(result)).toEqual(paths);
    if (!result.ok)
      for (const issue of result.issues) expect(issue.message).toMatch(/\S/);
  });

  it("reports every issue, not just the first", () => {
    expect(
      pathsOf(
        validateFields("named", { name: "", keywords: [], extra: 1 }),
      ).sort(),
    ).toEqual(["extra", "insight", "keywords", "name"]);
  });

  it("rejects a name on reference entries and extra fields on text", () => {
    expect(
      pathsOf(
        validateFields("reference", {
          name: "x",
          insight: "x",
          keywords: ["a"],
        }),
      ),
    ).toEqual(["name"]);
    expect(pathsOf(validateFields("text", { text: "x", name: "x" }))).toEqual([
      "name",
    ]);
  });

  it.each([
    ["empty", { text: "" }],
    ["blank", { text: "  " }],
    ["padded", { text: "x\n" }],
    ["too long", { text: "t".repeat(2001) }],
    ["not a string", { text: ["x"] }],
  ])("rejects %s text", (_label, fields) => {
    expect(pathsOf(validateFields("text", fields))).toEqual(["text"]);
  });
});

describe("isShape", () => {
  it("recognises the three shapes only", () => {
    expect(["named", "reference", "text"].every(isShape)).toBe(true);
    expect(isShape("rich")).toBe(false);
    expect(isShape(undefined)).toBe(false);
  });
});
