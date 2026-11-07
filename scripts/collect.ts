/**
 * Collector CLI.
 *
 * Usage:
 *   bun run scripts/collect.ts --from 2025-11 [--to 2026-11]
 *                              [--repos MetaMask/core,MetaMask/metamask-mobile]
 *                              [--data-dir data] [--config config/collector.json]
 *                              [--as-of 2026-11-07T12:00:00Z]
 *
 * Walks each repo's PRs ordered by updated_at down to the start of
 * --from's month and closes repo-month partitions along the way. Resumable:
 * re-running the same command continues from the persisted walk state and
 * skips months already month-end complete. --as-of fixes the run cutoff
 * (deterministic current month + honest partition cutoffs); default now.
 *
 * Exit codes: 0 = all target partitions complete; 3 = stopped at the rate
 * budget reserve (progress durably checkpointed under data/raw/.inprogress/,
 * manifest marks pending months — re-run the same command to resume; the
 * workflow auto-continues); 1 = usage/validation error.
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { loadConfig, assertMonth, monthRange, partitionKey } from "./lib/config";
import { createGhCliTransport } from "./lib/gh";
import { DiskStore, resolveDataDir } from "./lib/store";
import { collectPartitions } from "./lib/collect";

function argValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`--${name} requires a value`);
  return v;
}

async function main(): Promise<number> {
  const fromMonth = argValue("from");
  if (!fromMonth) {
    console.error("missing --from YYYY-MM");
    return 1;
  }
  assertMonth(fromMonth, "from");
  const toMonth = argValue("to");
  if (toMonth) assertMonth(toMonth, "to");
  const repos = argValue("repos")?.split(",").map((s) => s.trim()).filter(Boolean);
  const dataDir = resolveDataDir(argValue("data-dir"));
  const configPath = argValue("config") ?? "config/collector.json";
  const asOf = argValue("as-of");
  if (asOf && !Number.isFinite(Date.parse(asOf))) throw new Error(`invalid --as-of: ${asOf}`);
  const now = asOf ? () => new Date(asOf) : () => new Date();
  const effectiveTo = toMonth ?? now().toISOString().slice(0, 7);

  const cfg = await loadConfig(configPath);
  const log = (msg: string) => console.log(msg);
  const transport = createGhCliTransport({ ...cfg.request, log });
  const store = new DiskStore(dataDir);

  const started = Date.now();
  const rate0 = await transport.getRate();
  log(`rate budget at start: ${rate0.remaining}/${rate0.limit} (resets epoch ${rate0.resetEpoch})`);

  const report = await collectPartitions(cfg, { transport, store, now, log }, {
    fromMonth,
    toMonth,
    repos,
  });

  for (const r of report.results) {
    log(
      `[report] ${r.repo}: wanted ${r.wantedMonths.length}, closed ${r.closedMonths.length} (${r.closedMonths.join(", ") || "-"}), fetched ${r.prsFetched} PRs, ${r.reviewRequests} review requests, stopped=${r.stopped}`,
    );
  }
  if (report.pending.length > 0) {
    log(`[report] pending partitions (${report.pending.length}): ${report.pending.slice(0, 40).join(" ")}${report.pending.length > 40 ? " …" : ""}`);
    log("[report] re-run the same command later to resume (rate budget resets hourly).");
  } else {
    const endMonth = toMonth ?? new Date().toISOString().slice(0, 7);
    const expected = (repos ?? cfg.repos).flatMap((repo) =>
      monthRange(fromMonth, endMonth).map((m) => partitionKey(repo, m)),
    );
    log(`[report] all ${expected.length} target partitions complete.`);
  }
  const rate1 = await transport.getRate();
  log(`rate budget at end: ${rate1.remaining}/${rate1.limit}; elapsed ${Math.round((Date.now() - started) / 1000)}s`);

  // Machine-readable run record (committed with checkpoints; drives the
  // workflow's bounded auto-continuation). Atomic (tmp+rename): a crash
  // between truncate and write must never leave a truncated checkpoint for
  // the heartbeat to choke on.
  const writeLastRun = async (rec: Record<string, unknown>) => {
    await mkdir(path.join(dataDir, "raw"), { recursive: true });
    const file = path.join(dataDir, "raw", ".last-run.json");
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(rec, null, 2)}\n`, "utf8");
    await rename(tmp, file);
  };
  await writeLastRun({
    ranAt: asOf ?? new Date().toISOString(),
    from: fromMonth,
    to: effectiveTo,
    stopped: report.stopped,
    pending: report.pending,
    rateRemaining: rate1.remaining,
    resetEpoch: rate1.resetEpoch,
  });
  return report.pending.length > 0 ? 3 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch(async (err) => {
    console.error(`collect failed: ${err instanceof Error ? err.message : String(err)}`);
    // The run record must reflect aborted runs too: a stale "pending: []"
    // from a previous successful run would tell the heartbeat there is
    // nothing to resume and silently strand the real work.
    try {
      const dataDir = resolveDataDir(argValue("data-dir"));
      const store = new DiskStore(dataDir);
      const manifest = (await store.readManifest()) ?? { schemaVersion: 1, partitions: {} };
      const endMonth = argValue("to") ?? new Date().toISOString().slice(0, 7);
      const fromMonth = argValue("from");
      const pending: string[] = [];
      if (fromMonth) {
        const reposArg = argValue("repos")?.split(",").map((s) => s.trim()).filter(Boolean);
        const cfg = await loadConfig(argValue("config") ?? "config/collector.json");
        for (const repo of reposArg ?? cfg.repos) {
          for (const m of monthRange(fromMonth, endMonth)) {
            if (manifest.partitions[partitionKey(repo, m)]?.status !== "complete") pending.push(partitionKey(repo, m));
          }
        }
      }
      const rawDir = path.join(dataDir, "raw");
      await mkdir(rawDir, { recursive: true });
      const file = path.join(rawDir, ".last-run.json");
      const tmp = `${file}.tmp`;
      await writeFile(
        tmp,
        `${JSON.stringify(
          {
            ranAt: new Date().toISOString(),
            from: fromMonth ?? "unknown",
            to: endMonth,
            stopped: "error",
            pending,
            error: err instanceof Error ? err.message : String(err),
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await rename(tmp, file);
    } catch {
      // best-effort: the original error is what matters
    }
    process.exit(1);
  });
