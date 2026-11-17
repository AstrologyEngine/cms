import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { run, startCms } from "./helpers.mjs";

let cms;
let dir;
before(async () => {
  cms = await startCms();
  dir = await mkdtemp(resolve(tmpdir(), "cms-cli-load-"));
  // Like web: the manifest imports defineManifest from the installed contract.
  await mkdir(resolve(dir, "node_modules/@astrologyengine"), {
    recursive: true,
  });
  await symlink(
    resolve(import.meta.dirname, ".."),
    resolve(dir, "node_modules/@astrologyengine/cms-contract"),
  );
  await writeFile(resolve(dir, "package.json"), '{ "type": "module" }');
  await writeFile(
    resolve(dir, "manifest.ts"),
    `import { defineManifest } from "@astrologyengine/cms-contract/manifest";
type Shape = "text";
const shape: Shape = "text";
export const manifest = defineManifest({
  locale: "en",
  collections: { ui: { shape, entries: { "app.hello": "Hi {name}" } } },
});
`,
  );
  await writeFile(
    resolve(dir, "default.mjs"),
    `export default { locale: "en", collections: { ui: { shape: "text", entries: { "app.bye": "Bye" } } } };`,
  );
  await writeFile(resolve(dir, "neither.mjs"), "export const other = 1;");
  await writeFile(resolve(dir, "broken.json"), "{ not json");
});
after(async () => {
  await cms.close();
  await rm(dir, { recursive: true, force: true });
});

const check = (file) =>
  run(["check", "--manifest", file, "--against", cms.origin], { cwd: dir });

describe("manifest files", () => {
  test("loads a TypeScript module exporting `manifest`", async () => {
    const { status, stdout, stderr } = await check("manifest.ts");
    assert.equal(status, 0, stderr);
    assert.match(stdout, /would create: ui:app\.hello/);
  });

  test("loads a module's default export", async () => {
    const { status, stdout, stderr } = await check("default.mjs");
    assert.equal(status, 0, stderr);
    assert.match(stdout, /would create: ui:app\.bye/);
  });

  test("exits 2 for modules without a manifest, bad JSON and missing files", async () => {
    for (const [file, message] of [
      ["neither.mjs", /exports neither `manifest` nor a default/],
      ["broken.json", /not valid JSON/],
      ["missing.json", /Cannot read manifest/],
    ]) {
      const { status, stderr } = await check(file);
      assert.equal(status, 2, stderr);
      assert.match(stderr, message);
    }
  });
});
