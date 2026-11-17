import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addTranslation,
  admin,
  registerKeys,
  resetDb,
  revisions,
  version,
} from "./helpers";
import { sun } from "./fixtures";

beforeEach(async () => {
  await resetDb();
  // PLUTO: unused with English text; VULCAN: already deleted.
  await addTranslation("body", "PLUTO", "en", { ...sun, name: "Pluto" });
  await registerKeys({
    body: {
      shape: "named",
      keys: { VULCAN: { placeholders: [], status: "deleted" } },
    },
  });
});

const entry = (collection: string, key: string) =>
  `/v1/admin/entries/${collection}/${key}`;
const status = async (collection: string, key: string) =>
  (
    await env.DB.prepare(
      "SELECT status FROM keys WHERE collection = ? AND key = ?",
    )
      .bind(collection, key)
      .first<{ status: string }>()
  )?.status;

describe("DELETE /v1/admin/entries/:collection/:key", () => {
  const remove = (collection: string, key: string) =>
    admin(entry(collection, key), {
      method: "DELETE",
      headers: { "x-cms-actor": "amy" },
    });

  it("soft-deletes an unused key, keeping its text for restore", async () => {
    const before = await version();
    const response = await remove("body", "PLUTO");
    expect(response.status).toBe(204);
    expect(await status("body", "PLUTO")).toBe("deleted");
    expect(
      await env.DB.prepare(
        "SELECT locale FROM translations WHERE key = 'PLUTO'",
      ).all(),
    ).toMatchObject({ results: [{ locale: "en" }] });
    expect(await version()).toBe(before + 1);
    const [last] = (await revisions()).slice(-1);
    expect(last).toMatchObject({
      subject: "key",
      action: "delete",
      collection: "body",
      key: "PLUTO",
      locale: null,
      actor: "amy",
    });
    expect(JSON.parse(last!.before!)).toEqual({
      status: "unused",
      placeholders: [],
    });
    expect(JSON.parse(last!.after!)).toEqual({
      status: "deleted",
      placeholders: [],
    });
  });

  it.each([
    ["an active key", "SUN"],
    ["an already deleted key", "VULCAN"],
  ])("refuses %s with 409", async (_label, key) => {
    const before = await status("body", key);
    const response = await remove("body", key);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "conflict" },
    });
    expect(await status("body", key)).toBe(before);
  });

  it("answers 404 unknown_entry for unregistered keys", async () => {
    const response = await remove("body", "NIBIRU");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "unknown_entry" },
    });
  });
});

describe("POST /v1/admin/entries/:collection/:key/restore", () => {
  const restore = (collection: string, key: string) =>
    admin(`${entry(collection, key)}/restore`, {
      method: "POST",
      headers: { "x-cms-actor": "amy" },
    });

  it("restores a deleted key as unused, with its text intact", async () => {
    await admin(entry("body", "PLUTO"), { method: "DELETE" });
    const before = await version();
    const response = await restore("body", "PLUTO");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      collection: "body",
      key: "PLUTO",
      status: "unused",
    });
    expect(await status("body", "PLUTO")).toBe("unused");
    expect(
      await env.DB.prepare(
        "SELECT fields FROM translations WHERE key = 'PLUTO' AND locale = 'en'",
      ).first<{ fields: string }>(),
    ).toEqual({ fields: JSON.stringify({ ...sun, name: "Pluto" }) });
    expect(await version()).toBe(before + 1);
    const [last] = (await revisions()).slice(-1);
    expect(last).toMatchObject({
      subject: "key",
      action: "restore",
      collection: "body",
      key: "PLUTO",
      actor: "amy",
    });
    expect(JSON.parse(last!.after!)).toEqual({
      status: "unused",
      placeholders: [],
    });
  });

  it.each([
    ["an active key", "SUN"],
    ["an unused key", "PLUTO"],
  ])("refuses %s with 409", async (_label, key) => {
    const response = await restore("body", key);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "conflict" },
    });
  });

  it("answers 404 unknown_entry for unregistered keys", async () => {
    expect((await restore("body", "NIBIRU")).status).toBe(404);
  });
});
