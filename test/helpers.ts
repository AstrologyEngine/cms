import { env } from "cloudflare:workers";
import { createApp } from "../src/app";
import type { Registry } from "../src/registry";
import { testRegistry } from "./fixtures";

export const ADMIN_TOKEN = "test-admin-token-0123456789abcdefghijklmnop";

const app = createApp();

/** Requests against the app; `resetDb` registers the small test catalog. */
export const call = async (
  path: string,
  init?: RequestInit,
  overrides: Partial<Cloudflare.Env> = {},
) =>
  app.fetch(new Request(`https://cms.test${path}`, init), {
    ...env,
    ...overrides,
  });

export const admin = (
  path: string,
  init: RequestInit & { json?: unknown } = {},
) => {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("authorization", `Bearer ${ADMIN_TOKEN}`);
  if (json !== undefined) headers.set("content-type", "application/json");
  return call(path, {
    ...rest,
    headers,
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
};

const STAMP = "2026-01-01T00:00:00.000Z";

/** Insert collections and keys (existing rows are left alone). */
export const registerKeys = async (registry: Registry) => {
  const statements: D1PreparedStatement[] = [];
  for (const [name, { shape, keys }] of Object.entries(registry)) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO collections (name, shape, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      ).bind(name, shape, STAMP),
    );
    for (const [key, { placeholders, status }] of Object.entries(keys))
      statements.push(
        env.DB.prepare(
          `INSERT INTO keys (collection, key, placeholders, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        ).bind(name, key, JSON.stringify(placeholders), status, STAMP, STAMP),
      );
  }
  if (statements.length) await env.DB.batch(statements);
};

/**
 * Empty content and registry, then register `registry`. Tests in one file
 * share D1 state; files are isolated.
 */
export const resetDbWith = async (registry: Registry) => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM translations"),
    env.DB.prepare("DELETE FROM revisions"),
    env.DB.prepare("DELETE FROM syncs"),
    env.DB.prepare("DELETE FROM keys"),
    env.DB.prepare("DELETE FROM collections"),
    // `expected` must name the current commit to pass the sync_head trigger.
    env.DB.prepare(
      "UPDATE sync_head SET expected = commit_sha, commit_sha = NULL, updated_at = NULL",
    ),
    env.DB.prepare("DELETE FROM locales WHERE is_default = 0"),
    env.DB.prepare("UPDATE meta SET value = 1 WHERE key = 'content_version'"),
  ]);
  await registerKeys(registry);
};

/** `resetDbWith` the test catalog; safe as `beforeEach(resetDb)`. */
export const resetDb = () => resetDbWith(testRegistry);

/** A full 40-character commit SHA for tests: `sha(1)` is `000…001`. */
export const sha = (n: number) => n.toString(16).padStart(40, "0");

export const addLocale = async (
  code: string,
  {
    enabled = true,
    fallback = null,
    name = code,
  }: { enabled?: boolean; fallback?: string | null; name?: string } = {},
) => {
  await env.DB.prepare(
    `INSERT INTO locales (code, name, enabled, is_default, fallback, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  )
    .bind(code, name, enabled ? 1 : 0, fallback)
    .run();
};

const shapeOf = (fields: unknown) =>
  typeof fields === "object" && fields !== null && "text" in fields
    ? "text"
    : typeof fields === "object" && fields !== null && "name" in fields
      ? "named"
      : "reference";

/**
 * Store a translation directly. A key that isn't registered yet is registered
 * as `unused` (its collection's shape guessed from the fields): served and
 * editable, but not in the website's current manifest.
 */
export const addTranslation = async (
  collection: string,
  key: string,
  locale: string,
  fields: unknown,
  origin: "sync" | "editor" = "editor",
) => {
  await registerKeys({
    [collection]: {
      shape: shapeOf(fields),
      keys: { [key]: { placeholders: [], status: "unused" } },
    },
  });
  await env.DB.prepare(
    `INSERT INTO translations (collection, key, locale, fields, revision, origin, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(collection, key, locale, JSON.stringify(fields), origin, STAMP)
    .run();
};

export const setVersion = async (value: number) => {
  await env.DB.prepare(
    "UPDATE meta SET value = ? WHERE key = 'content_version'",
  )
    .bind(value)
    .run();
};

export const version = async () =>
  (await env.DB.prepare(
    "SELECT value FROM meta WHERE key = 'content_version'",
  ).first<{ value: number }>())!.value;

export type RevisionRow = {
  id: number;
  subject: string;
  action: string;
  collection: string | null;
  key: string | null;
  locale: string | null;
  before: string | null;
  after: string | null;
  actor: string;
  created_at: string;
};

export const revisions = async () =>
  (
    await env.DB.prepare(
      "SELECT * FROM revisions ORDER BY id",
    ).all<RevisionRow>()
  ).results;

export const localeRow = (code: string) =>
  env.DB.prepare("SELECT * FROM locales WHERE code = ?").bind(code).first<{
    code: string;
    enabled: number;
    fallback: string | null;
    name: string;
  }>();
