/**
 * Aggregation CLI: raw partitions + manifest -> data/dashboard.json
 * (deterministic for a fixed --as-of).
 *
 * Usage:
 *   bun run scripts/aggregate.ts [--as-of 2026-11-07T12:00:00Z]
 *                                [--data-dir data] [--config config/collector.json]
 *                                [--out data/dashboard.json] [--window-months 12]
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { loadConfig, addMonths, assertMonth, monthOf, monthRange, repoSlug } from "./lib/config";
import { aggregate, validateDashboardData } from "./lib/aggregate";
import { resolveDataDir } from "./lib/store";
import type { DashboardData, Manifest, RawPartition } from "./lib/types";

function argValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`--${name} requires a value`);
  return v;
}

async function main(): Promise<number> {
  const dataDir = resolveDataDir(argValue("data-dir"));
  const configPath = argValue("config") ?? "config/collector.json";
  const cfg = await loadConfig(configPath);
  const displayWindowMonths = argValue("window-months")
    ? Number(argValue("window-months"))
    : cfg.displayWindowMonths;
  if (!Number.isInteger(displayWindowMonths) || displayWindowMonths < 1) throw new Error("invalid --window-months");
  const asOf = argValue("as-of") ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(asOf))) throw new Error(`invalid --as-of: ${asOf}`);
  const outPath = argValue("out") ?? path.join(dataDir, "dashboard.json");

  const currentMonth = monthOf(asOf);
  const startMonth = addMonths(currentMonth, -displayWindowMonths);
  assertMonth(startMonth);
  const monthsList = monthRange(startMonth, currentMonth);

  const manifestFile = path.join(dataDir, "raw", "manifest.json");
  const manifest: Manifest = (await Bun.file(manifestFile).exists())
    ? (JSON.parse(await Bun.file(manifestFile).text()) as Manifest)
    : { schemaVersion: 1, partitions: {} };

  const partitions: RawPartition[] = [];
  for (const repo of cfg.repos) {
    for (const m of monthsList) {
      const file = path.join(dataDir, "raw", repoSlug(repo), `${m}.json`);
      if (await Bun.file(file).exists()) {
        partitions.push(JSON.parse(await Bun.file(file).text()) as RawPartition);
      }
    }
  }

  const data: DashboardData = aggregate({
    config: { ...cfg, displayWindowMonths },
    asOf,
    manifest,
    partitions,
  });

  const problems = validateDashboardData(data);
  if (problems.length > 0) {
    console.error(`dashboard validation failed:\n  ${problems.join("\n  ")}`);
    return 1;
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, outPath);

  const covCounts = data.coverage.reduce<Record<string, number>>((acc, c) => {
    acc[c.status] = (acc[c.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `wrote ${outPath}: range ${data.range.start}..${data.range.end}, months rows ${data.months.length}, prs ${data.prs.length}, coverage ${JSON.stringify(covCounts)} (window ${startMonth}..${currentMonth}, partitions loaded ${partitions.length})`,
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`aggregate failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
