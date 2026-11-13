import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { syncServiceVersion } from "./sync-version.mjs";

test("release versioning synchronizes the service root with the contract workspace", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cms-version-"));
  try {
    await mkdir(resolve(root, "packages/contract"), { recursive: true });
    await writeFile(
      resolve(root, "package.json"),
      '{"name":"@astrologyengine/cms","private":true,"version":"0.1.0"}',
    );
    await writeFile(
      resolve(root, "packages/contract/package.json"),
      '{"version":"0.2.0"}',
    );
    await syncServiceVersion(root);
    assert.deepEqual(
      JSON.parse(await readFile(resolve(root, "package.json"), "utf8")),
      { name: "@astrologyengine/cms", private: true, version: "0.2.0" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
