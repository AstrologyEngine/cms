import { Hono } from "hono";
import type { AppEnv } from "../app";
import { parse } from "../http";
import { runSync, SYNC_MAX_BYTES, syncRequest, syncState } from "../sync";
import { actorOf, readJson } from "../write";

export const syncRoutes = () => {
  const routes = new Hono<AppEnv>();

  routes.post("/v1/admin/sync", async (c) => {
    // Sync is recorded as 'sync' unless the caller names itself.
    const actor =
      c.req.header("x-cms-actor") === undefined ? "sync" : actorOf(c);
    const request = parse(syncRequest, await readJson(c, SYNC_MAX_BYTES));
    return c.json(await runSync(c.env.DB, request, actor));
  });

  routes.get("/v1/admin/sync", async (c) => c.json(await syncState(c.env.DB)));

  return routes;
};
