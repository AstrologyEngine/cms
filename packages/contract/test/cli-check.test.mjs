import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { manifest, run, startCms } from "./helpers.mjs";

let cms;
let dir;
before(async () => {
  cms = await startCms();
  // Not a git checkout: check needs neither git nor a token.
  dir = await mkdtemp(resolve(tmpdir(), "cms-cli-check-"));
  await writeFile(resolve(dir, "manifest.json"), JSON.stringify(manifest));
});
after(async () => {
  await cms.close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  cms.state.definitions = { default: "en", version: 4, collections: {} };
  cms.state.requests = [];
});

const check = (...extra) =>
  run(
    ["check", "--manifest", "manifest.json", "--against", cms.origin, ...extra],
    {
      cwd: dir,
    },
  );

describe("cms-contract check", () => {
  test("rejects inherited object property names as commands", async () => {
    const { status, stderr } = await run(["constructor"], { cwd: dir });
    assert.equal(status, 2);
    assert.match(stderr, /Usage:/);
  });

  test("passes and lists what a sync would change", async () => {
    cms.state.definitions.collections = {
      ui: {
        shape: "text",
        keys: {
          "app.title": { placeholders: [], status: "unused" },
          "app.gone": { placeholders: [], status: "active" },
        },
      },
    };
    const { status, stdout, stderr } = await check();
    assert.equal(status, 0, stderr);
    assert.match(stdout, /Manifest is compatible with .* \(version 4\)/);
    assert.match(stdout, /would create: ui:app\.count/);
    assert.match(stdout, /would reactivate: ui:app\.title/);
    assert.match(stdout, /would mark unused: ui:app\.gone/);
    assert.deepEqual(
      cms.state.requests.map((r) => `${r.method} ${r.url}`),
      ["GET /v1/definitions"],
    );
    assert.equal(cms.state.requests[0].headers.authorization, undefined);
  });

  test("fails with readable conflicts", async () => {
    cms.state.definitions = {
      default: "fr",
      version: 4,
      collections: {
        ui: {
          shape: "text",
          keys: {
            "app.count": { placeholders: ["count"], status: "active" },
            "app.title": { placeholders: [], status: "deleted" },
          },
        },
      },
    };
    const { status, stderr } = await check();
    assert.equal(status, 1);
    assert.match(stderr, /manifest locale 'en' must be the CMS default 'fr'/);
    assert.match(
      stderr,
      /ui:app\.count: placeholders changed \(CMS \{count\}, manifest \{n\}\)/,
    );
    assert.match(stderr, /ui:app\.title: retired/);
  });

  test("fails for an invalid manifest", async () => {
    const invalid = resolve(dir, "invalid.json");
    await writeFile(
      invalid,
      JSON.stringify({
        locale: "en",
        collections: { ui: { shape: "text", entries: { x: " " } } },
      }),
    );
    const { status, stderr } = await run(
      ["check", "--manifest", invalid, "--against", cms.origin],
      { cwd: dir },
    );
    assert.equal(status, 1);
    assert.match(stderr, /collections\.ui\.entries\.x: Must not be blank\./);
  });

  test("exits 2 without --against or when the CMS is unreachable", async () => {
    for (const args of [
      ["check", "--manifest", "manifest.json"],
      [
        "check",
        "--manifest",
        "manifest.json",
        "--against",
        "http://127.0.0.1:9",
      ],
    ]) {
      const { status, stderr } = await run(args, { cwd: dir });
      assert.equal(status, 2, stderr);
    }
  });
});
