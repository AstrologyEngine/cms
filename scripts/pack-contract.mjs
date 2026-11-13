import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const packContract = async ({ root, revision }) => {
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw new Error("Expected a full CMS commit SHA");
  const source = resolve(root, "packages/contract");
  const pkg = JSON.parse(
    await readFile(resolve(source, "package.json"), "utf8"),
  );
  const service = JSON.parse(
    await readFile(resolve(root, "package.json"), "utf8"),
  );
  if (pkg.version !== service.version)
    throw new Error("CMS and contract versions must match");
  const stage = resolve(root, "artifacts/package");
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  for (const file of ["dist", "seed", "LICENSE"])
    await cp(resolve(source, file), resolve(stage, file), { recursive: true });
  await writeFile(
    resolve(stage, "package.json"),
    JSON.stringify({ ...pkg, cmsRevision: revision }, null, 2) + "\n",
  );
  const archive = resolve(root, `artifacts/cms-contract-${pkg.version}.tgz`);
  execFileSync("bun", ["pm", "pack", "--filename", archive], {
    cwd: stage,
    stdio: "inherit",
  });
  return archive;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const revision =
    process.env.CMS_REVISION ||
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  console.log(await packContract({ root, revision }));
}
