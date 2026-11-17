import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  admin,
  call,
  registerKeys,
  resetDbWith,
  revisions,
  sha,
  version,
} from "./helpers";
import { runSync } from "../src/sync";
import { sun } from "./fixtures";

beforeEach(() => resetDbWith({}));

const manifest = {
  locale: "en",
  collections: {
    body: { shape: "named", entries: { SUN: sun } },
    ui: {
      shape: "text",
      entries: {
        "app.title": "Explorer",
        "app.previous": "From {place} on {date}.",
      },
    },
  },
};

const sync = (json: unknown, headers: Record<string, string> = {}) =>
  admin("/v1/admin/sync", { method: "POST", json, headers });

const body = (overrides: Record<string, unknown> = {}) => ({
  commit: sha(1),
  expected: null,
  manifest,
  ...overrides,
});

describe("POST /v1/admin/sync: requests", () => {
  it("requires the admin token", async () => {
    const response = await call("/v1/admin/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body()),
    });
    expect(response.status).toBe(401);
  });

  it("rejects bodies over 1 MB and accepts larger ones than other routes", async () => {
    const huge = JSON.stringify(body({ padding: "x".repeat(1024 * 1024) }));
    const tooLarge = await admin("/v1/admin/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: huge,
    });
    expect(tooLarge.status).toBe(413);
    // 200 KB is over the 64 KB default but within the sync limit: the request
    // is read and then rejected for its content instead.
    const large = await sync(body({ padding: "x".repeat(200 * 1024) }));
    expect(large.status).toBe(422);
  });

  it.each([
    ["a missing commit", { commit: undefined }],
    ["a short commit", { commit: "abc123" }],
    [
      "an uppercase commit",
      { commit: sha(1).toUpperCase().replace(/0/g, "A") },
    ],
    ["a missing expected", { expected: undefined }],
    ["a bad expected", { expected: "HEAD" }],
    ["a missing manifest", { manifest: undefined }],
  ])("rejects %s with 422", async (_label, overrides) => {
    const response = await sync(body(overrides));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "validation_failed", issues: expect.any(Array) },
    });
  });

  it("rejects an invalid manifest with its issues", async () => {
    const response = await sync(
      body({
        manifest: {
          locale: "en",
          collections: { body: { shape: "named", entries: { SUN: {} } } },
        },
      }),
    );
    expect(response.status).toBe(422);
    const { error } = await response.json<{
      error: { code: string; issues: { path: string }[] };
    }>();
    expect(error.code).toBe("validation_failed");
    expect(error.issues.map((issue) => issue.path)).toEqual([
      "manifest.collections.body.entries.SUN.name",
      "manifest.collections.body.entries.SUN.insight",
      "manifest.collections.body.entries.SUN.keywords",
    ]);
  });

  it("requires the manifest to be in the default locale", async () => {
    const response = await sync(
      body({ manifest: { ...manifest, locale: "fr" } }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: {
        code: "validation_failed",
        issues: [{ path: "manifest.locale" }],
      },
    });
  });
});

const rows = async <T>(sql: string) =>
  (await env.DB.prepare(sql).all<T>()).results;

const emptySummary = {
  createdCollections: [],
  created: [],
  reactivated: [],
  unused: [],
  refreshed: [],
  drift: [],
};

describe("POST /v1/admin/sync: first sync", () => {
  it("creates collections, keys and English text and records the sync", async () => {
    const response = await sync(body(), { "x-cms-actor": "web-ci" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...emptySummary,
      commit: sha(1),
      changed: true,
      version: 2,
      createdCollections: ["body", "ui"],
      created: ["body:SUN", "ui:app.previous", "ui:app.title"],
    });

    expect(
      await rows("SELECT name, shape FROM collections ORDER BY name"),
    ).toEqual([
      { name: "body", shape: "named" },
      { name: "ui", shape: "text" },
    ]);
    expect(
      await rows(
        "SELECT collection, key, placeholders, status FROM keys ORDER BY collection, key",
      ),
    ).toEqual([
      { collection: "body", key: "SUN", placeholders: "[]", status: "active" },
      {
        collection: "ui",
        key: "app.previous",
        placeholders: '["place","date"]',
        status: "active",
      },
      {
        collection: "ui",
        key: "app.title",
        placeholders: "[]",
        status: "active",
      },
    ]);
    expect(
      await rows(
        "SELECT collection, key, locale, fields, revision, origin FROM translations ORDER BY collection, key",
      ),
    ).toEqual([
      {
        collection: "body",
        key: "SUN",
        locale: "en",
        fields: JSON.stringify(sun),
        revision: 1,
        origin: "sync",
      },
      {
        collection: "ui",
        key: "app.previous",
        locale: "en",
        fields: JSON.stringify({ text: "From {place} on {date}." }),
        revision: 1,
        origin: "sync",
      },
      {
        collection: "ui",
        key: "app.title",
        locale: "en",
        fields: JSON.stringify({ text: "Explorer" }),
        revision: 1,
        origin: "sync",
      },
    ]);

    const [record] = await rows<{
      id: number;
      commit_sha: string;
      actor: string;
    }>("SELECT id, commit_sha, actor FROM syncs");
    expect(record).toMatchObject({ commit_sha: sha(1), actor: "web-ci" });
    expect(await rows("SELECT commit_sha FROM sync_head")).toEqual([
      { commit_sha: sha(1) },
    ]);

    const history = await revisions();
    expect(
      history.map(({ subject, action, collection, key, locale, after }) => [
        subject,
        action,
        collection,
        key,
        locale,
        JSON.parse(after!),
      ]),
    ).toEqual([
      ["collection", "create", "body", null, null, { shape: "named" }],
      ["collection", "create", "ui", null, null, { shape: "text" }],
      ["key", "create", "body", "SUN", null, { placeholders: [] }],
      [
        "key",
        "create",
        "ui",
        "app.previous",
        null,
        { placeholders: ["place", "date"] },
      ],
      ["key", "create", "ui", "app.title", null, { placeholders: [] }],
      ["translation", "create", "body", "SUN", "en", sun],
      [
        "translation",
        "create",
        "ui",
        "app.previous",
        "en",
        { text: "From {place} on {date}." },
      ],
      ["translation", "create", "ui", "app.title", "en", { text: "Explorer" }],
    ]);
    for (const revision of history) {
      expect(revision.actor).toBe("web-ci");
      expect(revision.before).toBeNull();
      expect((revision as { sync_id?: number }).sync_id).toBe(record!.id);
    }
    expect(await version()).toBe(2);
  });

  it("serves the synced text and defaults the actor to 'sync'", async () => {
    await sync(body());
    const bundle = await (
      await call("/v1/content/en")
    ).json<{
      entries: Record<string, Record<string, unknown>>;
    }>();
    expect(bundle.entries).toEqual({
      body: { SUN: sun },
      ui: {
        "app.previous": { text: "From {place} on {date}." },
        "app.title": { text: "Explorer" },
      },
    });
    expect(await rows("SELECT actor FROM syncs")).toEqual([{ actor: "sync" }]);
  });
});

describe("POST /v1/admin/sync: repeated syncs", () => {
  beforeEach(async () => {
    await sync(body());
  });

  it("is a no-op for the same commit and manifest", async () => {
    const before = await revisions();
    const response = await sync(body({ expected: sha(1) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...emptySummary,
      commit: sha(1),
      changed: false,
      version: 2,
    });
    expect(await rows("SELECT id FROM syncs")).toHaveLength(1);
    expect(await revisions()).toEqual(before);
    expect(await version()).toBe(2);
  });

  it("rejects a stale expected head even for an unchanged commit", async () => {
    const before = await snapshot();
    const response = await sync(body());
    expect(response.status).toBe(412);
    expect(await snapshot()).toEqual(before);
  });

  it("moves the head for a new commit without bumping the version", async () => {
    const response = await sync(body({ commit: sha(2), expected: sha(1) }));
    expect(await response.json()).toMatchObject({
      commit: sha(2),
      changed: false,
      version: 2,
    });
    expect(await rows("SELECT commit_sha FROM sync_head")).toEqual([
      { commit_sha: sha(2) },
    ]);
    expect(await rows("SELECT commit_sha FROM syncs ORDER BY id")).toEqual([
      { commit_sha: sha(1) },
      { commit_sha: sha(2) },
    ]);
    expect(await version()).toBe(2);
  });
});

/** Every table sync may write, for "nothing changed" assertions. */
const snapshot = async () => ({
  collections: await rows("SELECT * FROM collections ORDER BY name"),
  keys: await rows("SELECT * FROM keys ORDER BY collection, key"),
  translations: await rows(
    "SELECT * FROM translations ORDER BY collection, key, locale",
  ),
  revisions: await rows("SELECT * FROM revisions ORDER BY id"),
  syncs: await rows("SELECT * FROM syncs ORDER BY id"),
  head: await rows("SELECT * FROM sync_head"),
  version: await version(),
});

/** `manifest` with some ui entries replaced or added. */
const withUi = (entries: Record<string, string>) => ({
  ...manifest,
  collections: {
    ...manifest.collections,
    ui: {
      shape: "text",
      entries: { ...manifest.collections.ui.entries, ...entries },
    },
  },
});

describe("POST /v1/admin/sync: definition conflicts", () => {
  beforeEach(async () => {
    await sync(body());
    await registerKeys({
      ui: {
        shape: "text",
        keys: { "app.gone": { placeholders: [], status: "deleted" } },
      },
    });
  });

  it.each([
    [
      "a changed shape",
      {
        ...manifest,
        collections: {
          ...manifest.collections,
          body: {
            shape: "reference",
            entries: { SUN: { insight: "x", keywords: ["a"] } },
          },
        },
      },
      {
        code: "shape_changed",
        collection: "body",
        expected: "named",
        actual: "reference",
      },
    ],
    [
      "changed placeholders",
      withUi({ "app.previous": "From {date}." }),
      {
        code: "placeholders_changed",
        collection: "ui",
        key: "app.previous",
        expected: ["place", "date"],
        actual: ["date"],
      },
    ],
    [
      "a retired key",
      withUi({ "app.gone": "Back again." }),
      { code: "key_retired", collection: "ui", key: "app.gone" },
    ],
  ])(
    "rejects %s with 409 and writes nothing",
    async (_label, changed, conflict) => {
      const before = await snapshot();
      const response = await sync(
        body({ commit: sha(2), expected: sha(1), manifest: changed }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "definition_conflict", conflicts: [conflict] },
      });
      expect(await snapshot()).toEqual(before);
    },
  );
});

describe("POST /v1/admin/sync: unused and reactivated keys", () => {
  const status = async (collection: string, key: string) =>
    (
      await env.DB.prepare(
        "SELECT status FROM keys WHERE collection = ? AND key = ?",
      )
        .bind(collection, key)
        .first<{ status: string }>()
    )?.status;

  beforeEach(async () => {
    await sync(body());
  });

  it("marks keys the manifest dropped as unused and keeps their text", async () => {
    const { "app.title": _dropped, ...rest } = manifest.collections.ui.entries;
    const response = await sync(
      body({
        commit: sha(2),
        expected: sha(1),
        manifest: {
          locale: "en",
          // body is dropped entirely; ui loses app.title.
          collections: { ui: { shape: "text", entries: rest } },
        },
      }),
    );
    expect(await response.json()).toMatchObject({
      changed: true,
      version: 3,
      unused: ["body:SUN", "ui:app.title"],
    });
    expect(await status("body", "SUN")).toBe("unused");
    expect(await status("ui", "app.title")).toBe("unused");
    expect(await status("ui", "app.previous")).toBe("active");
    expect(
      await rows("SELECT key FROM translations ORDER BY collection, key"),
    ).toHaveLength(3);
  });

  it("reactivates unused keys the manifest brings back", async () => {
    const { "app.title": _dropped, ...rest } = manifest.collections.ui.entries;
    const withoutTitle = {
      ...manifest,
      collections: {
        ...manifest.collections,
        ui: { shape: "text", entries: rest },
      },
    };
    await sync(
      body({ commit: sha(2), expected: sha(1), manifest: withoutTitle }),
    );
    const response = await sync(body({ commit: sha(3), expected: sha(2) }));
    expect(await response.json()).toMatchObject({
      changed: true,
      version: 4,
      reactivated: ["ui:app.title"],
      unused: [],
    });
    expect(await status("ui", "app.title")).toBe("active");
  });
});

describe("POST /v1/admin/sync: English refresh and drift", () => {
  const english = async (collection: string, key: string) =>
    env.DB.prepare(
      "SELECT fields, revision, origin FROM translations WHERE collection = ? AND key = ? AND locale = 'en'",
    )
      .bind(collection, key)
      .first<{ fields: string; revision: number; origin: string }>();
  const next = (entries: Record<string, string>, extra = {}) =>
    sync(
      body({
        commit: sha(2),
        expected: sha(1),
        manifest: withUi(entries),
        ...extra,
      }),
    );

  beforeEach(async () => {
    await sync(body());
  });

  it("refreshes text no editor has changed, with a revision", async () => {
    const response = await next({ "app.title": "Chart Explorer" });
    expect(await response.json()).toMatchObject({
      changed: true,
      version: 3,
      refreshed: ["ui:app.title"],
      drift: [],
    });
    expect(await english("ui", "app.title")).toEqual({
      fields: JSON.stringify({ text: "Chart Explorer" }),
      revision: 2,
      origin: "sync",
    });
    const [last] = (await revisions()).slice(-1);
    expect(last).toMatchObject({
      subject: "translation",
      action: "update",
      collection: "ui",
      key: "app.title",
      locale: "en",
      actor: "sync",
    });
    expect(JSON.parse(last!.before!)).toEqual({ text: "Explorer" });
    expect(JSON.parse(last!.after!)).toEqual({ text: "Chart Explorer" });
  });

  it("refreshes named entries too", async () => {
    const manifestWithSun = {
      ...manifest,
      collections: {
        ...manifest.collections,
        body: {
          shape: "named",
          entries: { SUN: { ...sun, insight: "Purpose." } },
        },
      },
    };
    const response = await sync(
      body({ commit: sha(2), expected: sha(1), manifest: manifestWithSun }),
    );
    expect(await response.json()).toMatchObject({ refreshed: ["body:SUN"] });
    expect(JSON.parse((await english("body", "SUN"))!.fields)).toEqual({
      ...sun,
      insight: "Purpose.",
    });
  });

  it("reports editor-changed text as drift and leaves it alone", async () => {
    await admin("/v1/admin/entries/ui/app.title/translations/en", {
      method: "PUT",
      json: { text: "Edited Explorer" },
    });
    const versionAfterEdit = await version();
    const response = await next({ "app.title": "Chart Explorer" });
    expect(await response.json()).toMatchObject({
      changed: false,
      version: versionAfterEdit,
      refreshed: [],
      drift: ["ui:app.title"],
    });
    expect(await english("ui", "app.title")).toMatchObject({
      fields: JSON.stringify({ text: "Edited Explorer" }),
      origin: "editor",
    });
  });

  it("ignores field order when comparing text", async () => {
    const { name, insight, keywords } = sun;
    await env.DB.prepare(
      "UPDATE translations SET fields = ? WHERE collection = 'body' AND key = 'SUN'",
    )
      .bind(JSON.stringify({ keywords, insight, name }))
      .run();
    const response = await next({});
    expect(await response.json()).toMatchObject({ refreshed: [], drift: [] });
  });
});

describe("POST /v1/admin/sync: compare-and-swap on the head", () => {
  beforeEach(async () => {
    await sync(body());
  });

  it.each([
    ["a different commit", sha(2)],
    ["no previous sync", null],
  ])(
    "answers 412 for an expected of %s and writes nothing",
    async (_label, expected) => {
      const before = await snapshot();
      const response = await sync(
        body({
          commit: sha(3),
          expected,
          manifest: withUi({ "app.new": "New." }),
        }),
      );
      expect(response.status).toBe(412);
      expect(await response.json()).toMatchObject({
        error: { code: "precondition_failed" },
      });
      expect(await snapshot()).toEqual(before);
    },
  );
});

describe("runSync: writes racing the sync (test seam)", () => {
  beforeEach(async () => {
    await sync(body());
  });

  const edit = () =>
    admin("/v1/admin/entries/ui/app.title/translations/en", {
      method: "PUT",
      json: { text: "Edited during sync" },
      headers: { "x-cms-actor": "amy" },
    });

  it("lets an editor who saves mid-sync win; the key is reported as drift", async () => {
    const result = await runSync(
      env.DB,
      {
        commit: sha(2),
        expected: sha(1),
        manifest: withUi({ "app.title": "Chart Explorer" }),
      },
      "sync",
      { beforeWrite: async () => void (await edit()) },
    );
    expect(result).toMatchObject({ refreshed: [], drift: ["ui:app.title"] });
    const row = await env.DB.prepare(
      "SELECT fields, origin FROM translations WHERE key = 'app.title'",
    ).first<{ fields: string; origin: string }>();
    expect(row).toEqual({
      fields: JSON.stringify({ text: "Edited during sync" }),
      origin: "editor",
    });
    const updates = (await revisions()).filter(
      (revision) => revision.action === "update",
    );
    expect(updates.map((revision) => revision.actor)).toEqual(["amy"]);
    const [record] = await rows<{ summary: string }>(
      "SELECT summary FROM syncs ORDER BY id DESC LIMIT 1",
    );
    expect(JSON.parse(record!.summary)).toMatchObject({
      refreshed: [],
      drift: ["ui:app.title"],
    });
  });

  it("rejects a sync when another sync lands first", async () => {
    const before = await snapshot();
    await expect(
      runSync(
        env.DB,
        {
          commit: sha(3),
          expected: sha(1),
          manifest: withUi({ "app.x": "X." }),
        },
        "sync",
        {
          beforeWrite: async () =>
            void (await sync(body({ commit: sha(2), expected: sha(1) }))),
        },
      ),
    ).rejects.toMatchObject({ status: 412, code: "precondition_failed" });
    const after = await snapshot();
    // Only the competing sync's effects: head moved to sha(2), one more syncs row.
    expect(after.head).toMatchObject([{ commit_sha: sha(2) }]);
    expect(after.syncs).toHaveLength(before.syncs.length + 1);
    expect(after.keys).toEqual(before.keys);
  });
});

describe("runSync at scale", () => {
  /** D1 binding that counts prepared statements and batches. */
  const counting = (db: D1Database) => {
    const stats = { statements: 0, batches: 0 };
    const wrapped = new Proxy(db, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            stats.statements += 1;
            return target.prepare(sql);
          };
        if (property === "batch")
          return (statements: D1PreparedStatement[]) => {
            stats.batches += 1;
            return target.batch(statements);
          };
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { db: wrapped, stats };
  };

  const manifestOf = (count: number, suffix = "") => ({
    locale: "en",
    collections: {
      ui: {
        shape: "text",
        entries: Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            `area${index % 40}.element${index}`,
            `Text number ${index} for {name} and {count}${suffix}.`,
          ]),
        ),
      },
    },
  });

  const run = async (
    count: number,
    commit: string,
    expected: string | null,
    suffix = "",
  ) => {
    const { db, stats } = counting(env.DB);
    const result = await runSync(
      db,
      { commit, expected, manifest: manifestOf(count, suffix) },
      "sync",
    );
    return { result, stats };
  };

  it("uses the same, small number of statements for 3 and 2,000 keys", async () => {
    const small = await run(3, sha(1), null);
    await resetDbWith({});
    const large = await run(2000, sha(1), null);
    expect(large.result.created).toHaveLength(2000);
    expect(large.stats).toEqual(small.stats);
    expect(large.stats.batches).toBe(1);
    expect(large.stats.statements).toBeLessThanOrEqual(20);
    expect(
      await rows("SELECT key FROM translations WHERE origin = 'sync'"),
    ).toHaveLength(2000);

    // Refreshing all 2,000 texts costs the same as creating them.
    const refresh = await run(2000, sha(2), sha(1), " again");
    expect(refresh.result.refreshed).toHaveLength(2000);
    expect(refresh.stats).toEqual(large.stats);
    expect(
      (await revisions()).filter((revision) => revision.action === "update"),
    ).toHaveLength(2000);

    // Dropping almost all of them: 1,997 keys become unused.
    const shrink = await run(3, sha(3), sha(2), " again");
    expect(shrink.result.unused).toHaveLength(1997);
    expect(shrink.stats).toEqual(large.stats);
  });
});

describe("GET /v1/admin/sync", () => {
  type SyncState = {
    head: { commit: string; syncedAt: string; actor: string } | null;
    recent: {
      id: number;
      commit: string;
      actor: string;
      createdAt: string;
      summary: Record<string, unknown>;
    }[];
  };
  const state = async () => (await admin("/v1/admin/sync")).json<SyncState>();

  it("has no head before the first sync", async () => {
    expect(await state()).toEqual({ head: null, recent: [] });
  });

  it("returns the head and the 20 most recent syncs, newest first", async () => {
    await sync(body(), { "x-cms-actor": "web-ci" });
    for (let n = 2; n <= 22; n += 1)
      await sync(body({ commit: sha(n), expected: sha(n - 1) }));
    const { head, recent } = await state();
    expect(head).toEqual({
      commit: sha(22),
      syncedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      actor: "sync",
    });
    expect(recent).toHaveLength(20);
    expect(recent.map((entry) => entry.commit)).toEqual(
      Array.from({ length: 20 }, (_, index) => sha(22 - index)),
    );
    expect(recent[0]).toMatchObject({
      actor: "sync",
      summary: { ...emptySummary },
    });
  });

  it("requires the admin token", async () => {
    expect((await call("/v1/admin/sync")).status).toBe(401);
  });
});

describe("registry names", () => {
  it("syncs and serves collections and keys named like object properties", async () => {
    const manifest = {
      locale: "en",
      collections: {
        constructor: { shape: "text", entries: { toString: "Works" } },
      },
    };
    expect((await sync(body({ manifest }))).status).toBe(200);
    expect(await (await call("/v1/definitions")).json()).toMatchObject({
      collections: {
        constructor: { keys: { toString: { status: "active" } } },
      },
    });
    expect(
      await (await call("/v1/content/en/constructor/toString")).json(),
    ).toMatchObject({ fields: { text: "Works" } });
  });
});
