import type { Definitions } from "@astrologyengine/cms-contract/definitions";
import {
  checkManifest,
  type Manifest,
} from "@astrologyengine/cms-contract/manifest";
import { describe, expect, it } from "vitest";

const sun = { name: "Sun", insight: "Identity.", keywords: ["identity"] };
const moon = { name: "Moon", insight: "Feeling.", keywords: ["feeling"] };

const definitions: Definitions = {
  default: "en",
  version: 7,
  collections: {
    body: {
      shape: "named",
      keys: {
        SUN: { placeholders: [], status: "active" },
        MOON: { placeholders: [], status: "unused" },
        VULCAN: { placeholders: [], status: "deleted" },
      },
    },
    ui: {
      shape: "text",
      keys: {
        "app.title": { placeholders: [], status: "active" },
        "app.previous": { placeholders: ["date", "place"], status: "active" },
        "app.old": { placeholders: [], status: "active" },
        "app.legacy": { placeholders: ["n"], status: "unused" },
      },
    },
  },
};

const base = {
  locale: "en",
  collections: {
    body: { shape: "named", entries: { SUN: sun } },
    ui: {
      shape: "text",
      entries: {
        "app.title": "Explorer",
        "app.previous": "From {place} on {date}.",
        "app.old": "Old.",
      },
    },
  },
} satisfies Manifest;

/** `base` with one collection's entries replaced. */
const withEntries = (collection: "body" | "ui", entries: object) => ({
  ...base,
  collections: {
    ...base.collections,
    [collection]: { ...base.collections[collection], entries },
  },
});

const empty: Definitions = { default: "en", version: 1, collections: {} };

describe("checkManifest", () => {
  it("creates everything in a fresh environment", () => {
    expect(checkManifest(base, empty)).toEqual({
      ok: true,
      conflicts: [],
      issues: [],
      createdCollections: ["body", "ui"],
      created: ["body:SUN", "ui:app.old", "ui:app.previous", "ui:app.title"],
      reactivated: [],
      unused: [],
    });
  });

  it("reports nothing for a manifest that matches", () => {
    expect(checkManifest(base, definitions)).toEqual({
      ok: true,
      conflicts: [],
      issues: [],
      createdCollections: [],
      created: [],
      reactivated: [],
      unused: [],
    });
  });

  it("treats placeholders as a set", () => {
    const manifest = withEntries("ui", {
      ...base.collections.ui.entries,
      "app.previous": "{date}: from {place}, again {date}.",
    });
    expect(checkManifest(manifest, definitions).ok).toBe(true);
  });

  it("marks active keys the manifest dropped as unused", () => {
    const { "app.old": _dropped, ...rest } = base.collections.ui.entries;
    expect(checkManifest(withEntries("ui", rest), definitions)).toMatchObject({
      ok: true,
      unused: ["ui:app.old"],
    });
  });

  it("marks every active key of a dropped collection as unused", () => {
    const manifest = { locale: "en", collections: { ui: base.collections.ui } };
    expect(checkManifest(manifest, definitions)).toMatchObject({
      ok: true,
      unused: ["body:SUN"],
    });
  });

  it("creates new keys and reactivates unused ones", () => {
    const manifest = withEntries("body", {
      SUN: sun,
      MOON: moon,
      MARS: { ...sun, name: "Mars" },
    });
    expect(checkManifest(manifest, definitions)).toMatchObject({
      ok: true,
      created: ["body:MARS"],
      reactivated: ["body:MOON"],
    });
  });

  it("rejects changed placeholders, including on unused keys", () => {
    const manifest = withEntries("ui", {
      ...base.collections.ui.entries,
      "app.previous": "From {date}.",
      "app.legacy": "No count.",
    });
    expect(checkManifest(manifest, definitions)).toMatchObject({
      ok: false,
      conflicts: [
        {
          code: "placeholders_changed",
          collection: "ui",
          key: "app.legacy",
          expected: ["n"],
          actual: [],
        },
        {
          code: "placeholders_changed",
          collection: "ui",
          key: "app.previous",
          expected: ["date", "place"],
          actual: ["date"],
        },
      ],
      reactivated: [],
    });
  });

  it("rejects a changed collection shape without checking its keys", () => {
    const manifest = {
      ...base,
      collections: {
        ...base.collections,
        body: {
          shape: "reference",
          entries: { NEW: { insight: "x", keywords: ["a"] } },
        },
      },
    };
    expect(checkManifest(manifest, definitions)).toMatchObject({
      ok: false,
      conflicts: [
        {
          code: "shape_changed",
          collection: "body",
          expected: "named",
          actual: "reference",
        },
      ],
      created: [],
    });
  });

  it("rejects retired keys, even with the same definition", () => {
    const manifest = withEntries("body", {
      SUN: sun,
      VULCAN: { ...sun, name: "Vulcan" },
    });
    expect(checkManifest(manifest, definitions)).toMatchObject({
      ok: false,
      conflicts: [{ code: "key_retired", collection: "body", key: "VULCAN" }],
      created: [],
    });
  });

  it("requires the CMS default locale, compared canonically", () => {
    expect(checkManifest({ ...base, locale: "EN" }, definitions).ok).toBe(true);
    expect(checkManifest({ ...base, locale: "es" }, definitions)).toMatchObject(
      {
        ok: false,
        conflicts: [{ code: "locale_mismatch", expected: "en", actual: "es" }],
      },
    );
  });

  it.each([
    ["a non-object manifest", "manifest", ""],
    ["a missing locale", { collections: {} }, "locale"],
    [
      "an invalid locale tag",
      { locale: "not a tag!", collections: {} },
      "locale",
    ],
    [
      "non-object collections",
      { locale: "en", collections: [] },
      "collections",
    ],
  ])("reports %s", (_label, manifest, path) => {
    const result = checkManifest(manifest, empty);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual([path]);
  });

  it("reports invalid names, shapes and fields with their paths", () => {
    const manifest = {
      locale: "en",
      collections: {
        Body: { shape: "named", entries: {} },
        x: { shape: "rich", entries: {} },
        y: { shape: "text", entries: [] },
        body: {
          shape: "named",
          entries: {
            "bad key": sun,
            SUN: { name: "Sun", keywords: ["identity"] },
          },
        },
        ui: {
          shape: "text",
          entries: { "app.title": "  padded", "app.count": 3 },
        },
      },
    };
    const result = checkManifest(manifest, empty);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.path).sort()).toEqual([
      "collections.Body",
      "collections.body.entries.SUN.insight",
      "collections.body.entries.bad key",
      "collections.ui.entries.app.count",
      "collections.ui.entries.app.title",
      "collections.x.shape",
      "collections.y.entries",
    ]);
    for (const issue of result.issues) expect(issue.message).toMatch(/\S/);
  });
});

describe("checkManifest with prototype-like names", () => {
  it("treats them as ordinary new collections and keys", () => {
    const manifest = {
      locale: "en",
      collections: {
        constructor: { shape: "text", entries: { toString: "x" } },
      },
    };
    expect(checkManifest(manifest, definitions)).toMatchObject({
      ok: true,
      createdCollections: ["constructor"],
      created: ["constructor:toString"],
    });
  });
});
