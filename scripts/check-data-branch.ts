/**
 * Data-branch guard CLI (run by collect-data.yml's Prepare step).
 *
 *   bun run scripts/check-data-branch.ts <data-branch-worktree> <main-ref>
 *
 * Exit 0: the worktree's HEAD is a faithful main-descendant whose committed
 *         diff vs <main-ref> is data-only (top-level data is a directory).
 * Exit 1: violation (or the guard could not evaluate — fail closed), with
 *         ::error annotations naming the problem.
 * Exit 2: usage error.
 *
 * The workflow runs this BEFORE any collection or push, so a violating or
 * unevaluable data branch fails the run loudly with nothing pushed.
 */

import { dataBranchViolations } from "./lib/data-branch-guard";

const [worktree, mainRef] = process.argv.slice(2);
if (!worktree || !mainRef) {
  console.error("usage: bun run scripts/check-data-branch.ts <data-branch-worktree> <main-ref>");
  process.exit(2);
}

let problems: string[];
try {
  problems = await dataBranchViolations(worktree, mainRef);
} catch (e) {
  console.error(`::error::data-branch guard could not evaluate (git error — failing closed): ${e}`);
  process.exit(1);
}

if (problems.length > 0) {
  for (const p of problems) console.error(`::error::data-branch guard: ${p}`);
  process.exit(1);
}
console.log(`data-branch guard: clean (data-only diff vs ${mainRef}, data/ is a directory)`);
