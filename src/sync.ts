/**
 * Manifest sync (docs/plans/web-owned-catalog.md §8): web's deploys register
 * collections and keys and fill in default-locale text. Never overwrites text
 * an editor changed.
 */
import {
  checkManifest,
  type Manifest,
} from "@astrologyengine/cms-contract/manifest";
import type {
  SyncResult,
  SyncState,
  SyncSummary,
} from "@astrologyengine/cms-contract/sync";
import { z } from "zod";
import { listLocales } from "./db";
import { apiError } from "./http";
import { placeholdersIn } from "./placeholders";
import { loadRegistry } from "./registry";
import { now } from "./write";

export const SYNC_MAX_BYTES = 1024 * 1024;

const commitSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "Must be a full, lowercase commit SHA.");

export const syncRequest = z.strictObject({
  commit: commitSha,
  /** The commit of the last sync the client checked ancestry against. */
  expected: commitSha.nullable(),
  manifest: z.unknown().refine((value) => value !== undefined, "Required."),
});
export type SyncRequest = z.infer<typeof syncRequest>;

export type SyncHooks = {
  /** Test seam: runs after reading state and before the write batch. */
  beforeWrite?: () => Promise<void>;
};

const invalid = (issues: { path: string; message: string }[]): never => {
  throw apiError(422, "validation_failed", "Manifest is invalid.", { issues });
};

type Entry = {
  collection: string;
  key: string;
  fields: Record<string, unknown>;
  placeholders: string[];
};

/** Wire entries of a validated manifest, sorted by collection, then key. */
const entriesOf = (manifest: Manifest): Entry[] =>
  Object.keys(manifest.collections)
    .sort()
    .flatMap((collection) => {
      const { shape, entries } = manifest.collections[collection]!;
      return Object.keys(entries)
        .sort()
        .map((key) => {
          const value = (entries as Record<string, unknown>)[key];
          return shape === "text"
            ? {
                collection,
                key,
                fields: { text: value as string },
                placeholders: placeholdersIn(value as string),
              }
            : {
                collection,
                key,
                fields: value as Record<string, unknown>,
                placeholders: [],
              };
        });
    });

/** JSON with object keys sorted, so field order doesn't count as a change. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : inner,
  );

type StoredText = {
  collection: string;
  key: string;
  fields: string;
  origin: "sync" | "editor";
  revision: number;
};

/** A property of the current `json_each(?) j` element. */
const field = (name: string) => `json_extract(j.value, '$.${name}')`;

/** `collection:key` → parts; collection names never contain ':'. */
const splitId = (id: string) => {
  const at = id.indexOf(":");
  return { collection: id.slice(0, at), key: id.slice(at + 1) };
};

/**
 * Run the sync batch. The first statement updates sync_head; its trigger
 * aborts the whole (atomic) batch when `expected` isn't the current head.
 */
const writeBatch = async (
  db: D1Database,
  statements: D1PreparedStatement[],
) => {
  try {
    return await db.batch(statements);
  } catch (error) {
    if (String(error).includes("sync_conflict"))
      throw apiError(
        412,
        "precondition_failed",
        "Another sync happened first; re-check ancestry against the new head and retry.",
      );
    throw error;
  }
};

/** Move the listed keys from one status to another, in one statement. */
const setStatus = (
  db: D1Database,
  ids: string[],
  from: "active" | "unused",
  to: "active" | "unused",
  timestamp: string,
) =>
  db
    .prepare(
      `UPDATE keys SET status = ?2, updated_at = ?3
       WHERE status = ?4 AND (collection, key) IN (
         SELECT ${field("collection")}, ${field("key")} FROM json_each(?1) j)`,
    )
    .bind(JSON.stringify(ids.map(splitId)), to, timestamp, from);

/** Columns of a revision row written by sync; the sync row is the newest one. */
const REVISION = `INSERT INTO revisions (subject, action, collection, key, locale, before, after, actor, sync_id, created_at)`;
const SYNC_ID = "(SELECT max(id) FROM syncs)";

export const runSync = async (
  db: D1Database,
  request: SyncRequest,
  actor: string,
  hooks: SyncHooks = {},
): Promise<SyncResult> => {
  const [locales, registry, state] = await Promise.all([
    listLocales(db),
    loadRegistry(db),
    db
      .prepare(
        `SELECT (SELECT commit_sha FROM sync_head WHERE id = 1) AS head,
                (SELECT value FROM meta WHERE key = 'content_version') AS version`,
      )
      .first<{ head: string | null; version: number }>(),
  ]);
  if (request.expected !== state!.head)
    throw apiError(
      412,
      "precondition_failed",
      "Another sync happened first; re-check ancestry against the new head and retry.",
    );
  const defaultLocale = locales.find((locale) => locale.isDefault)!.code;
  const check = checkManifest(request.manifest, {
    default: defaultLocale,
    version: 0,
    collections: registry,
  });
  const issues = check.issues.map(({ path, message }) => ({
    path: path ? `manifest.${path}` : "manifest",
    message,
  }));
  for (const conflict of check.conflicts)
    if (conflict.code === "locale_mismatch")
      issues.push({
        path: "manifest.locale",
        message: `Must be the default locale '${conflict.expected}'.`,
      });
  if (issues.length) invalid(issues);
  if (check.conflicts.length)
    throw apiError(
      409,
      "definition_conflict",
      "The manifest changes existing definitions; use new key names instead.",
      { conflicts: check.conflicts },
    );

  const manifest = request.manifest as Manifest;
  const entries = entriesOf(manifest);
  const { results: stored } = await db
    .prepare(
      "SELECT collection, key, fields, origin, revision FROM translations WHERE locale = ?",
    )
    .bind(defaultLocale)
    .all<StoredText>();
  const storedById = new Map(
    stored.map((row) => [`${row.collection}:${row.key}`, row]),
  );
  const refresh: (Entry & { revision: number; before: unknown })[] = [];
  const drift: string[] = [];
  for (const entry of entries) {
    const id = `${entry.collection}:${entry.key}`;
    const row = storedById.get(id);
    if (!row || canonical(JSON.parse(row.fields)) === canonical(entry.fields))
      continue;
    if (row.origin === "sync")
      refresh.push({
        ...entry,
        revision: row.revision,
        before: JSON.parse(row.fields),
      });
    else drift.push(id);
  }
  const created = new Set(check.created);
  const newCollections = check.createdCollections.map((name) => ({
    name,
    shape: manifest.collections[name]!.shape,
  }));
  const newKeys = entries.filter((entry) =>
    created.has(`${entry.collection}:${entry.key}`),
  );
  const summary = {
    createdCollections: check.createdCollections,
    created: check.created,
    reactivated: check.reactivated,
    unused: check.unused,
    refreshed: refresh.map(({ collection, key }) => `${collection}:${key}`),
    drift,
  };
  const changed = Object.entries(summary).some(
    ([name, list]) => name !== "drift" && list.length > 0,
  );
  if (!changed && request.commit === state!.head)
    return {
      commit: request.commit,
      changed,
      version: state!.version,
      ...summary,
    };

  await hooks.beforeWrite?.();
  const timestamp = now();
  const json = (value: unknown) => JSON.stringify(value);
  // Order matters: the head update must come first (its trigger guards the
  // batch), the sync row before revisions (they reference it), and writes
  // before the revisions that select the rows they changed.
  const statements = {
    head: db
      .prepare(
        "UPDATE sync_head SET commit_sha = ?, expected = ?, updated_at = ? WHERE id = 1",
      )
      .bind(request.commit, request.expected, timestamp),
    sync: db
      .prepare(
        "INSERT INTO syncs (commit_sha, actor, summary, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(request.commit, actor, json(summary), timestamp),
    collections: db
      .prepare(
        `INSERT INTO collections (name, shape, created_at)
         SELECT ${field("name")}, ${field("shape")}, ?2 FROM json_each(?1) j`,
      )
      .bind(json(newCollections), timestamp),
    keys: db
      .prepare(
        `INSERT INTO keys (collection, key, placeholders, status, created_at, updated_at)
         SELECT ${field("collection")}, ${field("key")}, ${field("placeholders")}, 'active', ?2, ?2
         FROM json_each(?1) j`,
      )
      .bind(json(newKeys), timestamp),
    reactivate: setStatus(db, check.reactivated, "unused", "active", timestamp),
    unuse: setStatus(db, check.unused, "active", "unused", timestamp),
    insertText: db
      .prepare(
        `INSERT INTO translations (collection, key, locale, fields, revision, origin, updated_at)
         SELECT ${field("collection")}, ${field("key")}, ?2, ${field("fields")}, 1, 'sync', ?3
         FROM json_each(?1) j WHERE true
         ON CONFLICT (collection, key, locale) DO NOTHING`,
      )
      .bind(json(entries), defaultLocale, timestamp),
    refreshText: db
      .prepare(
        // MATERIALIZED keeps the JSON as the outer loop: each element then
        // finds its row by primary key instead of scanning the array per row.
        `WITH j AS MATERIALIZED (
           SELECT ${field("collection")} AS collection, ${field("key")} AS key,
                  ${field("fields")} AS fields, ${field("revision")} AS revision
           FROM json_each(?1) j
         )
         UPDATE translations
         SET fields = j.fields, revision = translations.revision + 1, updated_at = ?3
         FROM j
         WHERE translations.collection = j.collection AND translations.key = j.key
           AND translations.locale = ?2 AND translations.origin = 'sync'
           AND translations.revision = j.revision
         RETURNING translations.collection AS collection, translations.key AS key`,
      )
      .bind(json(refresh), defaultLocale, timestamp),
    collectionRevisions: db
      .prepare(
        `${REVISION}
         SELECT 'collection', 'create', ${field("name")}, NULL, NULL, NULL,
                json_object('shape', ${field("shape")}), ?2, ${SYNC_ID}, ?3
         FROM json_each(?1) j`,
      )
      .bind(json(newCollections), actor, timestamp),
    keyRevisions: db
      .prepare(
        `${REVISION}
         SELECT 'key', 'create', ${field("collection")}, ${field("key")}, NULL, NULL,
                json_object('placeholders', json(${field("placeholders")})), ?2, ${SYNC_ID}, ?3
         FROM json_each(?1) j`,
      )
      .bind(json(newKeys), actor, timestamp),
    createRevisions: db
      .prepare(
        `${REVISION}
         SELECT 'translation', 'create', t.collection, t.key, t.locale, NULL, t.fields, ?3, ${SYNC_ID}, ?4
         FROM json_each(?1) j CROSS JOIN translations t
           ON t.collection = ${field("collection")} AND t.key = ${field("key")}
         WHERE t.locale = ?2 AND t.origin = 'sync' AND t.revision = 1 AND t.updated_at = ?4
         ORDER BY t.collection, t.key`,
      )
      .bind(json(entries), defaultLocale, actor, timestamp),
    refreshRevisions: db
      .prepare(
        `${REVISION}
         SELECT 'translation', 'update', t.collection, t.key, t.locale, json(${field("before")}), t.fields, ?3, ${SYNC_ID}, ?4
         FROM json_each(?1) j CROSS JOIN translations t
           ON t.collection = ${field("collection")} AND t.key = ${field("key")}
         WHERE t.locale = ?2 AND t.origin = 'sync' AND t.updated_at = ?4
           AND t.revision = ${field("revision")} + 1
         ORDER BY t.collection, t.key`,
      )
      .bind(json(refresh), defaultLocale, actor, timestamp),
    version: db
      .prepare(
        "UPDATE meta SET value = value + ? WHERE key = 'content_version' RETURNING value",
      )
      .bind(changed ? 1 : 0),
  };
  const names = Object.keys(statements) as (keyof typeof statements)[];
  const batch = await writeBatch(db, Object.values(statements));
  const result = <T>(name: keyof typeof statements) =>
    batch[names.indexOf(name)]!.results as T[];

  // An editor who saved between our read and the batch wins: the guarded
  // update skipped their row, so report it as drift instead.
  const refreshed = new Set(
    result<{ collection: string; key: string }>("refreshText").map(
      ({ collection, key }) => `${collection}:${key}`,
    ),
  );
  const lost = summary.refreshed.filter((id) => !refreshed.has(id));
  if (lost.length) {
    summary.refreshed = summary.refreshed.filter((id) => refreshed.has(id));
    summary.drift = [...summary.drift, ...lost].sort();
    await db
      .prepare(
        "UPDATE syncs SET summary = ? WHERE id = (SELECT max(id) FROM syncs WHERE commit_sha = ?)",
      )
      .bind(json(summary), request.commit)
      .run();
  }
  const version = result<{ value: number }>("version")[0]!.value;
  return { commit: request.commit, changed, version, ...summary };
};

type SyncRecord = {
  id: number;
  commit_sha: string;
  actor: string;
  summary: string;
  created_at: string;
};

/** The last synced commit and the 20 most recent syncs, newest first. */
export const syncState = async (db: D1Database): Promise<SyncState> => {
  const [head, { results }] = await Promise.all([
    db
      .prepare("SELECT commit_sha FROM sync_head WHERE id = 1")
      .first<{ commit_sha: string | null }>(),
    db
      .prepare(
        "SELECT id, commit_sha, actor, summary, created_at FROM syncs ORDER BY id DESC LIMIT 20",
      )
      .all<SyncRecord>(),
  ]);
  // Every head change writes its syncs row in the same batch.
  const current = results.find((row) => row.commit_sha === head?.commit_sha);
  return {
    head:
      head?.commit_sha && current
        ? {
            commit: current.commit_sha,
            syncedAt: current.created_at,
            actor: current.actor,
          }
        : null,
    recent: results.map((row) => ({
      id: row.id,
      commit: row.commit_sha,
      actor: row.actor,
      createdAt: row.created_at,
      summary: JSON.parse(row.summary) as SyncSummary,
    })),
  };
};
