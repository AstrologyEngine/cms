import { spawnSync } from "node:child_process";
import { cliError } from "./errors.js";

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8" });

/** Full SHA of HEAD in `cwd`. */
export const headCommit = (cwd: string) => {
  const result = git(cwd, "rev-parse", "--verify", "HEAD");
  if (result.status !== 0)
    throw cliError(
      2,
      `Not a git checkout with commits (${cwd}); run sync inside the checkout the manifest belongs to.`,
    );
  return result.stdout.trim();
};

/** Whether the commit is present in the local history. */
export const hasCommit = (cwd: string, sha: string) =>
  git(cwd, "cat-file", "-e", `${sha}^{commit}`).status === 0;

/** Whether `ancestor` is an ancestor of (or equal to) `descendant`. */
export const isAncestor = (
  cwd: string,
  ancestor: string,
  descendant: string,
) => {
  const result = git(cwd, "merge-base", "--is-ancestor", ancestor, descendant);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw cliError(2, `git merge-base failed: ${result.stderr.trim()}`);
};
