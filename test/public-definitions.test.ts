import { beforeEach, describe, expect, it } from "vitest";
import {
  addTranslation,
  call,
  registerKeys,
  resetDb,
  setVersion,
} from "./helpers";
import { sun } from "./fixtures";

beforeEach(async () => {
  await resetDb();
  await registerKeys({
    body: {
      shape: "named",
      keys: {
        PLUTO: { placeholders: [], status: "unused" },
        VULCAN: { placeholders: [], status: "deleted" },
      },
    },
  });
  await addTranslation("body", "SUN", "en", sun);
  await setVersion(9);
});

const active = { placeholders: [], status: "active" };

describe("GET /v1/definitions", () => {
  it("lists every collection and key, deleted ones included, without text", async () => {
    const response = await call("/v1/definitions");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      default: "en",
      version: 9,
      collections: {
        body: {
          shape: "named",
          keys: {
            MARS: active,
            MOON: active,
            PLUTO: { placeholders: [], status: "unused" },
            SUN: active,
            VULCAN: { placeholders: [], status: "deleted" },
          },
        },
        house: { shape: "reference", keys: { "1": active, "2": active } },
        ui: {
          shape: "text",
          keys: {
            "app.previous": {
              placeholders: ["date", "place"],
              status: "active",
            },
            "landing.title": active,
          },
        },
      },
    });
  });

  it("is public, cacheable and revalidates by content version", async () => {
    const response = await call("/v1/definitions");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=60, stale-while-revalidate=600",
    );
    expect(response.headers.get("etag")).toBe('"v9"');
    const revalidated = await call("/v1/definitions", {
      headers: { "if-none-match": '"v9"' },
    });
    expect(revalidated.status).toBe(304);
  });

  it("allows the site origins like other public routes", async () => {
    const site = "https://staging.example.test";
    const response = await call(
      "/v1/definitions",
      { headers: { origin: site } },
      { CMS_ALLOWED_ORIGINS: site },
    );
    expect(response.headers.get("access-control-allow-origin")).toBe(site);
  });
});
