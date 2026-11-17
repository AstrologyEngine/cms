# Astrology Engine CMS

A Cloudflare Worker backed by D1 that holds all Natal Chart Explorer website copy,
per locale. The public API serves anonymous, read-only requests; the admin API
requires a Bearer token.

- Design: [`docs/designs/cms.md`](docs/designs/cms.md)
- Operations (Cloudflare setup, deploys, content edits, incidents):
  [`docs/runbooks/cms.md`](docs/runbooks/cms.md)

## Setup

Bun 1.3.14 and Node 24.10.0.

```sh
bun install --frozen-lockfile
bun run migrate:local
bun run seed:local
bun run dev                # persistent local D1 on :8787
```

Or keep local data between runs:

```sh
bun run migrate:local && bun run seed:local && bun run dev
```

For admin calls locally, copy `.dev.vars.example` to `.dev.vars` (the token must
be at least 32 characters).

## Checks

```sh
bun run test          # Vitest in workerd against a real local D1
bun run check         # TypeScript (Worker and scripts)
bun run lint
bun run format:check
```

## Layout

| Path                               | Purpose                                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `packages/contract/src/catalog.ts` | Every collection and key the site may use, plus the placeholders of each `ui` text. The website type-imports it. |
| `packages/contract/seed/en.json`   | English text for every catalog entry; tests enforce exact parity with the catalog.                               |
| `migrations/`                      | D1 schema. Additive-only.                                                                                        |
| `src/routes/public.ts`             | `GET /v1/locales`, `GET /v1/content/:locale[/:collection/:key]`                                                  |
| `src/routes/admin.ts`              | Locales, translations, coverage, revisions, catalog                                                              |
| `packages/contract/src/locales.ts` | Language-tag rules and fallback chains, shared with the website                                                  |
| `scripts/seed.ts`                  | Inserts missing seed rows (`--local` or `--env <env>`); never overwrites edits                                   |
| `scripts/dev-e2e.ts`               | Fresh seeded local CMS, optionally with a `--fixture` of extra locales (used by Playwright)                      |

## API quick reference

Public (no auth; cacheable, `ETag: "v<content version>"`):

```sh
curl localhost:8787/health
curl localhost:8787/v1/locales
curl localhost:8787/v1/content/en
curl localhost:8787/v1/content/en/body/SUN
```

Admin (`Authorization: Bearer $CMS_ADMIN_TOKEN`; optional `X-CMS-Actor: <name>`):

| Method & path                                                                                 | Purpose                                                                             |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /v1/admin/locales` · `POST /v1/admin/locales` · `PATCH`/`DELETE /v1/admin/locales/:code` | Manage locales (new ones start disabled)                                            |
| `GET /v1/admin/entries/:collection/:key`                                                      | All stored translations of an entry                                                 |
| `PUT`/`DELETE /v1/admin/entries/:collection/:key/translations/:locale`                        | Edit text (`If-Match: "r<n>"` or `If-None-Match: *` for concurrency)                |
| `GET /v1/admin/coverage`                                                                      | Missing, fallback-served and placeholder-mismatched entries per locale; unused keys |
| `GET /v1/admin/revisions`                                                                     | History, newest first (`collection`, `key`, `locale`, `before`, `limit`)            |
| `GET /v1/definitions` (public)                                                                | Registered collections and key definitions                                          |

Field shapes: `body`, `angle`, `sign` and `aspect` take
`{ name, insight, keywords }`; `house` takes `{ insight, keywords }`; `ui` takes
`{ text }`, where `text` must contain exactly the registered key's `{placeholders}`.

## Adding copy

The running CMS reads collections and keys from D1. A website can define a typed
manifest with `defineManifest` from `@astrologyengine/cms-contract/manifest`, then
register it through `POST /v1/admin/sync`. The contract CLI provides
`cms-contract check --manifest <file> --against <origin>` and
`cms-contract sync --manifest <file> --origin <origin>`; sync reads
`CMS_ADMIN_TOKEN` and uses the checkout's HEAD and full git history.

Sync registers new keys, preserves editor changes, and marks omitted keys unused.
Unused keys remain served for older web builds. Admins can soft-delete unused keys
and restore them; collection shapes and placeholder definitions cannot change.
`GET /v1/definitions` exposes definitions without translation text.

The legacy catalog, English seed, and seed commands remain for transitional local
and release tooling. Website manifest ownership and deploy integration are a
separate handoff; see [the plan](docs/plans/web-owned-catalog.md). The rewritten
initial schema requires a fresh database; it is not an upgrade migration for an
existing CMS database.

## Develop with web

Clone `AstrologyEngine/web` and this repository as sibling `web` and `cms`
directories. From web run `bun run dev:stack`. For other locations set
`CMS_REPO_PATH=/absolute/path/to/cms`. `WEB_PORT` and `CMS_PORT` override 5173
and 8787. The launcher builds/watches and temporarily links the local contract;
Ctrl+C restores web's pinned package. No global package registration is used.

Each repo can run separately. Start this Worker with the setup commands above,
then run `CMS_ORIGIN=http://127.0.0.1:8787 bun run dev` in web. Web uses its
released contract unless started through `dev:stack`.

`bun run dev:e2e` resets only `.wrangler/e2e-<port>` for isolated tests; never
use it for persistent editorial work. Existing monorepo `.wrangler` data is not
moved or deleted by extraction. With all local Workers stopped, copy the old
`.wrangler/state` directory into this checkout's `.wrangler/state` if needed;
keep a backup and do not overwrite an existing target database.

## Contract and releases

`packages/contract` owns the catalog, locale helpers, wire types and baseline
English seed. Worker source modules re-export these definitions for existing
service code. `bun run contract:build` emits ESM and declarations;
`bun run contract:pack` creates `artifacts/cms-contract-<version>.tgz` with the
full source commit in `cmsRevision`. The archive has no runtime dependencies.

Web pins a public GitHub release asset and lockfile integrity. CI selects the
CMS revision recorded in that asset for integration tests. Ordinary web builds
need neither this checkout nor a running CMS.

Use `bun run changeset` and select the contract package for versioned service
or contract changes. The version script synchronizes the service root version
from the contract after Changesets runs. Main runs CI and maintains a
release PR; merging that PR publishes a GitHub prerelease with its contract
asset. Published tags/assets are never overwritten. Deploy CMS and seed added
keys before updating web's package URL; remove old keys only after all deployed
web consumers have migrated. Editorial edits require no package release.

Remote deployments are disabled unless repository variable
`CMS_DEPLOY_ENABLED=true`. Configure `CLOUDFLARE_ACCOUNT_ID`, environment secrets
`CLOUDFLARE_API_TOKEN` and `CMS_ADMIN_TOKEN`, and actual D1 IDs before enabling.
Main targets staging; published prereleases target alpha. The deployment
workflow migrates, deploys, seeds and verifies health and English coverage.
Configure the release GitHub App secrets `RELEASE_APP_CLIENT_ID` and
`RELEASE_APP_PRIVATE_KEY`, install the App on this repo, and set
`RELEASE_AUTOMATION_ENABLED=true` to enable release PR automation. Package
publication is independent of the Cloudflare gate.

Hosted provisioning and acceptance remain tracked in
[web-issues#39](https://github.com/AstrologyEngine/web-issues/issues/39).
