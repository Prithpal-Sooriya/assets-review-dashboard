import { describe, expect, test } from "bun:test";
import path from "node:path";

/**
 * Local-action bootstrap order.
 *
 * A `uses: ./.github/actions/...` step resolves from the job workspace.
 * Before any `actions/checkout` step the workspace is EMPTY — the runner
 * cannot find the action's manifest ("Can't find 'action.yml'"), and any
 * mechanism that materialized it would be executing triggering-ref code
 * before the reviewed default-branch checkout, breaking the
 * reviewed-default-code trust the workflows are built on. PR #20's first
 * revision shipped exactly that (resolve-default-branch as the FIRST
 * step, pre-checkout) — caught in independent review, not by any local
 * gate. This regression makes the order structural: in every collector
 * workflow, any local action use must come after a checkout step in the
 * same job.
 *
 * Line-based on purpose: no YAML parser dependency; the workflows use
 * consistent 4-space job keys under `jobs:` and 6-space step items.
 */

const workflowDir = path.join(import.meta.dir, "..", "..", ".github", "workflows");
const WORKFLOWS = [
  "collect-data.yml",
  "collect-data-heartbeat.yml",
  "ci-collector.yml",
  "data-pr-guard.yml",
];

interface JobStepOrder {
  job: string;
  firstCheckoutIndex: number | null;
  localUseIndexes: number[];
}

function scanStepOrder(text: string): JobStepOrder[] {
  const jobs = new Map<string, JobStepOrder>();
  let currentJob: string | null = null;
  let stepIndex = 0;
  let inJobs = false;
  for (const rawLine of text.split("\n")) {
    if (/^jobs:/.test(rawLine)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    const jobMatch = /^ {4}([A-Za-z0-9_-]+):/.exec(rawLine);
    if (jobMatch) {
      currentJob = jobMatch[1]!;
      if (!jobs.has(currentJob)) jobs.set(currentJob, { job: currentJob, firstCheckoutIndex: null, localUseIndexes: [] });
      stepIndex = 0;
      continue;
    }
    const stepMatch = /^ {6}-\s+(?:name:\s.*|uses:\s.*|run:\s.*|env:\s.*|with:\s.*|shell:\s.*|id:\s.*)$/.exec(rawLine);
    if (stepMatch && currentJob) {
      // `- uses:` / `- name:` etc. start a new step; continuation keys of the
      // same item (8-space `uses:` under a `- name:`) belong to the same step.
      const entry = jobs.get(currentJob)!;
      if (/^ {6}-\s+name:/.test(rawLine) || /^ {6}-\s+uses:/.test(rawLine) || /^ {6}-\s+run:/.test(rawLine)) {
        stepIndex++;
      }
      if (/^ {6}-\s+uses:\s*\.\/|uses:\s*\.\/\.github\//.test(rawLine)) {
        entry.localUseIndexes.push(stepIndex);
      }
      if (/uses:\s*actions\/checkout@/.test(rawLine) && entry.firstCheckoutIndex === null) {
        entry.firstCheckoutIndex = stepIndex;
      }
      continue;
    }
    // 8-space `uses:` continuation under a `- name:` item of the current step
    if (currentJob && /^ {8}uses:\s*\.\/\.github\//.test(rawLine)) {
      jobs.get(currentJob)!.localUseIndexes.push(stepIndex);
    }
    if (currentJob && /^ {8}uses:\s*actions\/checkout@/.test(rawLine)) {
      const entry = jobs.get(currentJob)!;
      if (entry.firstCheckoutIndex === null) entry.firstCheckoutIndex = stepIndex;
    }
  }
  return [...jobs.values()];
}

describe("local-action bootstrap order", () => {
  for (const wf of WORKFLOWS) {
    test(`${wf}: every local action use comes after a checkout step in its job`, async () => {
      const text = await Bun.file(path.join(workflowDir, wf)).text();
      const violations: string[] = [];
      for (const job of scanStepOrder(text)) {
        for (const useIdx of job.localUseIndexes) {
          if (job.firstCheckoutIndex === null) {
            violations.push(`${wf} job '${job.job}': local action used at step ${useIdx} but the job has NO checkout step`);
          } else if (useIdx < job.firstCheckoutIndex) {
            violations.push(
              `${wf} job '${job.job}': local action used at step ${useIdx}, before checkout at step ${job.firstCheckoutIndex} — the workspace is empty pre-checkout, and materializing triggering-ref code there would break the reviewed-default-code trust`,
            );
          }
        }
      }
      expect(violations).toEqual([]);
    });
  }

  test("the scanner itself detects the PR #20 defect shape (reproduction)", () => {
    // Reproduces the bootstrap-order bug that shipped in PR #20's first
    // revision: a local action as the FIRST step, before checkout.
    const buggy = [
      "jobs:",
      "  collect:",
      "    steps:",
      "      - uses: ./.github/actions/resolve-default-branch",
      "      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
      "      - name: later",
      "        uses: ./.github/actions/run-token",
    ].join("\n");
    const job = scanStepOrder(buggy)[0]!;
    expect(job.localUseIndexes).toEqual([1, 3]);
    expect(job.firstCheckoutIndex).toBe(2);
    const badUses = job.localUseIndexes.filter((i) => job.firstCheckoutIndex === null || i < job.firstCheckoutIndex);
    expect(badUses).toEqual([1]); // the pre-checkout use is the violation; the post-checkout one is fine
  });
});
