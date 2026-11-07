/**
 * Heartbeat CLI (run by collect-data-heartbeat.yml on the reviewed default
 * branch). Reads the published dashboard from the local checkout, fetches
 * the data-branch checkpoint via gh, applies the tested decision core
 * (scripts/lib/heartbeat.ts), and prints one machine line:
 *
 *   noop <reason>            -> nothing to do (exit 0)
 *   dispatch <YYYY-MM>       -> re-dispatch collect-data from that month (exit 0)
 *
 * Malformed/unknown checkpoint shapes or a stale dashboard exit 1 (red) —
 * schema drift must be loud, never a silent green no-op.
 */

import { parseCheckpoint, resumeDecision, staleness } from "./lib/heartbeat";
import { $ } from "bun";

function repoSlugEnv(): string {
  const repo = process.env.REPO;
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("REPO env must be owner/name");
  }
  return repo;
}

async function fetchJson(path: string, ref: string): Promise<unknown | null> {
  // contents API returns { content: base64 } for files; 404 -> null.
  const proc = await $`gh api repos/${repoSlugEnv()}/contents/${path}?ref=${ref}`.quiet();
  if (proc.exitCode !== 0) return null;
  const meta = JSON.parse(proc.stdout.toString()) as { content?: string; encoding?: string };
  if (meta.encoding !== "base64" || typeof meta.content !== "string") {
    throw new Error(`unexpected contents-API response for ${path}@${ref}`);
  }
  return JSON.parse(Buffer.from(meta.content, "base64").toString("utf8"));
}

const DATA_BRANCH = process.env.DATA_BRANCH ?? "data/auto-refresh";

// Freshness canary: the one red that is never expected.
// Read the dashboard from the DEFAULT-BRANCH CHECKOUT (this CLI runs inside
// the checked-out repo), NOT the contents API: that API returns base64 only
// for files <= 1MB and serves content:"" beyond — the committed dashboard
// grows past 1MB as coverage completes, which would break the canary exactly
// when the pipeline first reaches full coverage. A local read has no size
// cliff. The tiny .last-run.json checkpoint below stays on the contents API
// (it is kilobytes and lives on the data branch, which is not checked out).
let dashboard: unknown;
try {
  dashboard = JSON.parse(await Bun.file("data/dashboard.json").text());
} catch {
  console.error("::error::[STALE-DASHBOARD] data/dashboard.json is missing or unparseable on the default branch — the published dashboard was deleted or corrupted; restore it (the data PR should carry it)");
  process.exit(1);
}
const stale = staleness(dashboard as Record<string, unknown>, Date.now());
if (stale !== null) {
  console.error(`::error::[STALE-DASHBOARD] ${stale}`);
  process.exit(1);
}

// Resume decision from the data-branch checkpoint.
const raw = await fetchJson("data/raw/.last-run.json", DATA_BRANCH);
if (raw === null) {
  console.log("noop no checkpoint on " + DATA_BRANCH);
  process.exit(0);
}
const cp = parseCheckpoint(raw);
if (cp === null) {
  console.error("::error::checkpoint schema drift: data/raw/.last-run.json on " + DATA_BRANCH +
    " does not match any known shape (collect.ts writer?). Fix the heartbeat parser or the writer.");
  process.exit(1);
}
const decision = resumeDecision(cp, Date.now());
if (decision.action === "noop") {
  console.log(`noop ${decision.reason}`);
} else {
  console.log(`dispatch ${decision.fromMonth}`);
}
