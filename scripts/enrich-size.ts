/**
 * One-time (and re-runnable) backfill of diff size onto raw partitions.
 *
 * The pulls list does not include additions, deletions, or changed files.
 * Partitions collected before the collector started requesting the single-PR
 * payload therefore have no size. This walks PRs that already have a roster
 * review and fills the three fields from GitHub GraphQL, then rewrites only
 * the partition files that changed.
 *
 * Size is the diff GitHub reports at backfill time. For a merged PR that is
 * the merged diff. For an open PR it can still move.
 *
 * Usage (authenticated `gh`, from the repo root):
 *   bun run scripts/enrich-size.ts [--data-dir data] [--batch 50]
 *
 * Already-sized PRs are skipped, so a second run is a no-op.
 */
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { parseDiffSize, type DiffSize } from "./lib/diff-size";
import type { RawPartition, RawPrRecord } from "./lib/types";

function argValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`--${name} requires a value`);
  return v;
}

interface GhPull {
  number: number;
  additions: number;
  deletions: number;
  changedFiles: number;
}

function ghGraphql(query: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", ["api", "graphql", "-f", `query=${query}`], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += String(c);
    });
    child.stderr.on("data", (c) => {
      stderr += String(c);
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr }));
  });
}

async function fetchBatch(owner: string, name: string, numbers: number[]): Promise<Map<number, DiffSize>> {
  const fields = numbers
    .map((n) => `p${n}: pullRequest(number:${n}) { number additions deletions changedFiles }`)
    .join(" ");
  const query = `query { rateLimit { cost remaining resetAt } repository(owner:"${owner}", name:"${name}") { ${fields} } }`;
  const res = await ghGraphql(query);
  let parsed: {
    data?: {
      rateLimit?: { cost: number; remaining: number; resetAt: string };
      repository?: Record<string, GhPull | null>;
    };
    errors?: { message: string }[];
  };
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new Error(`GraphQL response was not JSON (exit ${res.status}): ${res.stderr.slice(0, 400)}`);
  }
  if (!parsed.data?.repository) {
    throw new Error(`GraphQL failed: ${(parsed.errors ?? []).map((e) => e.message).join("; ") || res.stderr.slice(0, 400)}`);
  }
  const out = new Map<number, DiffSize>();
  for (const value of Object.values(parsed.data.repository)) {
    if (!value || typeof value !== "object" || !("number" in value)) continue;
    const size = parseDiffSize(value);
    if (size) out.set(value.number, size);
  }
  const rate = parsed.data.rateLimit;
  if (rate && rate.remaining < 50) {
    const waitMs = Math.max(0, Date.parse(rate.resetAt) - Date.now()) + 2000;
    console.error(`rate limit low (${rate.remaining}); waiting ${Math.round(waitMs / 1000)}s`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return out;
}

function applySizes(prs: RawPrRecord[], sizes: Map<number, DiffSize>): number {
  let updated = 0;
  for (const pr of prs) {
    if (pr.reviews.length === 0) continue;
    if (parseDiffSize(pr)) continue;
    const size = sizes.get(pr.number);
    if (!size) continue;
    pr.additions = size.additions;
    pr.deletions = size.deletions;
    pr.changedFiles = size.changedFiles;
    updated++;
  }
  return updated;
}

async function main(): Promise<number> {
  const dataDir = argValue("data-dir") ?? "data";
  const batch = Number(argValue("batch") ?? "50");
  if (!Number.isInteger(batch) || batch < 1 || batch > 80) throw new Error("invalid --batch");
  const rawDir = path.join(dataDir, "raw");
  const slugs = (await readdir(rawDir)).filter((name) => !name.startsWith("."));

  const needed = new Map<string, Set<number>>();
  const files: string[] = [];
  for (const slug of slugs) {
    const dir = path.join(rawDir, slug);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^\d{4}-\d{2}\.json$/.test(name)) continue;
      const file = path.join(dir, name);
      files.push(file);
      const partition = JSON.parse(await readFile(file, "utf8")) as RawPartition;
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(partition.repo)) {
        throw new Error(`unexpected repo name in ${file}`);
      }
      const set = needed.get(partition.repo) ?? new Set<number>();
      for (const pr of partition.prs) {
        if (pr.reviews.length > 0 && !parseDiffSize(pr)) set.add(pr.number);
      }
      needed.set(partition.repo, set);
    }
  }

  const sizesByRepo = new Map<string, Map<number, DiffSize>>();
  for (const [repo, numbers] of needed) {
    const list = [...numbers].sort((a, b) => a - b);
    console.error(`[${repo}] ${list.length} reviewed PRs missing size`);
    const [owner, name] = repo.split("/");
    const found = new Map<number, DiffSize>();
    for (let i = 0; i < list.length; i += batch) {
      const slice = list.slice(i, i + batch);
      const batchSizes = await fetchBatch(owner!, name!, slice);
      for (const [n, size] of batchSizes) found.set(n, size);
      console.error(`[${repo}] ${Math.min(i + batch, list.length)}/${list.length}`);
    }
    const missing = list.filter((n) => !found.has(n));
    if (missing.length > 0) {
      console.error(`[${repo}] ${missing.length} PRs had no size (deleted or unresolved); left unset`);
    }
    sizesByRepo.set(repo, found);
  }

  let filesWritten = 0;
  let prsUpdated = 0;
  for (const file of files) {
    const partition = JSON.parse(await readFile(file, "utf8")) as RawPartition;
    const sizes = sizesByRepo.get(partition.repo);
    if (!sizes) continue;
    const updated = applySizes(partition.prs, sizes);
    if (updated === 0) continue;
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(partition, null, 2)}\n`, "utf8");
    await rename(tmp, file);
    filesWritten++;
    prsUpdated += updated;
  }
  console.log(`updated ${prsUpdated} PRs across ${filesWritten} partitions`);
  return 0;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
