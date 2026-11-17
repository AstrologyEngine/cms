/**
 * Key lifecycle (docs/plans/web-owned-catalog.md §4): admins soft-delete
 * unused keys and restore deleted ones. Sync owns active ↔ unused.
 */
import type { KeyStatus } from "@astrologyengine/cms-contract/definitions";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { apiError } from "../http";
import { actorOf, commitWrite, now } from "../write";

type KeyRow = { status: KeyStatus; placeholders: string };

const findKey = async (db: D1Database, collection: string, key: string) => {
  const row = await db
    .prepare(
      "SELECT status, placeholders FROM keys WHERE collection = ? AND key = ?",
    )
    .bind(collection, key)
    .first<KeyRow>();
  if (!row)
    throw apiError(
      404,
      "unknown_entry",
      `'${collection}:${key}' is not registered.`,
    );
  return { status: row.status, placeholders: JSON.parse(row.placeholders) };
};

const changedMeanwhile = (): never => {
  throw apiError(409, "conflict", "The key's status changed; re-read it.");
};

export const keyRoutes = () => {
  const routes = new Hono<AppEnv>();

  routes.delete("/v1/admin/entries/:collection/:key", async (c) => {
    const { collection, key } = c.req.param();
    const actor = actorOf(c);
    const current = await findKey(c.env.DB, collection, key);
    if (current.status !== "unused")
      throw apiError(
        409,
        "conflict",
        current.status === "active"
          ? "Active keys are in use by the website; only unused keys can be deleted."
          : "The key is already deleted.",
      );
    const { version } = await commitWrite(
      c.env.DB,
      [
        c.env.DB.prepare(
          "UPDATE keys SET status = 'deleted', updated_at = ? WHERE collection = ? AND key = ? AND status = 'unused'",
        ).bind(now(), collection, key),
      ],
      {
        subject: "key",
        action: "delete",
        collection,
        key,
        before: current,
        after: { ...current, status: "deleted" },
        actor,
      },
      { guard: true },
    );
    if (version === null) changedMeanwhile();
    return c.body(null, 204);
  });

  routes.post("/v1/admin/entries/:collection/:key/restore", async (c) => {
    const { collection, key } = c.req.param();
    const actor = actorOf(c);
    const current = await findKey(c.env.DB, collection, key);
    if (current.status !== "deleted")
      throw apiError(409, "conflict", "Only deleted keys can be restored.");
    const { version } = await commitWrite(
      c.env.DB,
      [
        c.env.DB.prepare(
          "UPDATE keys SET status = 'unused', updated_at = ? WHERE collection = ? AND key = ? AND status = 'deleted'",
        ).bind(now(), collection, key),
      ],
      {
        subject: "key",
        action: "restore",
        collection,
        key,
        before: current,
        after: { ...current, status: "unused" },
        actor,
      },
      { guard: true },
    );
    if (version === null) changedMeanwhile();
    return c.json({ collection, key, status: "unused" });
  });

  return routes;
};
