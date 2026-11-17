/**
 * Seed SQL for the default-locale copy (docs/designs/cms.md §8). Inserts only
 * missing rows, so running it on every deploy never overwrites CMS edits; bumps
 * the content version only when this run inserted something.
 */
export type SeedFile = {
  locale: string;
  entries: Record<string, Record<string, Record<string, unknown>>>;
};

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Catalog-shaped key definitions: collection → shape and key → placeholders. */
export type CatalogLike = Record<
  string,
  { shape: string; keys: Record<string, readonly string[]> }
>;

/**
 * Registry rows for a code-defined catalog, inserted only when missing.
 * Transitional: replaced by manifest sync (docs/plans/web-owned-catalog.md).
 */
export const registrySql = (catalog: CatalogLike, timestamp: string) => {
  const lines: string[] = [];
  for (const [collection, { shape, keys }] of Object.entries(catalog)) {
    lines.push(
      `INSERT INTO collections (name, shape, created_at) VALUES (${[collection, shape, timestamp].map(literal).join(", ")}) ON CONFLICT (name) DO NOTHING;`,
    );
    for (const [key, placeholders] of Object.entries(keys))
      lines.push(
        `INSERT INTO keys (collection, key, placeholders, status, created_at, updated_at) VALUES (${[
          collection,
          key,
          JSON.stringify(placeholders),
          "active",
          timestamp,
          timestamp,
        ]
          .map(literal)
          .join(", ")}) ON CONFLICT (collection, key) DO NOTHING;`,
      );
  }
  return `${lines.join("\n")}\n`;
};

/** One statement per line (JSON escapes newlines inside values). */
export const seedSql = (seed: SeedFile, timestamp: string) => {
  const lines: string[] = [];
  for (const [collection, entries] of Object.entries(seed.entries))
    for (const [key, fields] of Object.entries(entries))
      lines.push(
        `INSERT INTO translations (collection, key, locale, fields, revision, origin, updated_at) VALUES (${[
          collection,
          key,
          seed.locale,
          JSON.stringify(fields),
        ]
          .map(literal)
          .join(
            ", ",
          )}, 1, 'sync', ${literal(timestamp)}) ON CONFLICT (collection, key, locale) DO NOTHING;`,
      );
  lines.push(
    `UPDATE meta SET value = value + 1 WHERE key = 'content_version' AND EXISTS (SELECT 1 FROM translations WHERE updated_at = ${literal(timestamp)});`,
  );
  return `${lines.join("\n")}\n`;
};
