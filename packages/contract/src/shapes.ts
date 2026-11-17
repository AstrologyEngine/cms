/**
 * Field shapes (docs/designs/cms.md §5.2). The CMS owns this fixed set; a
 * collection names one. Dependency-free so the website can share the rules.
 */
export const shapes = ["named", "reference", "text"] as const;
export type Shape = (typeof shapes)[number];

export type NamedFields = { name: string; insight: string; keywords: string[] };
export type ReferenceFields = { insight: string; keywords: string[] };
export type TextFields = { text: string };
export type FieldsOf<S extends Shape> = {
  named: NamedFields;
  reference: ReferenceFields;
  text: TextFields;
}[S];

export type FieldIssue = { path: string; message: string };
export type FieldsResult<S extends Shape> =
  | { ok: true; fields: FieldsOf<S> }
  | { ok: false; issues: FieldIssue[] };

export const isShape = (value: unknown): value is Shape =>
  (shapes as readonly unknown[]).includes(value);

type Rule = (value: unknown, path: string, issues: FieldIssue[]) => void;

/** Plain text: 1–`max` characters, not blank, no leading/trailing whitespace. */
const text =
  (max: number): Rule =>
  (value, path, issues) => {
    const fail = (message: string) => issues.push({ path, message });
    if (typeof value !== "string") return fail("Must be a string.");
    if (!value.trim()) return fail("Must not be blank.");
    if (value.length > max) return fail(`Must be at most ${max} characters.`);
    if (value.trim() !== value)
      return fail("Must not have leading or trailing whitespace.");
  };

const keywords: Rule = (value, path, issues) => {
  if (!Array.isArray(value))
    return issues.push({ path, message: "Must be a list of keywords." });
  if (value.length < 1 || value.length > 8)
    issues.push({ path, message: "Must have 1–8 keywords." });
  value.forEach((keyword, index) =>
    text(50)(keyword, `${path}.${index}`, issues),
  );
};

const rules: Record<Shape, Record<string, Rule>> = {
  named: { name: text(100), insight: text(2000), keywords },
  reference: { insight: text(2000), keywords },
  text: { text: text(2000) },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Validate fields for a shape (docs/designs/cms.md §5.2). Unknown fields are
 * rejected. Reports every failing field, one issue per path; `path` is dotted
 * (`keywords.1`) and empty for the whole value.
 */
export const validateFields = <S extends Shape>(
  shape: S,
  fields: unknown,
): FieldsResult<S> => {
  if (!isRecord(fields))
    return { ok: false, issues: [{ path: "", message: "Must be an object." }] };
  const spec = rules[shape];
  const issues: FieldIssue[] = [];
  for (const [name, rule] of Object.entries(spec)) {
    if (Object.hasOwn(fields, name)) rule(fields[name], name, issues);
    else issues.push({ path: name, message: "Required." });
  }
  for (const name of Object.keys(fields))
    if (!Object.hasOwn(spec, name))
      issues.push({ path: name, message: "Unknown field." });
  if (issues.length) return { ok: false, issues };
  const clean = Object.fromEntries(
    Object.keys(spec).map((name) => [name, fields[name]]),
  );
  return { ok: true, fields: clean as FieldsOf<S> };
};
