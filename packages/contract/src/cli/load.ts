import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cliError } from "./errors.js";

const MODULES = new Set([".ts", ".mts", ".js", ".mjs"]);

/**
 * Read a manifest: `.json`, or an ES module (`.ts`/`.mts` need Node's type
 * stripping, on by default from Node 22.18) exporting `manifest` or a default.
 */
export const loadManifest = async (file: string): Promise<unknown> => {
  const path = resolve(file);
  if (MODULES.has(extname(path))) {
    let module: Record<string, unknown>;
    try {
      module = (await import(pathToFileURL(path).href)) as Record<
        string,
        unknown
      >;
    } catch (error) {
      throw cliError(
        2,
        `Cannot load manifest module ${path}: ${(error as Error).message}`,
      );
    }
    const manifest = module.manifest ?? module.default;
    if (manifest === undefined)
      throw cliError(
        2,
        `Manifest module ${path} exports neither \`manifest\` nor a default.`,
      );
    return manifest;
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw cliError(2, `Cannot read manifest ${path}.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw cliError(2, `Manifest ${path} is not valid JSON.`);
  }
};
