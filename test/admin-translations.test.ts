import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addLocale,
  addTranslation,
  admin,
  registerKeys,
  resetDb,
  revisions,
  version,
} from "./helpers";
import { sun } from "./fixtures";

beforeEach(resetDb);

const path = (collection: string, key: string, locale?: string) =>
  `/v1/admin/entries/${collection}/${key}${locale ? `/translations/${locale}` : ""}`;
const put = (
  collection: string,
  key: string,
  locale: string,
  json: unknown,
  headers: Record<string, string> = {},
) => admin(path(collection, key, locale), { method: "PUT", json, headers });
const del = (
  collection: string,
  key: string,
  locale: string,
  headers: Record<string, string> = {},
) => admin(path(collection, key, locale), { method: "DELETE", headers });
const stored = (collection: string, key: string, locale: string) =>
  env.DB.prepare(
    "SELECT * FROM translations WHERE collection = ? AND key = ? AND locale = ?",
  )
    .bind(collection, key, locale)
    .first<{ fields: string; revision: number }>();

describe("GET /v1/admin/entries/:collection/:key", () => {
  it("returns every stored translation with its revision", async () => {
    await addLocale("fr", { enabled: false });
    await addTranslation("body", "SUN", "en", sun);
    await addTranslation("body", "SUN", "fr", { ...sun, name: "Soleil" });
    const response = await admin(path("body", "SUN"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      collection: "body",
      key: "SUN",
      status: "active",
      shape: "named",
      placeholders: [],
      translations: [
        {
          locale: "en",
          fields: sun,
          revision: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          locale: "fr",
          fields: { ...sun, name: "Soleil" },
          revision: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("shows each key's status, shape and placeholders", async () => {
    await addTranslation("body", "PLUTO", "en", sun);
    await registerKeys({
      body: {
        shape: "named",
        keys: { VULCAN: { placeholders: [], status: "deleted" } },
      },
    });
    expect(await (await admin(path("body", "PLUTO"))).json()).toMatchObject({
      status: "unused",
      shape: "named",
      translations: [{ locale: "en" }],
    });
    expect(await (await admin(path("body", "VULCAN"))).json()).toMatchObject({
      status: "deleted",
      translations: [],
    });
    const text = await (await admin(path("ui", "app.previous"))).json();
    expect(text).toMatchObject({
      status: "active",
      shape: "text",
      placeholders: ["date", "place"],
      translations: [],
    });
    expect(text).not.toHaveProperty("inCatalog");
  });

  it("answers 404 unknown_entry for unknown, unstored entries", async () => {
    const response = await admin(path("body", "PLUTO"));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "unknown_entry" },
    });
  });
});

describe("PUT …/translations/:locale", () => {
  it("creates a translation (201) with an ETag, revision and version bump", async () => {
    const response = await put("body", "SUN", "en", sun, {
      "x-cms-actor": "amy",
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("etag")).toBe('"r1"');
    expect(await response.json()).toMatchObject({
      collection: "body",
      key: "SUN",
      locale: "en",
      fields: sun,
      revision: 1,
    });
    expect(await version()).toBe(2);
    expect(await revisions()).toEqual([
      expect.objectContaining({
        subject: "translation",
        action: "create",
        collection: "body",
        key: "SUN",
        locale: "en",
        before: null,
        after: JSON.stringify(sun),
        actor: "amy",
      }),
    ]);
  });

  it("replaces an existing translation (200) and increments its revision", async () => {
    await addTranslation("body", "SUN", "en", sun);
    const next = { ...sun, insight: "Updated." };
    const response = await put("body", "SUN", "en", next);
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"r2"');
    expect(JSON.parse((await stored("body", "SUN", "en"))!.fields)).toEqual(
      next,
    );
    const [revision] = await revisions();
    expect(revision).toMatchObject({ action: "update" });
    expect(JSON.parse(revision!.before!)).toEqual(sun);
  });

  it("applies If-Match only when the revision matches", async () => {
    await addTranslation("body", "SUN", "en", sun);
    const next = { ...sun, insight: "Changed." };
    const stale = await put("body", "SUN", "en", next, { "if-match": '"r0"' });
    expect(stale.status).toBe(412);
    expect(await stale.json()).toMatchObject({
      error: { code: "precondition_failed" },
    });
    expect(await version()).toBe(1);
    expect(await revisions()).toEqual([]);
    const fresh = await put("body", "SUN", "en", next, { "if-match": '"r1"' });
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("etag")).toBe('"r2"');
    const any = await put("body", "SUN", "en", sun, { "if-match": "*" });
    expect(any.status).toBe(200);
  });

  it("fails If-Match for a missing translation", async () => {
    const response = await put("body", "SUN", "en", sun, {
      "if-match": '"r1"',
    });
    expect(response.status).toBe(412);
    expect(await stored("body", "SUN", "en")).toBeNull();
  });

  it("creates only with If-None-Match: *", async () => {
    expect(
      (await put("body", "SUN", "en", sun, { "if-none-match": "*" })).status,
    ).toBe(201);
    const again = await put("body", "SUN", "en", sun, { "if-none-match": "*" });
    expect(again.status).toBe(412);
    expect(await version()).toBe(2);
  });

  it("accepts any existing locale, enabled or not, canonicalising it", async () => {
    await addLocale("es-MX", { enabled: false });
    const response = await put("body", "SUN", "es-mx", { ...sun, name: "Sol" });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ locale: "es-MX" });
  });

  it("answers 404 locale_not_found for unknown locales", async () => {
    const response = await put("body", "SUN", "de", sun);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "locale_not_found" },
    });
  });

  it("answers 404 unknown_entry outside the catalog", async () => {
    const response = await put("body", "PLUTO", "en", sun);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "unknown_entry" },
    });
  });

  it("marks admin writes as editor-originated, on create and update", async () => {
    await addTranslation("body", "SUN", "en", sun, "sync");
    await put("body", "SUN", "en", { ...sun, insight: "Edited." });
    await addLocale("fr");
    await addTranslation("body", "SUN", "fr", sun, "sync");
    // The If-Match path is a separate UPDATE statement.
    await put("body", "SUN", "fr", sun, { "if-match": '"r1"' });
    await addLocale("de");
    await put("body", "SUN", "de", { ...sun, name: "Sonne" });
    const origins = await env.DB.prepare(
      "SELECT locale, origin FROM translations WHERE key = 'SUN' ORDER BY locale",
    ).all<{ locale: string; origin: string }>();
    expect(origins.results).toEqual([
      { locale: "de", origin: "editor" },
      { locale: "en", origin: "editor" },
      { locale: "fr", origin: "editor" },
    ]);
  });

  it("validates text against the key's stored placeholders", async () => {
    await registerKeys({
      ui: {
        shape: "text",
        keys: { "app.count": { placeholders: ["n"], status: "active" } },
      },
    });
    expect(
      (await put("ui", "app.count", "en", { text: "{n} left" })).status,
    ).toBe(201);
    expect(
      await (await put("ui", "app.count", "en", { text: "{m} left" })).json(),
    ).toMatchObject({
      error: { code: "placeholder_mismatch", expected: ["n"], actual: ["m"] },
    });
  });

  it("answers 422 for invalid fields and placeholder mismatches", async () => {
    const invalid = await put("body", "SUN", "en", { name: "Sun" });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({
      error: { code: "validation_failed", issues: expect.any(Array) },
    });
    const mismatch = await put("ui", "app.previous", "en", {
      text: "From {date}.",
    });
    expect(mismatch.status).toBe(422);
    expect(await mismatch.json()).toMatchObject({
      error: {
        code: "placeholder_mismatch",
        expected: ["date", "place"],
        actual: ["date"],
      },
    });
    expect(await version()).toBe(1);
  });
});

describe("DELETE …/translations/:locale", () => {
  beforeEach(async () => {
    await addLocale("fr");
    await addTranslation("body", "SUN", "en", sun);
    await addTranslation("body", "SUN", "fr", { ...sun, name: "Soleil" });
  });

  it("deletes a translation with a revision and version bump", async () => {
    const response = await del("body", "SUN", "fr");
    expect(response.status).toBe(204);
    expect(await stored("body", "SUN", "fr")).toBeNull();
    expect(await revisions()).toEqual([
      expect.objectContaining({
        subject: "translation",
        action: "delete",
        locale: "fr",
        after: null,
      }),
    ]);
    expect(await version()).toBe(2);
  });

  it("honours If-Match", async () => {
    expect(
      (await del("body", "SUN", "fr", { "if-match": '"r9"' })).status,
    ).toBe(412);
    expect(
      (await del("body", "SUN", "fr", { "if-match": '"r1"' })).status,
    ).toBe(204);
  });

  it("refuses to delete default-locale text of a catalog entry", async () => {
    const response = await del("body", "SUN", "en");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "conflict" },
    });
  });

  it("deletes other locales of unused keys but keeps their default text", async () => {
    await addTranslation("body", "PLUTO", "en", sun);
    await addTranslation("body", "PLUTO", "fr", sun);
    expect((await del("body", "PLUTO", "fr")).status).toBe(204);
    const response = await del("body", "PLUTO", "en");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "conflict" },
    });
  });

  it("answers 404 for missing translations", async () => {
    expect((await del("body", "MOON", "fr")).status).toBe(404);
    expect((await del("body", "SUN", "de")).status).toBe(404);
  });
});

describe("translation writes by key status", () => {
  beforeEach(async () => {
    await addLocale("fr");
    await registerKeys({
      body: {
        shape: "named",
        keys: { VULCAN: { placeholders: [], status: "deleted" } },
      },
    });
    await addTranslation("body", "PLUTO", "en", sun); // unused
    await addTranslation("body", "VULCAN", "en", sun);
    await addTranslation("body", "VULCAN", "fr", sun);
  });

  it("lets editors fix the text of unused keys", async () => {
    const response = await put("body", "PLUTO", "en", {
      ...sun,
      insight: "Fixed.",
    });
    expect(response.status).toBe(200);
    expect((await put("body", "PLUTO", "fr", sun)).status).toBe(201);
  });

  it("refuses writes to deleted keys until they are restored", async () => {
    for (const response of [
      await put("body", "VULCAN", "en", sun),
      await put("body", "VULCAN", "fr", sun),
      await del("body", "VULCAN", "fr"),
    ]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "conflict" },
      });
    }
    expect(await stored("body", "VULCAN", "fr")).not.toBeNull();
  });
});
