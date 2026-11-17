import { Hono, type Context } from "hono";
import type { Definitions } from "@astrologyengine/cms-contract/definitions";
import type { AppEnv } from "../app";
import { buildEntries, resolveEntry } from "../content";
import {
  contentVersion,
  entryTranslations,
  listLocales,
  translationsIn,
} from "../db";
import { apiError, publicVersioned } from "../http";
import { canonicalLocale, effectiveChain } from "../locales";
import { loadRegistry, servedKey } from "../registry";

/** The enabled locale named in the path, with its chain; 404 otherwise. */
const availableLocale = async (c: Context<AppEnv>, requested: string) => {
  const code = canonicalLocale(requested);
  const locales = await listLocales(c.env.DB);
  const locale = locales.find(
    (candidate) => candidate.code === code && candidate.enabled,
  );
  if (!locale)
    throw apiError(
      404,
      "locale_not_found",
      `Locale '${requested}' is not available.`,
    );
  const fallbackDefault = locales.find((candidate) => candidate.isDefault)!;
  return {
    code: locale.code,
    defaultCode: fallbackDefault.code,
    chain: effectiveChain(locale.code, locales),
  };
};

export const publicRoutes = () => {
  const routes = new Hono<AppEnv>();

  routes.get("/v1/locales", async (c) =>
    publicVersioned(c, await contentVersion(c.env.DB), async () => {
      const locales = await listLocales(c.env.DB);
      const fallbackDefault = locales.find((locale) => locale.isDefault)!;
      return {
        default: fallbackDefault.code,
        locales: locales
          .filter((locale) => locale.enabled)
          .map((locale) => ({
            code: locale.code,
            name: locale.name,
            chain: effectiveChain(locale.code, locales),
          })),
      };
    }),
  );

  // Every collection and key (deleted ones too, so web's PR checks can spot
  // retired names), without text. Key names are public through bundles anyway.
  routes.get("/v1/definitions", async (c) => {
    const version = await contentVersion(c.env.DB);
    return publicVersioned(c, version, async () => {
      const [registry, locales] = await Promise.all([
        loadRegistry(c.env.DB),
        listLocales(c.env.DB),
      ]);
      return {
        default: locales.find((locale) => locale.isDefault)!.code,
        version,
        collections: registry,
      } satisfies Definitions;
    });
  });

  routes.get("/v1/content/:locale", async (c) => {
    const locale = await availableLocale(c, c.req.param("locale"));
    const version = await contentVersion(c.env.DB);
    return publicVersioned(c, version, async () => {
      const [registry, rows] = await Promise.all([
        loadRegistry(c.env.DB),
        translationsIn(c.env.DB, locale.chain),
      ]);
      return {
        locale: locale.code,
        default: locale.defaultCode,
        chain: locale.chain,
        version,
        ...buildEntries(registry, locale.chain, rows),
      };
    });
  });

  routes.get("/v1/content/:locale/:collection/:key", async (c) => {
    const { collection, key } = c.req.param();
    const locale = await availableLocale(c, c.req.param("locale"));
    if (!servedKey(await loadRegistry(c.env.DB), collection, key))
      throw apiError(
        404,
        "unknown_entry",
        `'${collection}:${key}' is not registered.`,
      );
    return publicVersioned(c, await contentVersion(c.env.DB), async () => {
      const rows = await entryTranslations(
        c.env.DB,
        collection,
        key,
        locale.chain,
      );
      const resolved = resolveEntry(locale.chain, rows);
      if (!resolved)
        throw apiError(404, "not_found", "Entry has no translation.");
      return {
        collection,
        key,
        locale: resolved.locale,
        fallback: resolved.locale !== locale.code,
        fields: resolved.fields,
      };
    });
  });

  return routes;
};
