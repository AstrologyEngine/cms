/** Test helpers for the cms-contract CLI (run with `node --test`). */
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export const CLI = resolve(import.meta.dirname, "../dist/cli/main.js");
export const TOKEN = "t".repeat(40);

export const manifest = {
  locale: "en",
  collections: {
    ui: {
      shape: "text",
      entries: { "app.title": "Explorer", "app.count": "{n} left" },
    },
  },
};

export const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/**
 * A repository with main: A → B and a side branch C off A (not a descendant
 * of B). HEAD is B. `manifest.json` is committed in each.
 */
export const makeRepo = async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "cms-cli-repo-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.test");
  git(dir, "config", "commit.gpgsign", "false");
  const commit = async (message) => {
    await writeFile(resolve(dir, "manifest.json"), JSON.stringify(manifest));
    await writeFile(resolve(dir, "log.txt"), message);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", message);
    return git(dir, "rev-parse", "HEAD");
  };
  const a = await commit("A");
  git(dir, "checkout", "-q", "-b", "side");
  const c = await commit("C");
  git(dir, "checkout", "-q", "main");
  const b = await commit("B");
  return {
    dir,
    a,
    b,
    c,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
};

export const syncResult = (commit, overrides = {}) => ({
  commit,
  changed: true,
  version: 5,
  createdCollections: [],
  created: ["ui:app.count"],
  reactivated: [],
  unused: [],
  refreshed: [],
  drift: [],
  ...overrides,
});

/**
 * A stub CMS. `state.head` is the last synced commit; `state.post` overrides
 * the POST /v1/admin/sync response ({ status, body }); `state.definitions`
 * answers GET /v1/definitions. Every request is recorded.
 */
export const startCms = async () => {
  const state = {
    head: null,
    post: null,
    definitions: { default: "en", version: 4, collections: {} },
    requests: [],
  };
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const record = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: raw ? JSON.parse(raw) : undefined,
    };
    state.requests.push(record);
    const send = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const admin = request.url.startsWith("/v1/admin/");
    if (admin && request.headers.authorization !== `Bearer ${TOKEN}`)
      return send(401, {
        error: {
          code: "unauthorized",
          message: "A valid admin token is required.",
        },
      });
    if (request.method === "GET" && request.url === "/v1/definitions")
      return send(200, state.definitions);
    if (request.method === "GET" && request.url === "/v1/admin/sync")
      return send(200, {
        head: state.head
          ? {
              commit: state.head,
              syncedAt: "2026-11-01T00:00:00.000Z",
              actor: "sync",
            }
          : null,
        recent: [],
      });
    if (request.method === "POST" && request.url === "/v1/admin/sync") {
      if (state.post) return send(state.post.status, state.post.body);
      state.head = record.body.commit;
      return send(200, syncResult(record.body.commit));
    }
    send(404, { error: { code: "not_found", message: "Not found." } });
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    state,
    posts: () => state.requests.filter((r) => r.method === "POST"),
    close: () => new Promise((done) => server.close(done)),
  };
};

/** Run the built CLI; resolves with { status, stdout, stderr }. */
export const run = (args, { cwd, env = {} } = {}) =>
  new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
