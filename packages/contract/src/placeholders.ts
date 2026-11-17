/**
 * `{name}` placeholders in text copy (docs/designs/cms.md §5.4). Dependency-free:
 * the CMS validates with these functions and the website derives types from them.
 */
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Unique `{name}` placeholders in order of first appearance. */
export const placeholdersIn = (text: string) => [
  ...new Set(Array.from(text.matchAll(PLACEHOLDER), (match) => match[1]!)),
];

export const samePlaceholders = (
  a: readonly string[],
  b: readonly string[],
) => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((name) => right.has(name));
};

type Lower =
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z";
type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type IdentifierStart = Lower | Uppercase<Lower> | "_";
type IdentifierPart = IdentifierStart | Digit;

type IsIdentifierRest<S extends string> = S extends ""
  ? true
  : S extends `${infer C}${infer Rest}`
    ? C extends IdentifierPart
      ? IsIdentifierRest<Rest>
      : false
    : false;

type IsIdentifier<S extends string> = S extends `${infer C}${infer Rest}`
  ? C extends IdentifierStart
    ? IsIdentifierRest<Rest>
    : false
  : false;

/** Tail-recursive scan: first `{`, then up to the next `}`; innermost `{` wins. */
type Scan<
  S extends string,
  Found extends string = never,
> = S extends `${string}{${infer Body}}${infer Rest}`
  ? Body extends `${string}{${infer Inner}`
    ? Scan<`{${Inner}}${Rest}`, Found>
    : Scan<Rest, IsIdentifier<Body> extends true ? Found | Body : Found>
  : Found;

/**
 * Placeholder names in a text literal, as a union:
 * `PlaceholdersOf<"Hi {name}">` is `"name"`. Mirrors `placeholdersIn`;
 * non-literal `string` gives `string`.
 */
export type PlaceholdersOf<S extends string> = string extends S
  ? string
  : Scan<S>;
