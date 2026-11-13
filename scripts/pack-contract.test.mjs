import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { packContract } from "./pack-contract.mjs";

test("packed contract installs independently with types, locale rules and baseline copy", async () => {
  const root = resolve(import.meta.dirname, "..");
  const revision = "a".repeat(40);
  const archive = await packContract({ root, revision });
  const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
  assert.match(files, /dist\/catalog.d.ts/);
  assert.match(files, /seed\/en.json/);
  assert.doesNotMatch(
    files,
    /wrangler|\.dev.vars|migrations|node_modules|src\/auth/,
  );
  const temp = await mkdtemp(resolve(tmpdir(), "cms-contract-install-"));
  try {
    await writeFile(
      resolve(temp, "package.json"),
      JSON.stringify({
        type: "module",
        dependencies: { "@astrologyengine/cms-contract": `file:${archive}` },
      }),
    );
    execFileSync("bun", ["install"], { cwd: temp, stdio: "pipe" });
    const output = execFileSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `import { catalog } from '@astrologyengine/cms-contract/catalog'; import { negotiate } from '@astrologyengine/cms-contract/locales'; import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const seed = require('@astrologyengine/cms-contract/seed/en.json'); const pkg = require('@astrologyengine/cms-contract/package.json'); console.log(JSON.stringify({ key: catalog.ui.keys['brand.name'], locale: negotiate(['es-ES'], ['en', 'es-419'], 'en'), name: seed.entries.ui['brand.name'].text, revision: pkg.cmsRevision }));`,
      ],
      { cwd: temp, encoding: "utf8" },
    );
    assert.deepEqual(JSON.parse(output), {
      key: [],
      locale: "es-419",
      name: "Astrology Engine",
      revision,
    });
    assert.equal(
      JSON.parse(
        await readFile(
          resolve(
            temp,
            "node_modules/@astrologyengine/cms-contract/package.json",
          ),
          "utf8",
        ),
      ).dependencies,
      undefined,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
