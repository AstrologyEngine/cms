/**
 * The website's content manifest: collections, keys and approved default-locale
 * text. Web owns it; deploys sync it to the CMS (docs/plans/web-owned-catalog.md).
 */
import type { Definitions } from "./definitions.js";
import { canonicalLocale } from "./locales.js";
import {
  placeholdersIn,
  samePlaceholders,
  type PlaceholdersOf,
} from "./placeholders.js";
import {
  isShape,
  validateFields,
  type FieldsOf,
  type Shape,
} from "./shapes.js";

type ManifestFields<S extends "named" | "reference"> = {
  readonly [F in keyof FieldsOf<S>]: FieldsOf<S>[F] extends string[]
    ? readonly string[]
    : FieldsOf<S>[F];
};

export type ManifestCollection =
  | {
      readonly shape: "named";
      readonly entries: { readonly [key: string]: ManifestFields<"named"> };
    }
  | {
      readonly shape: "reference";
      readonly entries: { readonly [key: string]: ManifestFields<"reference"> };
    }
  | {
      readonly shape: "text";
      /** Text entries are plain strings so their placeholders can be typed. */
      readonly entries: { readonly [key: string]: string };
    };

export type Manifest = {
  readonly locale: string;
  readonly collections: { readonly [name: string]: ManifestCollection };
};

/** Identity helper that keeps literal types for key and placeholder inference. */
export const defineManifest = <const M extends Manifest>(manifest: M): M =>
  manifest;

type CollectionsMap<M extends Manifest> = M["collections"];

/** Names of the manifest's collections. */
export type CollectionsOf<M extends Manifest> = keyof CollectionsMap<M> &
  string;

/** Names of the manifest's `text` collections. */
export type TextCollectionsOf<M extends Manifest> = {
  [C in CollectionsOf<M>]: CollectionsMap<M>[C]["shape"] extends "text"
    ? C
    : never;
}[CollectionsOf<M>];

/** Keys of one collection. */
export type KeysOf<
  M extends Manifest,
  C extends CollectionsOf<M>,
> = keyof CollectionsMap<M>[C]["entries"] & string;

/** Keys of one `text` collection. */
export type TextKeys<
  M extends Manifest,
  C extends TextCollectionsOf<M>,
> = KeysOf<M, C>;

/** Parameters a text key's placeholders require, e.g. `{ name: string | number }`. */
export type ParamsOf<
  M extends Manifest,
  C extends TextCollectionsOf<M>,
  K extends TextKeys<M, C>,
> = {
  [P in PlaceholdersOf<CollectionsMap<M>[C]["entries"][K] & string>]:
    | string
    | number;
};

/** Fields the CMS serves for an entry (its collection shape's fields). */
export type EntryOf<
  M extends Manifest,
  C extends CollectionsOf<M>,
  // Constrains K to the collection's keys; the fields depend on the shape only.
  _K extends KeysOf<M, C>,
> = FieldsOf<CollectionsMap<M>[C]["shape"]>;

export type ManifestConflict =
  | { code: "locale_mismatch"; expected: string; actual: string }
  | {
      code: "shape_changed";
      collection: string;
      expected: Shape;
      actual: Shape;
    }
  | {
      code: "placeholders_changed";
      collection: string;
      key: string;
      expected: string[];
      actual: string[];
    }
  | { code: "key_retired"; collection: string; key: string };

export type ManifestIssue = { path: string; message: string };

export type ManifestCheck = {
  ok: boolean;
  conflicts: ManifestConflict[];
  issues: ManifestIssue[];
  /** New collections. */
  createdCollections: string[];
  /** New keys, as `collection:key`. */
  created: string[];
  /** Unused keys the manifest brings back, as `collection:key`. */
  reactivated: string[];
  /** Active keys the manifest no longer has, as `collection:key`. */
  unused: string[];
};

const COLLECTION_NAME = /^[a-z]+$/;
const KEY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const own = <T>(record: Record<string, T>, name: string): T | undefined =>
  Object.hasOwn(record, name) ? record[name] : undefined;

/**
 * Compare a manifest with the CMS's definitions. Validates the manifest (it may
 * be untrusted JSON) and reports definition conflicts. Pure; shared by the
 * CMS sync endpoint and web's PR checks. Lists are sorted by collection, then key.
 */
export const checkManifest = (
  manifest: unknown,
  definitions: Definitions,
): ManifestCheck => {
  const result: ManifestCheck = {
    ok: false,
    conflicts: [],
    issues: [],
    createdCollections: [],
    created: [],
    reactivated: [],
    unused: [],
  };
  const issue = (path: string, message: string) =>
    result.issues.push({ path, message });
  const finish = () => {
    result.ok = !result.conflicts.length && !result.issues.length;
    return result;
  };

  if (!isRecord(manifest)) {
    issue("", "Manifest must be an object.");
    return finish();
  }
  if (typeof manifest.locale !== "string")
    issue("locale", "Required: the default locale's language tag.");
  else {
    const locale = canonicalLocale(manifest.locale);
    if (!locale) issue("locale", "Not a valid language tag.");
    else if (locale !== canonicalLocale(definitions.default))
      result.conflicts.push({
        code: "locale_mismatch",
        expected: definitions.default,
        actual: locale,
      });
  }
  if (!isRecord(manifest.collections)) {
    issue("collections", "Must be an object of collections.");
    return finish();
  }

  const present = new Set<string>();
  for (const name of Object.keys(manifest.collections).sort()) {
    const path = `collections.${name}`;
    const collection = manifest.collections[name];
    if (!COLLECTION_NAME.test(name)) {
      issue(path, "Collection names are lowercase letters only.");
      continue;
    }
    if (!isRecord(collection)) {
      issue(path, "Must be an object with shape and entries.");
      continue;
    }
    const { shape, entries } = collection;
    if (!isShape(shape)) {
      issue(`${path}.shape`, "Must be one of: named, reference, text.");
      continue;
    }
    if (!isRecord(entries)) {
      issue(`${path}.entries`, "Must be an object of entries.");
      continue;
    }
    const existing = own(definitions.collections, name);
    const keys = Object.keys(entries).sort();
    for (const key of keys) present.add(`${name}:${key}`);
    if (existing && existing.shape !== shape) {
      result.conflicts.push({
        code: "shape_changed",
        collection: name,
        expected: existing.shape,
        actual: shape,
      });
      continue;
    }
    if (!existing) result.createdCollections.push(name);

    for (const key of keys) {
      const keyPath = `${path}.entries.${key}`;
      if (!KEY_NAME.test(key)) {
        issue(keyPath, "Keys are 1–128 letters, digits, '.', '_' or '-'.");
        continue;
      }
      const value = entries[key];
      let placeholders: string[] = [];
      if (shape === "text") {
        if (typeof value !== "string") {
          issue(keyPath, "Text entries must be strings.");
          continue;
        }
        const checked = validateFields("text", { text: value });
        if (!checked.ok) {
          for (const { message } of checked.issues) issue(keyPath, message);
          continue;
        }
        placeholders = placeholdersIn(value);
      } else {
        const checked = validateFields(shape, value);
        if (!checked.ok) {
          for (const { path: field, message } of checked.issues)
            issue(field ? `${keyPath}.${field}` : keyPath, message);
          continue;
        }
      }

      const id = `${name}:${key}`;
      const definition = existing && own(existing.keys, key);
      if (!definition) result.created.push(id);
      else if (definition.status === "deleted")
        result.conflicts.push({ code: "key_retired", collection: name, key });
      else if (!samePlaceholders(definition.placeholders, placeholders))
        result.conflicts.push({
          code: "placeholders_changed",
          collection: name,
          key,
          expected: [...definition.placeholders],
          actual: placeholders,
        });
      else if (definition.status === "unused") result.reactivated.push(id);
    }
  }

  for (const name of Object.keys(definitions.collections).sort()) {
    const keys = definitions.collections[name]!.keys;
    for (const key of Object.keys(keys).sort())
      if (keys[key]!.status === "active" && !present.has(`${name}:${key}`))
        result.unused.push(`${name}:${key}`);
  }
  return finish();
};
