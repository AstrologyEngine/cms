#!/usr/bin/env node
/**
 * cms-contract: check a manifest against a CMS, or sync it.
 *
 *   cms-contract check --manifest <file> --against <origin>
 *   cms-contract sync --manifest <file> --origin <origin> [--actor <name>] [--force]
 *
 * `sync` reads the admin token from CMS_ADMIN_TOKEN and must run inside the
 * git checkout whose HEAD the manifest belongs to.
 *
 * Exit codes: 0 success; 1 refused (conflicts, invalid manifest, stale or
 * concurrent sync); 2 could not run (usage, token, file, git, network, auth).
 */
import { parseArgs } from "node:util";
import { checkManifest } from "../manifest.js";
import {
  isCmsError,
  type CmsError,
  fetchDefinitions,
  fetchSyncState,
  syncManifest,
} from "../sync.js";
import type { SyncResult } from "../sync.js";
import type { ManifestConflict, ManifestIssue } from "../manifest.js";
import { cliError, isCliError } from "./errors.js";
import { describeConflict, describeIssue, section } from "./format.js";
import { headCommit, hasCommit, isAncestor } from "./git.js";
import { loadManifest } from "./load.js";

type Options = {
  manifest?: string;
  origin?: string;
  against?: string;
  actor?: string;
  force: boolean;
};

const USAGE = `Usage:
  cms-contract check --manifest <file> --against <origin>
  cms-contract sync --manifest <file> --origin <origin> [--actor <name>] [--force]`;

const required = (value: string | undefined, flag: string) => {
  if (!value) throw cliError(2, `Missing ${flag}.\n${USAGE}`);
  return value;
};

const short = (sha: string) => sha.slice(0, 12);

const describeResult = (origin: string, result: SyncResult) => {
  const lines = [
    `Synced ${short(result.commit)} to ${origin}: version ${result.version}${result.changed ? "" : " (no content changes)"}.`,
  ];
  const lists: [string, string[]][] = [
    ["created collections", result.createdCollections],
    ["created", result.created],
    ["reactivated", result.reactivated],
    ["now unused", result.unused],
    ["refreshed", result.refreshed],
    [
      "drift (editors changed the text; manifest text not applied)",
      result.drift,
    ],
  ];
  for (const [label, ids] of lists)
    if (ids.length) lines.push(`  ${label}: ${ids.join(", ")}`);
  return lines.join("\n");
};

const sync = async (options: Options) => {
  const origin = required(options.origin, "--origin");
  const file = required(options.manifest, "--manifest");
  const token = process.env.CMS_ADMIN_TOKEN ?? "";
  if (!token) throw cliError(2, "CMS_ADMIN_TOKEN is not set.");
  const manifest = await loadManifest(file);
  const cwd = process.cwd();
  const commit = headCommit(cwd);
  const client = { origin, token, actor: options.actor };
  const { head } = await fetchSyncState(client);
  const expected = head?.commit ?? null;
  if (expected && expected !== commit && !options.force) {
    if (!hasCommit(cwd, expected))
      throw cliError(
        2,
        `The last synced commit ${short(expected)} is not in this checkout's history; fetch full history (e.g. actions/checkout with fetch-depth: 0).`,
      );
    if (!isAncestor(cwd, expected, commit))
      throw cliError(
        1,
        `HEAD ${short(commit)} does not descend from the last synced commit ${short(expected)}: this manifest is older than, or diverged from, what ${origin} has. Refusing to sync (use --force only to recover, e.g. after history was rewritten).`,
      );
  }
  const result = await syncManifest({ ...client, commit, expected, manifest });
  console.log(describeResult(origin, result));
  return 0;
};

/** CMS answers that mean "refused" (exit 1) rather than "could not run". */
const REFUSALS = new Set([
  "definition_conflict",
  "validation_failed",
  "precondition_failed",
]);

const describeCmsError = (error: CmsError) => {
  const heading = `cms-contract: ${error.message} (${error.status} ${error.code})`;
  const conflicts = (error.details.conflicts ?? []) as ManifestConflict[];
  const issues = (error.details.issues ?? []) as ManifestIssue[];
  if (conflicts.length)
    return section(heading, conflicts.map(describeConflict));
  if (issues.length) return section(heading, issues.map(describeIssue));
  return heading;
};

const check = async (options: Options) => {
  const origin = required(options.against, "--against");
  const manifest = await loadManifest(required(options.manifest, "--manifest"));
  const definitions = await fetchDefinitions({ origin });
  const result = checkManifest(manifest, definitions);
  if (!result.ok) {
    const parts = [`cms-contract: manifest is not compatible with ${origin}.`];
    if (result.conflicts.length)
      parts.push(section("Conflicts:", result.conflicts.map(describeConflict)));
    if (result.issues.length)
      parts.push(section("Issues:", result.issues.map(describeIssue)));
    console.error(parts.join("\n"));
    return 1;
  }
  const lines = [
    `Manifest is compatible with ${origin} (version ${definitions.version}).`,
  ];
  const lists: [string, string[]][] = [
    ["would create collections", result.createdCollections],
    ["would create", result.created],
    ["would reactivate", result.reactivated],
    ["would mark unused", result.unused],
  ];
  for (const [label, ids] of lists)
    if (ids.length) lines.push(`  ${label}: ${ids.join(", ")}`);
  console.log(lines.join("\n"));
  return 0;
};

const commands: Record<string, (options: Options) => Promise<number>> = {
  check,
  sync,
};

const main = async () => {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        manifest: { type: "string" },
        origin: { type: "string" },
        against: { type: "string" },
        actor: { type: "string" },
        force: { type: "boolean", default: false },
      },
    });
  } catch (error) {
    throw cliError(2, `${(error as Error).message}\n${USAGE}`);
  }
  const [name] = parsed.positionals;
  const command =
    name && Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (!command) throw cliError(2, USAGE);
  return command(parsed.values);
};

try {
  process.exitCode = await main();
} catch (error) {
  if (isCliError(error)) {
    console.error(`cms-contract: ${error.message}`);
    process.exitCode = error.exitCode;
  } else if (isCmsError(error)) {
    console.error(describeCmsError(error));
    process.exitCode = REFUSALS.has(error.code) ? 1 : 2;
  } else throw error;
}
