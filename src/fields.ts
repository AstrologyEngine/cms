import { validateFields as validateShape } from "@astrologyengine/cms-contract/shapes";
import { placeholdersIn, samePlaceholders } from "./placeholders";
import { servedKey, type Registry } from "./registry";

export type FieldsResult =
  | { ok: true; fields: Record<string, unknown> }
  | {
      ok: false;
      code: "unknown_entry" | "validation_failed" | "placeholder_mismatch";
      message: string;
      [detail: string]: unknown;
    };

/** Validate translation fields for a served (active or unused) key. */
export const validateFields = (
  registry: Registry,
  collection: string,
  key: string,
  fields: unknown,
): FieldsResult => {
  const definition = servedKey(registry, collection, key);
  if (!definition)
    return {
      ok: false,
      code: "unknown_entry",
      message: `'${collection}:${key}' is not registered.`,
    };
  const checked = validateShape(registry[collection]!.shape, fields);
  if (!checked.ok)
    return {
      ok: false,
      code: "validation_failed",
      message: "Fields are invalid.",
      issues: checked.issues,
    };
  if ("text" in checked.fields) {
    const expected = definition.placeholders;
    const actual = placeholdersIn(checked.fields.text);
    if (!samePlaceholders(expected, actual))
      return {
        ok: false,
        code: "placeholder_mismatch",
        message: "Text must use exactly the declared placeholders.",
        expected: [...expected],
        actual,
      };
  }
  return { ok: true, fields: checked.fields };
};
