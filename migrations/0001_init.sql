-- CMS schema. See docs/designs/cms.md §6.1 and docs/plans/web-owned-catalog.md §5.
-- Migrations are additive-only once an environment has been deployed.

CREATE TABLE locales (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  is_default  INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  fallback    TEXT REFERENCES locales (code) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX locales_single_default ON locales (is_default) WHERE is_default = 1;

-- Key registry: web's manifest defines it; sync creates entries, never reshapes them.
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
  -- Who last wrote the text: sync may refresh default-locale text only while 'sync'.
  origin      TEXT NOT NULL CHECK (origin IN ('sync', 'editor')),
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (collection, key, locale),
  FOREIGN KEY (collection, key) REFERENCES keys (collection, key)
);
CREATE INDEX translations_locale ON translations (locale);

CREATE TABLE syncs (
  id          INTEGER PRIMARY KEY,
  commit_sha  TEXT NOT NULL,
  actor       TEXT NOT NULL,
  summary     TEXT NOT NULL CHECK (json_valid(summary)),
  created_at  TEXT NOT NULL
);

-- Single row: the last synced web commit. An update must name the current
-- commit in `expected`; otherwise the trigger aborts the whole batch.
CREATE TABLE sync_head (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  commit_sha  TEXT,
  expected    TEXT,
  updated_at  TEXT
);
CREATE TRIGGER sync_head_cas BEFORE UPDATE ON sync_head
WHEN NEW.expected IS NOT OLD.commit_sha
BEGIN
  SELECT RAISE(ABORT, 'sync_conflict');
END;

CREATE TABLE revisions (
  id          INTEGER PRIMARY KEY,
  subject     TEXT NOT NULL CHECK (subject IN ('translation', 'locale', 'collection', 'key')),
  action      TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'restore')),
  collection  TEXT,
  key         TEXT,
  locale      TEXT,
  before      TEXT,
  after       TEXT,
  actor       TEXT NOT NULL,
  sync_id     INTEGER REFERENCES syncs (id),
  created_at  TEXT NOT NULL
);
CREATE INDEX revisions_lookup ON revisions (collection, key, locale, id);

CREATE TABLE meta (
  key    TEXT PRIMARY KEY,
  value  INTEGER NOT NULL
);

INSERT INTO meta (key, value) VALUES ('content_version', 1);
INSERT INTO sync_head (id, commit_sha, expected, updated_at) VALUES (1, NULL, NULL, NULL);
INSERT INTO locales (code, name, enabled, is_default, fallback, created_at, updated_at)
VALUES ('en', 'English', 1, 1, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
