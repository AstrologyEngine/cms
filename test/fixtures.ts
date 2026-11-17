import type { Shape } from "@astrologyengine/cms-contract/shapes";
import type { Registry } from "../src/registry";

/**
 * Small catalog for route tests (collection → shape, key → placeholders);
 * `resetDb` registers it as active keys. The real one is tested separately.
 */
export const testCatalog = {
  body: {
    shape: "named",
    keys: { SUN: [], MOON: [], MARS: [] },
  },
  house: { shape: "reference", keys: { "1": [], "2": [] } },
  ui: {
    shape: "text",
    keys: {
      "landing.title": [],
      "app.previous": ["date", "place"],
    },
  },
} as const;

/** Registry with every key of a catalog-shaped object active. */
export const registryFrom = (
  catalog: Record<
    string,
    { shape: Shape; keys: Record<string, readonly string[]> }
  >,
): Registry =>
  Object.fromEntries(
    Object.entries(catalog).map(([name, { shape, keys }]) => [
      name,
      {
        shape,
        keys: Object.fromEntries(
          Object.entries(keys).map(([key, placeholders]) => [
            key,
            { placeholders: [...placeholders], status: "active" as const },
          ]),
        ),
      },
    ]),
  );

export const testRegistry = registryFrom(testCatalog);

export const sun = {
  name: "Sun",
  insight: "The Sun symbolizes identity.",
  keywords: ["identity", "purpose"],
};
