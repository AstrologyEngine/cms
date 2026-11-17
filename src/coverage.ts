import { resolveEntry } from "./content";
import type { Locale, TranslationRecord } from "./db";
import { effectiveChain } from "./locales";
import { placeholdersIn, samePlaceholders } from "./placeholders";
import { activeCollections, activeKey, type Registry } from "./registry";

/**
 * Coverage of active keys per locale (what translators work on), plus the
 * unused keys (no longer in the website's manifest, still served).
 */
export const coverageReport = (
  registry: Registry,
  locales: Locale[],
  rows: TranslationRecord[],
) => {
  const ids = activeCollections(registry)
    .flatMap(([collection, , keys]) =>
      keys.map((key) => `${collection}:${key}`),
    )
    .sort();
  const byEntry = new Map<string, TranslationRecord[]>();
  for (const row of rows) {
    const id = `${row.collection}:${row.key}`;
    byEntry.set(id, [...(byEntry.get(id) ?? []), row]);
  }
  const mismatched = (row: TranslationRecord) => {
    if (registry[row.collection]?.shape !== "text") return false;
    const definition = activeKey(registry, row.collection, row.key)!;
    const { text } = JSON.parse(row.fields) as { text: string };
    return !samePlaceholders(definition.placeholders, placeholdersIn(text));
  };

  return {
    default: locales.find((locale) => locale.isDefault)!.code,
    total: ids.length,
    locales: locales.map((locale) => {
      const chain = effectiveChain(locale.code, locales);
      const missing: string[] = [];
      const fallbacks: Record<string, string | null> = {};
      const placeholderMismatches: string[] = [];
      for (const id of ids) {
        const entryRows = byEntry.get(id) ?? [];
        const own = entryRows.find((row) => row.locale === locale.code);
        if (own) {
          if (mismatched(own)) placeholderMismatches.push(id);
          continue;
        }
        missing.push(id);
        fallbacks[id] = resolveEntry(chain, entryRows)?.locale ?? null;
      }
      return {
        code: locale.code,
        enabled: locale.enabled,
        chain,
        translated: ids.length - missing.length,
        missing,
        fallbacks,
        placeholderMismatches,
        complete: !missing.length && !placeholderMismatches.length,
      };
    }),
    unused: Object.entries(registry)
      .flatMap(([collection, { keys }]) =>
        Object.keys(keys)
          .filter((key) => keys[key]!.status === "unused")
          .map((key) => `${collection}:${key}`),
      )
      .sort(),
  };
};
