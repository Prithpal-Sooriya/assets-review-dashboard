import { describe, expect, test } from "bun:test";
import path from "node:path";
import { parse } from "yaml";

/**
 * Workflow structure invariants (parsed with a real YAML parser — a
 * hand-rolled line scanner mis-parsed job boundaries and could go
 * silently green on style drift; see the PR #20 adverse rounds).
 *
 * 1. Local-action bootstrap order: a `uses: ./.github/actions/...` step
 *    resolves from the job workspace. Before any `actions/checkout` step
 *    the workspace is EMPTY — the runner cannot find the action's
 *    manifest, and any mechanism that materialized it would execute
 *    triggering-ref code before the reviewed default-branch checkout.
 *    PR #20's first revision shipped exactly that (resolve-default-branch
 *    as the FIRST step, pre-checkout) — caught in independent review.
 *    This checks ORDER within each job, which is a proxy for — not proof
 *    of — the reviewed-code trust; the checkout ref itself is not
 *    inspected here.
 *
 * 2. Drift identity: the resolver logic exists as one post-checkout
 *    action plus two necessarily-inline pre-checkout copies (and the
 *    bun-pin guard block in four workflows). Nothing but tests keep
 *    those copies identical, and a drifted resolver in the scheduled
 *    collectors means checking out the wrong branch — so the command
 *    content (comments stripped) is asserted identical everywhere.
 */

const repoRoot = path.join(import.meta.dir, "..", "..");
const workflowsDir = path.join(repoRoot, ".github", "workflows");
const actionsDir = path.join(repoRoot, ".github", "actions");

interface Step {
  uses?: string | { [k: string]: unknown };
  run?: string;
}

async function workflows(): Promise<{ file: string; doc: any }[]> {
  const files = [...new Bun.Glob("*.yml").scanSync({ cwd: workflowsDir })];
  expect(files.length).toBeGreaterThanOrEqual(5); // sanity: the scan sees the real set
  const out: { file: string; doc: any }[] = [];
  for (const file of files) out.push({ file, doc: parse(await Bun.file(path.join(workflowsDir, file)).text()) });
  return out;
}

/** Non-comment, non-blank lines of a run block, trimmed — the executable content. */
function commandLines(run: string): string[] {
  return run
    .split("\n")
    .map((l) => (l.trim().startsWith("#") ? "" : l.trim()))
    .filter((l) => l.length > 0);
}

describe("local-action bootstrap order", () => {
  test("every local action use comes after a checkout step in its job (all workflows, globbed)", async () => {
    const violations: string[] = [];
    let localUsesSeen = 0;
    for (const { file, doc } of await workflows()) {
      const jobs = doc?.jobs;
      expect(jobs && typeof jobs === "object", `${file}: no jobs parsed — the scanner went blind`).toBeTruthy();
      for (const [jobName, job] of Object.entries<any>(jobs)) {
        const steps: Step[] = job?.steps ?? [];
        expect(steps.length, `${file} job '${jobName}': no steps parsed — the scanner went blind`).toBeGreaterThan(0);
        const firstCheckout = steps.findIndex((s) => typeof s.uses === "string" && s.uses.startsWith("actions/checkout"));
        steps.forEach((s, i) => {
          if (typeof s.uses === "string" && s.uses.startsWith("./")) {
            localUsesSeen++;
            if (firstCheckout === -1) {
              violations.push(`${file} job '${jobName}': local action at step ${i + 1} but the job has NO checkout step`);
            } else if (i < firstCheckout) {
              violations.push(
                `${file} job '${jobName}': local action at step ${i + 1}, before checkout at step ${firstCheckout + 1} — the workspace is empty pre-checkout, and materializing triggering-ref code there would run unreviewed code`,
              );
            }
          }
        });
      }
    }
    // Sanity floor: the suite must actually be looking at local uses
    // (data-pr-guard.yml guarantees at least one post-checkout use).
    expect(localUsesSeen).toBeGreaterThanOrEqual(1);
    expect(violations).toEqual([]);
  });

  test("the parser-based check detects the PR #20 defect shape (reproduction)", () => {
    const buggy = parse(`
jobs:
  collect:
    steps:
      - uses: ./.github/actions/resolve-default-branch
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
      - name: later
        uses: ./.github/actions/run-token
  second-job:
    steps:
      - uses: ./.github/actions/run-token
`) as any;
    const flagged: string[] = [];
    for (const [jobName, job] of Object.entries<any>(buggy.jobs)) {
      const steps: Step[] = job.steps;
      const firstCheckout = steps.findIndex((s) => typeof s.uses === "string" && s.uses.startsWith("actions/checkout"));
      steps.forEach((s, i) => {
        if (typeof s.uses === "string" && s.uses.startsWith("./") && (firstCheckout === -1 || i < firstCheckout)) {
          flagged.push(`${jobName}:${i + 1}`);
        }
      });
    }
    expect(flagged).toEqual(["collect:1", "second-job:1"]); // pre-checkout use AND a no-checkout job are both caught
  });
});

describe("drift identity of duplicated blocks", () => {
  test("resolver: the action's run block and both inline copies execute identical commands", async () => {
    const actionDoc = parse(await Bun.file(path.join(actionsDir, "resolve-default-branch", "action.yml")).text()) as any;
    const actionRun: string = actionDoc.runs.steps[0].run;
    const expected = commandLines(actionRun);
    expect(expected.length).toBeGreaterThan(3); // sanity: we actually extracted commands
    for (const wf of ["collect-data.yml", "collect-data-heartbeat.yml"]) {
      const doc = parse(await Bun.file(path.join(workflowsDir, wf)).text()) as any;
      const allSteps: Step[] = Object.values<any>(doc.jobs).flatMap((j) => j.steps ?? []);
      const resolveStep = allSteps.find((s) => typeof s.run === "string" && s.run.includes("DEFAULT_BRANCH=$branch"));
      expect(resolveStep, `${wf}: inline resolver step not found by content`).toBeTruthy();
      expect(commandLines(resolveStep!.run!)).toEqual(expected); // comment-stripped identity
    }
  });

  test("bun-pin guard: all four workflow copies execute identical commands", async () => {
    const seen = new Map<string, string[]>();
    for (const { file, doc } of await workflows()) {
      for (const [jobName, job] of Object.entries<any>(doc?.jobs ?? {})) {
        for (const s of (job?.steps ?? []) as Step[]) {
          if (typeof s.run === "string" && s.run.includes("BUN_VERSION=$v")) {
            const cmds = commandLines(s.run).join("\n");
            seen.set(cmds, [...(seen.get(cmds) ?? []), `${file}:${jobName}`]);
          }
        }
      }
    }
    expect(seen.size, "the bun-pin block drifted across workflows").toBe(1);
    expect([...seen.values()][0]!.length, "expected the bun-pin block in four workflows").toBe(4);
  });
});
