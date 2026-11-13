import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const syncServiceVersion = async (root) => {
  const servicePath = resolve(root, "package.json");
  const service = JSON.parse(await readFile(servicePath, "utf8"));
  const contract = JSON.parse(
    await readFile(resolve(root, "packages/contract/package.json"), "utf8"),
  );
  await writeFile(
    servicePath,
    JSON.stringify({ ...service, version: contract.version }, null, 2) + "\n",
  );
};
if (process.argv[1] === fileURLToPath(import.meta.url))
  await syncServiceVersion(fileURLToPath(new URL("..", import.meta.url)));
