import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { publishRelease } from "./release.mjs";
publishRelease({
  run: (command, args) =>
    execFileSync(command, args, { encoding: "utf8" }).trim(),
  version: JSON.parse(readFileSync("package.json", "utf8")).version,
  repository: "AstrologyEngine/cms",
  asset: `artifacts/cms-contract-${JSON.parse(readFileSync("package.json", "utf8")).version}.tgz`,
  prepareAsset: () =>
    execFileSync("bun", ["run", "contract:pack"], { stdio: "inherit" }),
});
