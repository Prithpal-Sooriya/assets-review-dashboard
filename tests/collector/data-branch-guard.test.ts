import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { dataBranchViolations } from "../../scripts/lib/data-branch-guard";

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

/**
 * Reviewed main: src/app.ts + data/raw/x.json. Then a data/auto-refresh
 * worktree branched from main, exactly like collect-data.yml creates it.
 */
async function newRepo(): Promise<{ dir: string; wt: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "guard-"));
  dirs.push(dir);
  await $`git -C ${dir} init -q -b main`.quiet();
  await $`git -C ${dir} config user.email t@example.com`.quiet();
  await $`git -C ${dir} config user.name t`.quiet();
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "data", "raw"), { recursive: true });
  await writeFile(path.join(dir, "src", "app.ts"), "export const app = 1;\n");
  await writeFile(path.join(dir, "data", "raw", "x.json"), "{}\n");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} commit -qm main`.quiet();
  const wt = path.join(dir, "wt");
  await $`git -C ${dir} worktree add -b data/auto-refresh ${wt} main`.quiet();
  return { dir, wt };
}

async function commitAll(wt: string, msg: string): Promise<void> {
  await $`git -C ${wt} add -A`.quiet();
  await $`git -C ${wt} commit -qm ${msg}`.quiet();
}

describe("dataBranchViolations", () => {
  test("data-only change vs main is clean", async () => {
    const { wt } = await newRepo();
    await writeFile(path.join(wt, "data", "raw", "new.json"), "{}\n");
    await commitAll(wt, "collect");
    expect(await dataBranchViolations(wt, "main")).toEqual([]);
  });

  test("src modification is a violation", async () => {
    const { wt } = await newRepo();
    await writeFile(path.join(wt, "src", "app.ts"), "export const app = 2;\n");
    await commitAll(wt, "evil");
    const v = await dataBranchViolations(wt, "main");
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("outside data/");
  });

  test("added non-data file is a violation (diff must list additions)", async () => {
    const { wt } = await newRepo();
    await writeFile(path.join(wt, "evil.ts"), "process.exit(1);\n");
    await commitAll(wt, "evil");
    const v = await dataBranchViolations(wt, "main");
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("evil.ts");
  });

  test("src deletion is a violation", async () => {
    const { wt } = await newRepo();
    await rm(path.join(wt, "src", "app.ts"));
    await commitAll(wt, "evil");
    expect(await dataBranchViolations(wt, "main")).not.toEqual([]);
  });

  test("top-level data symlink is a violation (pathspec blindness)", async () => {
    const { wt } = await newRepo();
    // Replace the whole data/ directory with a symlink to src/: the
    // :(exclude)data pathspec would still exclude the name "data", so the
    // diff check alone is blind to this — the tree check must catch it.
    await rm(path.join(wt, "data"), { recursive: true, force: true });
    await symlink("src", path.join(wt, "data"));
    await commitAll(wt, "evil");
    const v = await dataBranchViolations(wt, "main");
    expect(v.some((p) => p.includes('not a git directory'))).toBe(true);
  });

  test("interior symlink under data/ is a violation (write redirection)", async () => {
    const { wt } = await newRepo();
    // data/raw/link -> ../../src would be excluded by the pathspec yet
    // could redirect rsync/collection writes outside data/.
    await symlink("../../src", path.join(wt, "data", "raw", "link"));
    await commitAll(wt, "evil");
    const v = await dataBranchViolations(wt, "main");
    expect(v.some((p) => p.includes("symlink(s) committed under data/"))).toBe(true);
    expect(v.some((p) => p.includes("data/raw/link"))).toBe(true);
  });

  test("fails closed when git cannot evaluate (bad main ref)", async () => {
    const { wt } = await newRepo();
    await writeFile(path.join(wt, "data", "raw", "new.json"), "{}\n");
    await commitAll(wt, "collect");
    // `git diff <nonexistent-ref> HEAD` errors; the guard must throw rather
    // than mistake an error for a clean result.
    expect(dataBranchViolations(wt, "origin/does-not-exist")).rejects.toThrow();
  });

  test("-X ours convergence with advanced main stays clean", async () => {
    const { dir, wt } = await newRepo();
    // main advances: a new src file + a non-conflicting data edit.
    await writeFile(path.join(dir, "src", "new-on-main.ts"), "export const m = 1;\n");
    await writeFile(path.join(dir, "data", "raw", "x.json"), '{"main-edited":true}\n');
    await $`git -C ${dir} add -A`.quiet();
    await $`git -C ${dir} commit -qm "main advances"`.quiet();
    // branch collected its own data (concurrent change to x.json)
    await writeFile(path.join(wt, "data", "raw", "x.json"), '{"collected":true}\n');
    await writeFile(path.join(wt, "data", "raw", "y.json"), "{}\n");
    await commitAll(wt, "collect");
    await $`git -C ${wt} merge --no-edit -X ours main`.quiet();
    // src/new-on-main.ts must be adopted from main; guard stays clean.
    expect(await dataBranchViolations(wt, "main")).toEqual([]);
  });
});
