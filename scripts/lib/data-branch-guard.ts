/**
 * Data-branch guard core (invoked by collect-data.yml's Prepare step via
 * scripts/check-data-branch.ts; unit-tested here).
 *
 * The data branch (data/auto-refresh) descends from the default branch and
 * therefore carries its reviewed tree. Its safety property is NOT that it
 * contains no code (it contains main's own code, byte-identical) but that
 * its committed diff vs the default branch is data-only:
 *
 *   1. The top-level `data` entry must be a real git TREE (directory).
 *      A symlink or blob there would slide under the `:(exclude)data`
 *      pathspec while replacing the dashboard's data directory with
 *      something else entirely.
 *   2. No symlinks anywhere under data/ — interior symlinks are equally
 *      invisible to the pathspec and could redirect writes outside data/.
 *   3. No committed path outside `data/` may differ from the main ref —
 *      no modification, addition, or deletion. This is what makes merging
 *      the data PR apply only data changes to main, and what contains a
 *      malicious/diverged push to the data branch: `git merge -X ours`
 *      would happily RETAIN attacker code in the local merge, but this
 *      guard then refuses the run before anything is pushed.
 *
 * Fail-closed: any git error throws (Bun.$ rejects on non-zero exit), and
 * the CLI turns that into a refusal — a guard that cannot evaluate never
 * passes.
 */

import { $ } from "bun";

export async function dataBranchViolations(worktree: string, mainRef: string): Promise<string[]> {
  const problems: string[] = [];

  // 1. Top-level `data` must be a directory (git tree object, mode 040000).
  const tree = await $`git -C ${worktree} ls-tree HEAD -- data`.quiet().text();
  const lines = tree.split("\n").filter((l) => l !== "");
  if (lines.length !== 1 || !/^040000 tree /.test(lines[0]!)) {
    problems.push(
      `top-level "data" entry is not a git directory (tree) — got ${lines.length} entr${lines.length === 1 ? "y" : "ies"}: ${lines[0] ?? "(missing)"}`,
    );
  }

  // 2. No symlinks anywhere under data/ — the :(exclude)data pathspec is
  //    blind to interior symlinks too, and one (e.g. data/raw → ../.github)
  //    could redirect rsync/collection writes outside data/. data/ must
  //    contain only real files and directories.
  const entries = (await $`git -C ${worktree} ls-tree -r HEAD -- data`.quiet().text())
    .split("\n")
    .filter((l) => l !== "");
  const symlinks = entries.filter((l) => l.startsWith("120000"));
  if (symlinks.length > 0) {
    const first = symlinks[0]!.split("\t")[1] ?? "?";
    problems.push(`symlink(s) committed under data/ (first: ${first}) — data/ must contain only real files/directories`);
  }

  // 3. Committed changed-paths vs the main ref, outside data/, must be empty.
  const diff = await $`git -C ${worktree} diff --name-only ${mainRef} HEAD -- . ':(exclude)data'`.quiet().text();
  const changed = diff.split("\n").filter((l) => l !== "");
  if (changed.length > 0) {
    problems.push(
      `committed diff vs ${mainRef} outside data/ (first: ${changed.slice(0, 5).join(", ")})`,
    );
  }

  return problems;
}
