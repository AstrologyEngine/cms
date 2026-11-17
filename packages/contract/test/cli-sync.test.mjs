import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { git, makeRepo, manifest, run, startCms, TOKEN } from "./helpers.mjs";

let repo;
let cms;
/** Extra temporary directories (worktrees, clones) removed after the run. */
const temporary = [];
before(async () => {
  repo = await makeRepo();
  cms = await startCms();
});
after(async () => {
  await cms.close();
  await repo.cleanup();
  for (const dir of temporary) await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  cms.state.head = null;
  cms.state.post = null;
  cms.state.requests = [];
});

const sync = (...extra) =>
  run(
    ["sync", "--manifest", "manifest.json", "--origin", cms.origin, ...extra],
    {
      cwd: repo.dir,
      env: { CMS_ADMIN_TOKEN: TOKEN },
    },
  );

describe("cms-contract sync", () => {
  test("first sync sends HEAD with expected null", async () => {
    const { status, stdout, stderr } = await sync();
    assert.equal(status, 0, stderr);
    const [post] = cms.posts();
    assert.deepEqual(post.body, { commit: repo.b, expected: null, manifest });
    assert.equal(post.headers.authorization, `Bearer ${TOKEN}`);
    assert.match(stdout, new RegExp(`Synced ${repo.b.slice(0, 12)}`));
    assert.match(stdout, /version 5/);
    assert.match(stdout, /created: ui:app\.count/);
  });

  test("a descendant of the last synced commit sends it as expected", async () => {
    cms.state.head = repo.a;
    const { status, stderr } = await sync();
    assert.equal(status, 0, stderr);
    assert.deepEqual(cms.posts()[0].body.expected, repo.a);
    assert.equal(cms.posts()[0].body.commit, repo.b);
  });

  test("re-syncing the last synced commit needs no ancestry check", async () => {
    cms.state.head = repo.b;
    const { status, stderr } = await sync();
    assert.equal(status, 0, stderr);
    assert.equal(cms.posts()[0].body.expected, repo.b);
  });

  test("forwards --actor as X-CMS-Actor", async () => {
    const { status, stderr } = await sync("--actor", "web-ci");
    assert.equal(status, 0, stderr);
    assert.equal(cms.posts()[0].headers["x-cms-actor"], "web-ci");
  });
});

describe("cms-contract sync refusals", () => {
  test("refuses a HEAD that doesn't descend from the last synced commit", async () => {
    cms.state.head = repo.b;
    const { status, stderr } = await run(
      ["sync", "--manifest", "manifest.json", "--origin", cms.origin],
      { cwd: await checkout(repo.c), env: { CMS_ADMIN_TOKEN: TOKEN } },
    );
    assert.equal(status, 1);
    assert.match(stderr, /does not descend from the last synced commit/);
    assert.equal(cms.posts().length, 0);
  });

  test("asks for full history when the last synced commit isn't local", async () => {
    cms.state.head = repo.a;
    const { status, stderr } = await run(
      ["sync", "--manifest", "manifest.json", "--origin", cms.origin],
      { cwd: await shallowClone(), env: { CMS_ADMIN_TOKEN: TOKEN } },
    );
    assert.equal(status, 2);
    assert.match(stderr, /fetch-depth: 0/);
    assert.equal(cms.posts().length, 0);
  });

  test("--force skips the ancestry check but still sends the current head", async () => {
    cms.state.head = repo.b;
    const { status, stderr } = await run(
      [
        "sync",
        "--manifest",
        "manifest.json",
        "--origin",
        cms.origin,
        "--force",
      ],
      { cwd: await checkout(repo.c), env: { CMS_ADMIN_TOKEN: TOKEN } },
    );
    assert.equal(status, 0, stderr);
    assert.deepEqual(
      {
        commit: cms.posts()[0].body.commit,
        expected: cms.posts()[0].body.expected,
      },
      { commit: repo.c, expected: repo.b },
    );
  });
});

/** A worktree of the repo at `commit` (detached). */
const checkout = async (commit) => {
  const dir = await mkdtemp(resolve(tmpdir(), "cms-cli-worktree-"));
  temporary.push(dir);
  await rm(dir, { recursive: true });
  git(repo.dir, "worktree", "add", "-q", "--detach", dir, commit);
  return dir;
};

/** A depth-1 clone of main (HEAD = B, without A in its history). */
const shallowClone = async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "cms-cli-shallow-"));
  temporary.push(dir);
  git(dir, "clone", "-q", "--depth", "1", `file://${repo.dir}`, "clone");
  return resolve(dir, "clone");
};

describe("cms-contract sync errors", () => {
  test("prints definition conflicts and exits 1", async () => {
    cms.state.post = {
      status: 409,
      body: {
        error: {
          code: "definition_conflict",
          message: "The manifest changes existing definitions.",
          conflicts: [
            {
              code: "placeholders_changed",
              collection: "ui",
              key: "app.count",
              expected: ["n"],
              actual: ["count"],
            },
            { code: "key_retired", collection: "ui", key: "app.old" },
            {
              code: "shape_changed",
              collection: "body",
              expected: "named",
              actual: "reference",
            },
          ],
        },
      },
    };
    const { status, stderr } = await sync();
    assert.equal(status, 1);
    assert.match(
      stderr,
      /ui:app\.count: placeholders changed \(CMS \{n\}, manifest \{count\}\)/,
    );
    assert.match(stderr, /ui:app\.old: retired/);
    assert.match(stderr, /body: shape changed \(named → reference\)/);
  });

  test("prints manifest issues and exits 1", async () => {
    cms.state.post = {
      status: 422,
      body: {
        error: {
          code: "validation_failed",
          message: "Manifest is invalid.",
          issues: [
            {
              path: "manifest.collections.ui.entries.x",
              message: "Must not be blank.",
            },
          ],
        },
      },
    };
    const { status, stderr } = await sync();
    assert.equal(status, 1);
    assert.match(
      stderr,
      /manifest\.collections\.ui\.entries\.x: Must not be blank\./,
    );
  });

  test("reports a concurrent sync (412) and exits 1", async () => {
    cms.state.post = {
      status: 412,
      body: {
        error: {
          code: "precondition_failed",
          message: "Another sync happened first.",
        },
      },
    };
    const { status, stderr } = await sync();
    assert.equal(status, 1);
    assert.match(stderr, /Another sync happened first/);
  });

  test("exits 2 when it can't run", async () => {
    const cases = [
      // wrong token
      run(["sync", "--manifest", "manifest.json", "--origin", cms.origin], {
        cwd: repo.dir,
        env: { CMS_ADMIN_TOKEN: "wrong".repeat(10) },
      }),
      // unreachable CMS
      run(
        [
          "sync",
          "--manifest",
          "manifest.json",
          "--origin",
          "http://127.0.0.1:9",
        ],
        {
          cwd: repo.dir,
          env: { CMS_ADMIN_TOKEN: TOKEN },
        },
      ),
      // missing token
      run(["sync", "--manifest", "manifest.json", "--origin", cms.origin], {
        cwd: repo.dir,
      }),
      // not a git checkout
      run(
        [
          "sync",
          "--manifest",
          `${repo.dir}/manifest.json`,
          "--origin",
          cms.origin,
        ],
        {
          cwd: tmpdir(),
          env: { CMS_ADMIN_TOKEN: TOKEN },
        },
      ),
      // missing flag
      run(["sync", "--manifest", "manifest.json"], {
        cwd: repo.dir,
        env: { CMS_ADMIN_TOKEN: TOKEN },
      }),
    ];
    for (const { status, stderr } of await Promise.all(cases)) {
      assert.equal(status, 2, stderr);
      assert.match(stderr, /^cms-contract: /);
    }
    assert.equal(cms.posts().length, 0);
  });
});
