/**
 * The key registry stored in D1 (docs/plans/web-owned-catalog.md §4): every
 * collection with its shape and every key with its placeholders and status.
 * It replaces the code-defined catalog.
 */
import type {
  CollectionDefinition,
  KeyDefinition,
} from "@astrologyengine/cms-contract/definitions";
import type { Shape } from "@astrologyengine/cms-contract/shapes";

export type Registry = Record<string, CollectionDefinition>;

type RegistryRow = {
  name: string;
  shape: Shape;
  key: string | null;
  placeholders: string | null;
  status: KeyDefinition["status"] | null;
};

/** The whole registry, in one query. */
export const loadRegistry = async (db: D1Database): Promise<Registry> => {
  const { results } = await db
    .prepare(
      `SELECT c.name, c.shape, k.key, k.placeholders, k.status
       FROM collections c LEFT JOIN keys k ON k.collection = c.name
       ORDER BY c.name, k.key`,
    )
    .all<RegistryRow>();
  const registry: Registry = Object.create(null);
  for (const row of results) {
    const collection = (registry[row.name] ??= { shape: row.shape, keys: {} });
    if (row.key !== null)
      collection.keys[row.key] = {
        placeholders: JSON.parse(row.placeholders!) as string[],
        status: row.status!,
      };
  }
  return registry;
};

type Statuses = readonly KeyDefinition["status"][];
const ACTIVE: Statuses = ["active"];
/** Served publicly and editable: unused keys stay live for older web builds. */
const SERVED: Statuses = ["active", "unused"];

/** The key's definition, if it is registered. */
export const findKey = (
  registry: Registry,
  collection: string,
  key: string,
): KeyDefinition | undefined => {
  const keys = Object.hasOwn(registry, collection)
    ? registry[collection]!.keys
    : undefined;
  return keys && Object.hasOwn(keys, key) ? keys[key] : undefined;
};

const keyWith =
  (statuses: Statuses) =>
  (registry: Registry, collection: string, key: string) => {
    const found = findKey(registry, collection, key);
    return found && statuses.includes(found.status) ? found : undefined;
  };

/** The key's definition if it is registered and active. */
export const activeKey = keyWith(ACTIVE);
/** The key's definition if it is active or unused. */
export const servedKey = keyWith(SERVED);

const collectionsWith = (statuses: Statuses) => (registry: Registry) =>
  Object.entries(registry)
    .map(
      ([name, { shape, keys }]) =>
        [
          name,
          shape,
          Object.keys(keys).filter((key) =>
            statuses.includes(keys[key]!.status),
          ),
        ] as const,
    )
    .filter(([, , keys]) => keys.length > 0);

/** Active keys per collection (collections without any are omitted). */
export const activeCollections = collectionsWith(ACTIVE);
/** Active and unused keys per collection (collections without any are omitted). */
export const servedCollections = collectionsWith(SERVED);
