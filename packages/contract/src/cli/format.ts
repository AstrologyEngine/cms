import type { ManifestConflict, ManifestIssue } from "../manifest.js";

const set = (names: readonly string[]) => `{${names.join(", ")}}`;

/** One line per conflict, with what to do about it. */
export const describeConflict = (conflict: ManifestConflict) => {
  switch (conflict.code) {
    case "placeholders_changed":
      return `${conflict.collection}:${conflict.key}: placeholders changed (CMS ${set(conflict.expected)}, manifest ${set(conflict.actual)}); use a new key name.`;
    case "key_retired":
      return `${conflict.collection}:${conflict.key}: retired by an admin; ask them to restore it, or use a new key name.`;
    case "shape_changed":
      return `${conflict.collection}: shape changed (${conflict.expected} → ${conflict.actual}); use a new collection name.`;
    case "locale_mismatch":
      return `manifest locale '${conflict.actual}' must be the CMS default '${conflict.expected}'.`;
  }
};

export const describeIssue = ({ path, message }: ManifestIssue) =>
  `${path || "(manifest)"}: ${message}`;

/** Indented bullet list under a heading. */
export const section = (heading: string, lines: string[]) =>
  [heading, ...lines.map((line) => `  - ${line}`)].join("\n");
