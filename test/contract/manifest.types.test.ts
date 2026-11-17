import {
  defineManifest,
  type CollectionsOf,
  type EntryOf,
  type KeysOf,
  type ParamsOf,
  type TextCollectionsOf,
  type TextKeys,
} from "@astrologyengine/cms-contract/manifest";
import type {
  NamedFields,
  ReferenceFields,
  TextFields,
} from "@astrologyengine/cms-contract/shapes";
import { describe, expect, expectTypeOf, it } from "vitest";

const manifest = defineManifest({
  locale: "en",
  collections: {
    body: {
      shape: "named",
      entries: {
        SUN: { name: "Sun", insight: "Identity.", keywords: ["identity"] },
        MOON: { name: "Moon", insight: "Feeling.", keywords: ["feeling"] },
      },
    },
    house: {
      shape: "reference",
      entries: { "1": { insight: "Self.", keywords: ["self"] } },
    },
    ui: {
      shape: "text",
      entries: {
        "app.title": "Explorer",
        "app.status.updating": "Showing {shown}; you asked for {requested}.",
        "chart.house.name": "House {number}",
      },
    },
    errors: { shape: "text", entries: { "error.failed": "Failed." } },
  },
});
type M = typeof manifest;

/** The kind of `t()` the website builds on these helpers. */
const t = <K extends TextKeys<M, "ui">>(
  key: K,
  _params: ParamsOf<M, "ui", K>,
): string => key;

describe("manifest types", () => {
  it("defineManifest returns the manifest unchanged", () => {
    expect(defineManifest(manifest)).toBe(manifest);
  });

  it("lists collections and text collections", () => {
    expectTypeOf<CollectionsOf<M>>().toEqualTypeOf<
      "body" | "house" | "ui" | "errors"
    >();
    expectTypeOf<TextCollectionsOf<M>>().toEqualTypeOf<"ui" | "errors">();
  });

  it("lists keys per collection", () => {
    expectTypeOf<KeysOf<M, "body">>().toEqualTypeOf<"SUN" | "MOON">();
    expectTypeOf<KeysOf<M, "house">>().toEqualTypeOf<"1">();
    expectTypeOf<TextKeys<M, "ui">>().toEqualTypeOf<
      "app.title" | "app.status.updating" | "chart.house.name"
    >();
  });

  it("derives params from the English text", () => {
    expectTypeOf<ParamsOf<M, "ui", "app.status.updating">>().toEqualTypeOf<{
      shown: string | number;
      requested: string | number;
    }>();
    expectTypeOf<ParamsOf<M, "ui", "chart.house.name">>().toEqualTypeOf<{
      number: string | number;
    }>();
    expectTypeOf<ParamsOf<M, "ui", "app.title">>().toEqualTypeOf<{}>();
  });

  it("gives each entry its shape's fields", () => {
    expectTypeOf<EntryOf<M, "body", "SUN">>().toEqualTypeOf<NamedFields>();
    expectTypeOf<EntryOf<M, "house", "1">>().toEqualTypeOf<ReferenceFields>();
    expectTypeOf<EntryOf<M, "ui", "app.title">>().toEqualTypeOf<TextFields>();
  });

  it("rejects unknown keys and wrong params at compile time", () => {
    expectTypeOf(
      t("app.status.updating", { shown: 1, requested: "2" }),
    ).toBeString();
    expectTypeOf(t("app.title", {})).toBeString();
    // @ts-expect-error unknown key
    t("app.titel", {});
    // @ts-expect-error missing param
    t("app.status.updating", { shown: 1 });
    // @ts-expect-error extra param
    t("app.status.updating", { shown: 1, requested: 2, extra: 3 });
    // @ts-expect-error key from another text collection
    t("error.failed", {});
  });

  it("limits text helpers to text collections", () => {
    // @ts-expect-error body is a named collection
    expectTypeOf<TextKeys<M, "body">>().toBeNever();
    // @ts-expect-error unknown collection
    expectTypeOf<KeysOf<M, "planet">>().toBeNever();
  });

  it("checks entries against their shape", () => {
    defineManifest({
      locale: "en",
      collections: {
        // @ts-expect-error named entries need a name
        body: {
          shape: "named",
          entries: { SUN: { insight: "x", keywords: ["a"] } },
        },
      },
    });
    defineManifest({
      locale: "en",
      // @ts-expect-error unknown shape
      collections: { x: { shape: "rich", entries: {} } },
    });
    defineManifest({
      locale: "en",
      // @ts-expect-error text entries are strings
      collections: { ui: { shape: "text", entries: { a: { text: "x" } } } },
    });
  });
});
