# Plan: web-owned catalog (manifest sync)

|                |                                                                          |
| -------------- | ------------------------------------------------------------------------ |
| **Status**     | Draft, for review                                                        |
| **Date**       | 2026-11-13                                                               |
| **Design**     | `docs/designs/cms.md` (rev. 2); this plan adds rev. 3 in its final phase |
| **Runbook**    | `docs/runbooks/cms.md`                                                   |
| **Supersedes** | Design decision #9 ("code-defined keys"), §5.1 catalog, §8 seeding       |

## 1. Goal

Adding a key to the website must not require a CMS change or release. Today
every collection and key is hardcoded in `packages/contract/src/catalog.ts`,
with English text in `packages/contract/seed/en.json`, so each new `t("…")`
in web needs a CMS PR, a contract release and a CMS deploy first.

After this plan:

- **Web owns collections, keys and their approved English text** in a typed
  manifest in the web repo.
- **Web's main and release deploys sync the manifest to the CMS.** Sync only
  creates collections and keys, fills in missing English, and refreshes English
  that no editor has touched. It never overwrites an editor's work.
- **The CMS owns shapes, validation, storage, editing, history and serving.**
  It contains no astrology-specific code.
- **Type safety is kept.** Web derives `t()` keys and parameter types from its
  manifest, and the placeholders come from the English text itself.
- **Editors keep every copy-editing ability** they have today. Only creating
  keys moves from CMS code to web code.

## 2. Decisions

Agreed in review, 2026-11-13.

| #   | Question                            | Decision                                                                                                                                                                                 |
| --- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | How does web use dynamic keys?      | By code reference, typed. The point is to stop needing CMS changes for new keys. Prefix listing is not needed.                                                                           |
| 2   | Who defines keys?                   | Web, in a manifest with the approved English text. Deploy registers keys and never overwrites edits.                                                                                     |
| 3   | How far does decoupling go?         | Web owns **all** collections and keys, astrology collections included. The CMS owns the field shapes.                                                                                    |
| 4   | Changing a key's definition         | Not allowed. Placeholders and collection shapes can't change; a different definition needs a new key name (e.g. `…V2`).                                                                  |
| 5   | Keep shapes?                        | Yes: `named`, `reference`, `text`, fixed in the CMS. The upcoming admin UI picks its editing component by shape.                                                                         |
| 6   | Do PR previews sync?                | No. Only main (staging) and releases (alpha) sync. Web falls back to its manifest English for keys the CMS doesn't have yet.                                                             |
| 7   | How does CI authenticate?           | `CMS_ADMIN_TOKEN` for now, and only in web's main and release deploy jobs. Revisit (e.g. GitHub OIDC) during admin UI planning.                                                          |
| 8   | Switching over                      | Start fresh: nothing has been deployed (D1 IDs are still `REPLACE_WITH_…`, deploys are gated). `0001_init.sql` is rewritten; no backfill and no seed.                                    |
| 9   | Placeholders                        | Derived from the English text (`"Showing {shown}"` gives `{shown}`). Fixed at first sync.                                                                                                |
| 10  | Contract package                    | Kept, made generic: shapes, placeholder and manifest types, `checkManifest`, sync client, locale helpers, wire types. No catalog and no seed.                                            |
| 11  | Pre-merge conflict detection        | A public, read-only `GET /v1/definitions` endpoint, plus `checkManifest()` from the contract (the same function the sync endpoint uses). No secret needed in PR CI.                      |
| 12  | Which environment each check uses   | Feature PRs check against **staging**; release PRs check against **alpha**.                                                                                                              |
| —   | Deleting keys                       | **Soft delete.** Only unused keys can be deleted. Admins can restore them. Key names are **never reused**.                                                                               |
| 13  | A manifest contains a deleted key   | Rejected (`key_retired`). To bring it back, an admin restores it first. The friction is intentional: it forces admins and developers to coordinate.                                      |
| 14  | Plan scope                          | CMS only, plus a web handoff (§11). The web repo isn't available here.                                                                                                                   |
| 15  | Method                              | Red/green TDD with `[red]` commit pairs (org convention).                                                                                                                                |
| 16  | Where does the contract live?       | Here, in `packages/contract`.                                                                                                                                                            |
| 17  | Manifest English changes after sync | Sync replaces English **only if no editor has changed it** since the last sync. This is tracked by a server-set `origin` on each translation, not by the spoofable `X-CMS-Actor` header. |
| 18  | Stale or out-of-order syncs         | The client checks git ancestry (`merge-base --is-ancestor <last synced> HEAD`), and the server does a compare-and-swap on the last synced commit. Coverage counts only **active** keys.  |

## 3. Findings that shape this plan

Checked in this checkout before planning:

1. **"The catalog" is the in-code object everywhere.** `isCatalogEntry`,
   `validateFields`, `buildEntries`, `coverageReport`, orphan detection and the
   "default text can't be deleted" rule all read it, and `createApp(catalog)`
   passes it in. Tests pass a small `testCatalog`. All of these move to a
   registry stored in D1.
2. **Shapes do one job:** per-collection field validation in
   `src/fields.ts`, plus placeholder checks for `text`. Nothing public uses
   them. The contract bundle type is `Record<string, unknown>`.
3. **Nothing is deployed.** `wrangler.jsonc` still has
   `REPLACE_WITH_STAGING_DATABASE_ID` / `REPLACE_WITH_ALPHA_DATABASE_ID`, and
   `deploy.yml` is gated by `CMS_DEPLOY_ENABLED`. Rewriting `0001_init.sql` is
   therefore safe. The additive-only rule applies again from the first remote
   deploy.
4. **`revisions.subject` has a CHECK constraint** (`'translation','locale'`).
   It can't be altered in place; the rewrite of `0001` fixes it.
5. **D1 limits the number of queries per Worker invocation** (50 on Free, 1,000
   on Paid; confirm against current Cloudflare docs during Phase 3). Today's
   content is 6 collections, 204 keys and a 25 KB seed. A sync that uses one
   statement per key, plus a revision row each, would exceed the limit. **Sync
   must use set-based statements** over a JSON parameter (`INSERT … SELECT …
   FROM json_each(?)`), so the statement count is fixed: about **18 per sync**
   (5 reads + 13 writes, §8), whether the manifest has 3 keys or 20,000. That
   is under the Free limit of 50 even if every statement in a batch counts
   separately. At that point the practical limits are request CPU time (10 ms
   on Workers Free) and D1 statement duration, not query count (see Risks).
   _Verified in local D1:_ a single `json_each` statement inserts any number of
   rows.
6. **A compare-and-swap that aborts the whole batch is possible in D1** with a
   single-row table and a `BEFORE UPDATE` trigger that calls
   `RAISE(ABORT, 'sync_conflict')`.
   _Verified in local D1:_ the stale update fails with
   `SQLITE_CONSTRAINT_TRIGGER`, and the row is unchanged.
7. **Request bodies are capped at 64 KB** (`src/write.ts`). A manifest will
   outgrow that, so the sync route gets its own 1 MB cap.
8. **GitHub's default checkout is shallow** (`fetch-depth: 1`), so the
   ancestry check needs full history in web's deploy jobs (§11).

## 4. Target model

**Shape** (CMS-owned, fixed): `named` `{name, insight, keywords}`,
`reference` `{insight, keywords}`, `text` `{text}`. Validation rules are
unchanged from design §5.2.

**Collection:** a name plus a shape. It is created by sync, and its shape can
never change.

**Key:** `(collection, key)`. A `text` key also has its placeholder set,
derived from the English text at creation and never changed afterwards. Each
key has a status:

| Status    | Meaning                                  | Served publicly | Counted in coverage | Set by                            |
| --------- | ---------------------------------------- | --------------- | ------------------- | --------------------------------- |
| `active`  | In the last synced manifest              | yes             | yes                 | sync (create, or reappears)       |
| `unused`  | No longer in the last synced manifest    | yes (rollbacks) | listed separately   | sync (absent); admin restore      |
| `deleted` | Retired by an admin; name never reusable | no              | no                  | admin delete (only from `unused`) |

```
          sync: absent              admin: delete
 active ─────────────────► unused ─────────────────► deleted
        ◄─────────────────        ◄─────────────────
          sync: present               admin: restore
          (same definition)
```

**Translation:** unchanged, apart from a new server-set
`origin ∈ {sync, editor}`. Sync may replace default-locale text only while its
`origin` is `sync`. Any admin `PUT` sets `editor`.

**Sync head (per environment):** the web commit of the last successful sync.
It is used for ordering (the client's ancestry check) and for concurrency (the
server's compare-and-swap).

## 5. Schema (`migrations/0001_init.sql`, rewritten)

`locales` and `meta` are unchanged. The new or changed parts:

```sql
CREATE TABLE collections (
  name        TEXT PRIMARY KEY,
  shape       TEXT NOT NULL CHECK (shape IN ('named', 'reference', 'text')),
  created_at  TEXT NOT NULL
);

CREATE TABLE keys (
  collection    TEXT NOT NULL REFERENCES collections (name),
  key           TEXT NOT NULL,
  placeholders  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(placeholders)),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'unused', 'deleted')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (collection, key)
);

CREATE TABLE translations (
  collection  TEXT NOT NULL,
  key         TEXT NOT NULL,
  locale      TEXT NOT NULL REFERENCES locales (code) ON DELETE CASCADE,
  fields      TEXT NOT NULL CHECK (json_valid(fields)),
  revision    INTEGER NOT NULL DEFAULT 1,
  origin      TEXT NOT NULL CHECK (origin IN ('sync', 'editor')),
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (collection, key, locale),
  FOREIGN KEY (collection, key) REFERENCES keys (collection, key)
);

CREATE TABLE syncs (
  id          INTEGER PRIMARY KEY,
  commit_sha  TEXT NOT NULL,
  actor       TEXT NOT NULL,
  summary     TEXT NOT NULL CHECK (json_valid(summary)),
  created_at  TEXT NOT NULL
);

-- Single row; the trigger turns a stale `expected` into a batch abort.
CREATE TABLE sync_head (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  commit_sha  TEXT,
  expected    TEXT,
  updated_at  TEXT
);
CREATE TRIGGER sync_head_cas BEFORE UPDATE ON sync_head
WHEN NEW.expected IS NOT OLD.commit_sha
BEGIN SELECT RAISE(ABORT, 'sync_conflict'); END;

-- revisions: subject adds 'collection' and 'key'; action adds 'restore';
-- new nullable sync_id REFERENCES syncs (id).
```

Seed rows: `meta.content_version = 1`, locale `en` (as today) and
`sync_head (1, NULL, NULL, NULL)`.

## 6. Contract `@astrologyengine/cms-contract` 0.2.0

This is a breaking change; the version stays below 1.0, so it's a minor bump.
The package stays dependency-free.

| Export                 | Contents                                                                                                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./shapes`             | `Shape`, field types per shape, `validateFields(shape, fields)` → `{ ok } \| { ok: false, issues }`. This replaces the zod schemas in `src/fields.ts`, so CMS and web share one set of rules.                                            |
| `./placeholders`       | `placeholdersIn(text)`, `samePlaceholders(a, b)`, and type `PlaceholdersOf<S>` (template literal inference: `"Hi {name}"` → `"name"`).                                                                                                   |
| `./manifest`           | `defineManifest()`, the `Manifest` types, and type helpers `TextKeys<M, C>`, `ParamsOf<M, C, K>`, `EntryOf<M, C, K>`. Also `checkManifest(manifest, definitions)` → `{ ok, conflicts[], issues[], created[], reactivated[], unused[] }`. |
| `./definitions`        | Wire type for `GET /v1/definitions`.                                                                                                                                                                                                     |
| `./sync`               | `SyncRequest`/`SyncResult` types, `fetchDefinitions(origin)`, `syncManifest({ origin, token, manifest, commit, expected })`.                                                                                                             |
| `./locales`, `./types` | Unchanged.                                                                                                                                                                                                                               |
| `bin: cms-contract`    | `check --manifest <file> --against <origin>` and `sync --manifest <file> --origin <origin> [--force]`. Runs on Node ≥ 22 and needs `git` for `sync`.                                                                                     |
| **Removed**            | `./catalog`, `./catalog-schema`, `./seed/en.json`.                                                                                                                                                                                       |

Manifest as web will write it:

```ts
import { defineManifest } from "@astrologyengine/cms-contract/manifest";

export const manifest = defineManifest({
  locale: "en",
  collections: {
    body: {
      shape: "named",
      entries: {
        SUN: { name: "Sun", insight: "…", keywords: ["identity", "purpose"] },
      },
    },
    house: {
      shape: "reference",
      entries: { "1": { insight: "…", keywords: ["self"] } },
    },
    ui: {
      shape: "text",
      entries: {
        "app.status.updating": "Showing {shown}; you asked for {requested}.",
      },
    },
  },
});
// Web: t("app.status.updating", { shown, requested }) is type-checked.
// Missing or extra params are compile errors.
```

In `text` collections, each entry is a plain string, so TypeScript keeps the
literal type for placeholder inference. On the wire it becomes `{ text }`.

`checkManifest` conflict codes: `shape_changed`, `placeholders_changed`,
`key_retired`, `locale_mismatch`, plus field or name `issues`. It compares
definitions only; it can't see `origin`, so text refresh is decided on the
server.

**Sync client CLI** (`cms-contract sync`):

1. `GET /v1/admin/sync` → head commit `H` (`null` on a fresh environment).
2. If `H` is set and differs from `HEAD`: if `H` isn't in local history, fail
   with "fetch full history (`fetch-depth: 0`)". Otherwise, run
   `git merge-base --is-ancestor H HEAD`, and refuse if it isn't an ancestor
   (stale or out-of-order sync). `--force` skips this step only.
3. `POST /v1/admin/sync` with `{ commit: HEAD, expected: H, manifest }`.
4. Print the summary. Exit non-zero on `409`, `412` or `422`.

The manifest file can be `.json`, or an ES module exporting `manifest`
(Node 24 strips TypeScript types).

## 7. API changes

**New**

| Method & path                                     | Auth   | Description                                                                                                                                                                                                                                                       |
| ------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/definitions`                             | public | Collections with shape; every key with `placeholders` and `status`, **deleted keys included** (needed for `key_retired`). No text. Cacheable, with `ETag: "v<content version>"` like other public routes.                                                         |
| `POST /v1/admin/sync`                             | admin  | `{ commit, expected, manifest }`. Body limit 1 MB. Results: `200` with a summary (`created`, `reactivated`, `unused`, `refreshed`, `drift`). `409 definition_conflict` with `conflicts[]`. `412 precondition_failed` (stale `expected`). `422 validation_failed`. |
| `GET /v1/admin/sync`                              | admin  | Current head `{ commit, syncedAt, actor } \| null` and the last 20 syncs.                                                                                                                                                                                         |
| `DELETE /v1/admin/entries/:collection/:key`       | admin  | Soft-delete. `409` unless the key is `unused`. Writes a `key/delete` revision.                                                                                                                                                                                    |
| `POST /v1/admin/entries/:collection/:key/restore` | admin  | `deleted` → `unused`. Translations come back unchanged. Writes a `key/restore` revision.                                                                                                                                                                          |

**Changed**

- `GET /v1/content/:locale` (and the single-entry route): serves `active` and
  `unused` keys from the registry. `deleted` keys are omitted, or return `404`
  (`unknown_entry`). The response shape is unchanged.
- `PUT …/translations/:locale`: validated against the registry (shape and
  stored placeholders). Sets `origin = 'editor'`. `409` for `deleted` keys.
- `DELETE …/translations/:locale`: still refuses the default locale. There are
  no orphans any more; deleted keys keep their rows for restore.
- `GET /v1/admin/entries/:collection/:key`: adds `status`. `inCatalog` is
  removed.
- `GET /v1/admin/coverage`: `total`, `missing`, `fallbacks` and
  `placeholderMismatches` count **active keys only**. `orphans` is replaced by
  `unused: ["collection:key", …]`.

**Removed:** `GET /v1/admin/catalog` (replaced by `GET /v1/definitions`).

## 8. Sync algorithm (server)

1. Authenticate, apply the 1 MB body limit, and parse the request. Validate the
   manifest with the contract's `validateFields` and name rules (`422`). Check
   that the manifest locale is the default locale.
2. Read the default locale, collections, keys, default-locale translations
   (`origin`, `revision`, `fields`) and `sync_head`: **5 reads**. Run `checkManifest` against them, and answer `409`
   on any conflict.
3. Build the change set: new collections; new keys (`active`, placeholders from
   the text); English inserts (`origin = 'sync'`); English refreshes (where the
   text differs and `origin = 'sync'`); `unused → active`; `active → unused`
   for absent keys. `drift` lists keys whose English differs but has
   `origin = 'editor'`; these are reported, never written.
4. Run **one batch of 13 statements**, each set-based over `json_each(?)`
   where it touches many rows. The count doesn't depend on manifest size:
   1. `UPDATE sync_head SET commit_sha = ?, expected = ?` (the trigger aborts
      on a stale `expected`, giving `412`). _(1)_
   2. Insert collections; insert keys; reactivate keys (`unused → active`);
      mark absent keys `active → unused`. _(4)_
   3. Insert translations; refresh translations with a guard
      `WHERE origin = 'sync' AND revision = ?`. An editor who saves during a
      sync wins: that key isn't refreshed, and it's reported as drift. _(2)_
   4. Insert the `syncs` row, then revisions for created collections, created
      keys, created translations and refreshed translations (`actor` from
      `X-CMS-Actor`, default `sync`; `sync_id` set). Revisions are written
      only for rows that actually changed. _(5)_
   5. Bump `content_version` once, and only if something changed. _(1)_
5. A re-run with the same commit and the same manifest changes nothing and
   doesn't bump the version.

## 9. CI and release matrix (consumer behaviour)

Feature PRs check against staging, release PRs check against alpha, and
deploys sync. Soft delete plus name retirement means that **alpha's definitions
are always a subset of staging's**, so the release PR check is a safety net
that should never fail.

| Scenario                                     | Feature PR (vs staging)            | Main deploy (sync staging)        | Release PR (vs alpha) | Release (sync alpha)                              |
| -------------------------------------------- | ---------------------------------- | --------------------------------- | --------------------- | ------------------------------------------------- |
| New key                                      | ✅                                 | creates                           | ✅                    | creates                                           |
| Changed placeholders on an existing key      | ❌ `placeholders_changed`          | n/a                               | n/a                   | n/a                                               |
| Two PRs add the same key differently         | git conflict or duplicate property | n/a                               | n/a                   | n/a                                               |
| Key removed from the manifest                | ✅                                 | marks `unused`                    | ✅                    | marks `unused`                                    |
| Unused key re-added with the same definition | ✅                                 | reactivates                       | ✅                    | reactivates                                       |
| Deleted key re-added                         | ❌ `key_retired`                   | n/a                               | n/a                   | n/a                                               |
| English typo fix, no editor change           | ✅                                 | refreshes                         | ✅                    | refreshes                                         |
| English typo fix, editor already edited      | ✅                                 | reported as `drift`               | ✅                    | reported as `drift`                               |
| Re-run of an old deploy                      | n/a                                | client refuses (not a descendant) | n/a                   | client refuses                                    |
| Two syncs racing                             | n/a                                | second gets `412`                 | n/a                   | second gets `412`                                 |
| Alpha rolled back to an older release        | n/a                                | n/a                               | n/a                   | no sync needed: keys are never removed by deploys |

## 10. Method

Red/green TDD, as in `docs/plans/cms.md`:

1. **Red:** the smallest test for the next behaviour. Confirm it fails for the
   expected reason. Commit `test(scope): … [red]`.
2. **Green:** the least code that passes, with the whole suite green. Commit
   `feat(scope): …`.
3. **Refactor** with the suite green.

Refactors that don't change behaviour (Phase 2) rely on the existing suite and
must keep it green at every commit. Each phase is done when `bun run test`,
`check`, `lint`, `format:check` and `contract:test` are green.

## Phase 1: Contract primitives (additive)

Nothing in the Worker changes yet.

1. `placeholders`: move `placeholdersIn`/`samePlaceholders` into the contract
   and add `PlaceholdersOf<S>`. Type tests use `expectTypeOf` and run under
   `check`. They cover: none, one, repeated, adjacent, an invalid identifier
   (ignored), and a 2,000-character string.
2. `shapes`: dependency-free `validateFields(shape, fields)` with exactly the
   rules from design §5.2, ported from the zod schemas. Existing
   `fields.test.ts` cases become its tests. The issue format stays
   `{ path, message }`.
3. `manifest`: `defineManifest`, and the type helpers `TextKeys`, `ParamsOf`,
   `EntryOf`. Type tests: an unknown key is an error, a missing or extra param
   is an error, and non-text collections have no params.
4. `checkManifest`: one test per conflict code and per `created` /
   `reactivated` / `unused` outcome, plus a `locale_mismatch` case. Name
   rules: collections `^[a-z]+$`, and keys `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`
   (same as today).

**Done when** the contract builds with no runtime dependencies and its tests
and type tests pass.

## Phase 2: Registry-backed Worker (refactor)

1. Rewrite `0001_init.sql` as in §5. Reset local state
   (`rm -rf .wrangler/state`).
2. Add `src/registry.ts` to load collections and keys. `createApp()` no longer
   takes a catalog. `fields.ts` validates with the contract's `validateFields`
   and the stored placeholders.
3. Test helpers: `defineTestRegistry({ … })` inserts collections and keys
   matching today's `testCatalog`. `resetDb` also clears `keys`,
   `collections`, `syncs` and `sync_head`. `addTranslation` takes an `origin`.
4. Existing behaviour tests stay green without changing their assertions.

**Done when** the suite is green and `src/catalog.ts` / `src/catalog-schema.ts`
have no remaining Worker imports.

## Phase 3: Sync endpoint (TDD)

One red/green pair for each of these behaviours:

1. `401` without a token; `413` above 1 MB; `422` for an invalid manifest or a
   non-default locale.
2. A fresh sync creates collections, keys (`active`), English translations
   (`origin = sync`), revisions (`sync_id` set), a `syncs` row and the head. It
   bumps the version once.
3. Re-running the same commit and manifest is a no-op, with no version bump.
4. `409 definition_conflict` for `shape_changed`, `placeholders_changed` and
   `key_retired`, with nothing written.
5. Absent keys become `unused`; a re-added unused key becomes `active`.
6. English refresh happens only while `origin = sync`; editor-changed keys are
   reported in `drift` and left untouched.
7. A stale `expected` gives `412`, with **no partial writes** (every table is
   unchanged).
8. An editor `PUT` landing between the read and the batch wins. This uses a
   test seam in the sync service that runs a callback between steps 2 and 4.
9. **Scale:** a 2,000-key manifest syncs in one batch. Count every D1
   statement the request issues (reads and batch statements, through a
   counting wrapper around the `DB` binding). Assert the count is identical
   for 3 keys and for 2,000, and is **≤ 20**.
10. `GET /v1/admin/sync` returns the head and recent syncs.

**Done when** all of the above are green.

## Phase 4: Key lifecycle and editor writes (TDD)

1. Admin `PUT` sets `origin = editor`, and validates against the stored shape
   and placeholders.
2. `DELETE /v1/admin/entries/:c/:k`: `409` for `active` keys; `unused` →
   `deleted`, with a revision.
3. `POST …/restore`: `deleted` → `unused`, with translations intact and a
   revision. `409` for any other status.
4. Public bundle and single-entry routes: `active` and `unused` are served,
   `deleted` is not.
5. `PUT` on a deleted key gives `409`. Deleting the default-locale translation
   is still refused.
6. Coverage counts active keys only; `unused[]` replaces `orphans`.
7. Admin entry view returns `status`. `GET /v1/admin/catalog` is removed
   (`404`).

## Phase 5: Definitions endpoint and sync client (TDD)

1. `GET /v1/definitions`: returns its shape, includes deleted keys, contains no
   text, sends an `ETag` and answers `304`, and has CORS like the other public
   routes.
2. Contract `fetchDefinitions`/`syncManifest`, tested with a stub `fetch`.
3. CLI `cms-contract check` and `cms-contract sync`, tested with
   `node --test` against a temporary git repo and a local stub server. Cases:
   first sync; a descendant; a non-descendant refused; `--force`; the head
   missing from a shallow clone (clear error); `412` is reported; the exit
   codes.
4. A `.json` manifest and a `.ts` module manifest both load.

## Phase 6: Tooling cleanup

1. Delete `packages/contract/src/catalog.ts`, `catalog-schema.ts`,
   `seed/en.json`, `src/catalog*.ts`, `src/seed.ts`, `scripts/seed.ts`, and the
   `seed:*` scripts. Replace `test/catalog.test.ts` and `test/seed.test.ts`
   with the contract tests from Phase 1.
2. Add `examples/manifest.ts`: a few keys for each shape, for standalone
   development. Add a `sync:local` script:
   `cms-contract sync --manifest examples/manifest.ts --origin http://127.0.0.1:8787 --force`
   (`--manifest` can be overridden).
3. `dev:e2e`: takes `--manifest <path>` (required). It resets state, applies
   migrations, starts the Worker, waits for `/health`, syncs with `--force`,
   then applies `--fixture` through the admin API. The fixture format is
   unchanged.
4. `pack-contract.mjs`: ship `dist`, `bin` and `LICENSE`, with no `seed`.
   Update `pack-contract.test.mjs`.
5. `deploy.yml`: drop the seed step. `smoke.mjs` still checks English
   coverage, which is active keys only; it passes on a fresh environment with
   no keys. Extend `contract:test` to the contract's CLI tests.
6. `wrangler deploy --dry-run --env staging` and `--env alpha` pass.

## Phase 7: Docs and release

1. Design doc: add a **rev. 3** section that summarises §2 and §4 of this
   plan, and mark decision #9, §5.1 and §8 as superseded.
2. Runbook:
   - First-time setup: no seed. After the CMS deploy, the first web sync (or a
     manual `cms-contract sync`) fills the environment, and must run before the
     web deploy.
   - Routine deploys: migrate → deploy → smoke.
   - Content operations: deleting and restoring keys; `drift` in sync output.
   - Developer workflow for keys now lives in web; link the web docs.
   - **Don't reset the staging database casually.** PR checks rely on it
     keeping every definition. If it is lost or corrupted:
     1. **Time Travel first** (within 30 days on Paid, 7 on Free). It restores
        staging's own history, so nothing is lost.
     2. **Otherwise, clone alpha:**
        `wrangler d1 export DB --remote --env alpha`, then import it into an
        empty staging database. Afterwards, **raise `content_version`** above
        both databases' previous values. Otherwise web isolates holding a
        staging `ETag "vN"` could get a `304` for different content. Then
        **re-sync main** by re-running the latest main deploy. Alpha's sync
        head is a release commit on main, so the ancestry check passes, and
        the sync recreates every unreleased key from main's manifest.
     3. What a clone loses: staging-only edits and translations, staging-only
        locales, staging revision history, and the definitions of keys that
        were added and removed on main **between releases**. Those names could
        then be reused without a conflict. That's harmless, because they never
        reached alpha; the only thing affected is rolling staging back to one
        of those intermediate commits.
   - Recovery if main's history is rewritten: a one-off `--force` sync by an
     admin, recorded in the incident notes.
3. README: setup becomes `migrate:local` → `dev` → `sync:local`. Update the
   layout table and the API quick reference; "Adding copy" points to web.
4. A changeset for the contract (0.2.0, breaking), with a summary of the
   migration for web.
5. Update the plan's status and add an "As built" section.

## 11. Web handoff

To be planned in the web repo. Order matters.

1. **CMS first.** Merge this plan's work and publish contract **0.2.0**. Web
   pinned to 0.1.x keeps working only against a CMS that hasn't been
   redeployed; with deploys gated and nothing live, no compatibility window is
   needed.
2. **Manifest.** Generate web's initial manifest once from the pinned 0.1.x
   package (`catalog.ts` keys + `seed/en.json` text). After that it's edited by
   hand. The `ui` naming convention test (`area.element[.variant]`, lower
   camel case) moves into web's manifest tests.
3. **Copy helpers.** Type `t()` and the entry helpers from the manifest
   (`TextKeys`, `ParamsOf`, `EntryOf`). A key missing from the CMS bundle falls
   back to the **manifest English**, not the raw key. The snapshot fallback
   (design §9.5) is unchanged.
4. **Main deploy** (staging): checkout with `fetch-depth: 0`; run
   `cms-contract sync --origin https://cms-staging.astrologyengine.dev` with
   `CMS_ADMIN_TOKEN` from the `staging` environment secret; then build the
   snapshot and deploy. Syncing before deploy means new keys exist when the
   new code goes live.
5. **Release deploy** (alpha): the same, against
   `https://cms-alpha.astrologyengine.dev`.
6. **PR previews:** no sync and no admin token. New keys render from the
   manifest English.
7. **Feature PR CI:** `cms-contract check --against <staging>`. **Release PR
   CI** (the changesets release branch): `--against <alpha>`. Gate both on
   `CMS_DEPLOY_ENABLED` until the environments exist.
8. **Local:** `dev:stack` and Playwright call `dev:e2e --manifest <web manifest>`.
9. Remove the `$cms` catalog type import and the use of the `seed/en.json`
   snapshot.

## Risks

| Risk                                                                | Mitigation                                                                                                                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1 per-invocation query limits                                      | About 18 statements per sync whatever the size; the Phase 3 scale test asserts the count is identical for 3 and 2,000 keys and ≤ 20.                                     |
| Request CPU time on large syncs (10 ms on Workers Free)             | Today's 25 KB manifest is far below this. Measure sync CPU on staging with the real manifest during first provisioning; Workers Paid (30 s default) removes the concern. |
| The ancestry check runs in the client and can be bypassed           | Only admin-token holders can sync. The server-side compare-and-swap still orders concurrent syncs. Revisit with OIDC during UI planning.                                 |
| Admin token stored in web CI                                        | Only in environment-scoped secrets for the main and release deploy jobs; never in PR workflows (the check uses the public endpoint).                                     |
| Shallow CI clones break the ancestry check                          | The client fails with an explicit message; the handoff requires `fetch-depth: 0`.                                                                                        |
| Staging database lost or reset                                      | Runbook: Time Travel first; otherwise clone alpha, raise `content_version`, re-sync main (Phase 7). The clone only forgets keys that were never released.                |
| TypeScript performance with many template-literal placeholder types | Type test with a 2,000-character string and a 1,000-key manifest in Phase 1. Fallback: an explicit params annotation on individual keys.                                 |
| Public definitions reveal unreleased key names                      | They're already public through the staging bundle. Definitions contain no text.                                                                                          |
| Key names get uglier over time (`…V2`)                              | Accepted in review; preferred over key versioning.                                                                                                                       |

## Out of scope (follow-ups)

- Admin UI, OAuth, and scoped roles (e.g. per-language translators, English
  source editors).
- Replacing `CMS_ADMIN_TOKEN` in CI (e.g. GitHub OIDC).
- Flagging translations as outdated when their English changes.
- The web implementation (§11).
- Spanish content, and anything else already out of scope in the design.
