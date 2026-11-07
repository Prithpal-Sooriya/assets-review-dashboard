/**
 * Disk-backed store for the collector: manifest, per-month partitions,
 * per-repo walk state, and a best-effort single-writer lock.
 * All writes are atomic (tmp file + rename) so a crash can never leave a
 * half-written partition or manifest.
 */
import { mkdir, readdir, rename, rmdir, unlink, writeFile, stat, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { Manifest, RawPartition, WalkState } from "./types";
import { repoSlug, partitionKey } from "./config";
import type { Store } from "./collect";

const LOCK_STALE_MS = 2 * 60 * 60 * 1000; // 2h

export function resolveDataDir(cliValue: string | undefined): string {
  return cliValue ?? path.join(import.meta.dir, "..", "..", "data");
}

export class DiskStore implements Store {
  private readonly rawDir: string;
  private readonly inprogressDir: string;
  private readonly lockPath: string;
  private lockHeld = false;

  constructor(private readonly dataDir: string) {
    this.rawDir = path.join(dataDir, "raw");
    this.inprogressDir = path.join(this.rawDir, ".inprogress");
    this.lockPath = path.join(this.rawDir, ".lock");
  }

  private partitionPath(repo: string, month: string): string {
    return path.join(this.rawDir, repoSlug(repo), `${month}.json`);
  }

  private async atomicWrite(file: string, content: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, file);
  }

  async readManifest(): Promise<Manifest | null> {
    const file = path.join(this.rawDir, "manifest.json");
    if (!existsSync(file)) return null;
    return JSON.parse(await Bun.file(file).text()) as Manifest;
  }

  async writeManifest(manifest: Manifest): Promise<void> {
    await this.atomicWrite(
      path.join(this.rawDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }

  async writePartition(partition: RawPartition): Promise<void> {
    await this.atomicWrite(
      this.partitionPath(partition.repo, partition.month),
      `${JSON.stringify(partition, null, 2)}\n`,
    );
  }

  async readWalkState(repo: string): Promise<WalkState | null> {
    const file = path.join(this.inprogressDir, `${repoSlug(repo)}.json`);
    if (!existsSync(file)) return null;
    return JSON.parse(await Bun.file(file).text()) as WalkState;
  }

  async writeWalkState(state: WalkState): Promise<void> {
    await this.atomicWrite(
      path.join(this.inprogressDir, `${repoSlug(state.repo)}.json`),
      `${JSON.stringify(state, null, 2)}\n`,
    );
  }

  async clearWalkState(repo: string): Promise<void> {
    const file = path.join(this.inprogressDir, `${repoSlug(repo)}.json`);
    if (existsSync(file)) await unlink(file).catch(() => {});
  }

  async acquireLock(): Promise<() => void> {
    await mkdir(this.rawDir, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      const handle = await open(this.lockPath, "wx").catch(() => null);
      if (handle) {
        await handle.write(`${process.pid} ${new Date().toISOString()}`);
        await handle.close();
        this.lockHeld = true;
        return () => {
          if (this.lockHeld) unlink(this.lockPath).catch(() => {});
          this.lockHeld = false;
        };
      }
      // Lock exists — stale?
      const info = await stat(this.lockPath);
      if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await unlink(this.lockPath).catch(() => {});
        continue;
      }
      const content = (await Bun.file(this.lockPath).text()).split(" ")[0];
      const pid = Number(content);
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0); // throws if not running
          throw new Error(
            `another collector run appears active (lock pid ${pid}); refusing to run concurrently`,
          );
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") {
            await unlink(this.lockPath).catch(() => {});
            continue; // dead process — stale lock
          }
          throw e;
        }
      }
    }
    throw new Error(`could not acquire collector lock at ${this.lockPath}`);
  }
}

/**
 * Prune out-of-window partitions: delete partition files and manifest
 * entries whose month falls outside `keepMonths` (or whose repo is not in
 * `repos`). Bounds the data branch's growth under the rolling display
 * window — without this, closed months accumulate forever. Walk-state files
 * are left alone (they only reference open/wanted months and are removed by
 * the engine when walks complete). Returns the pruned partition keys.
 */
export async function prunePartitions(
  dataDir: string,
  keepMonths: ReadonlySet<string>,
  repos: readonly string[],
): Promise<string[]> {
  const store = new DiskStore(dataDir);
  const repoSet = new Set(repos);
  const rawDir = path.join(dataDir, "raw");
  const pruned = new Set<string>();

  // Partition files: data/raw/<slug>/<YYYY-MM>.json outside the window.
  // Iterate ALL repo directories — a repo dropped from config must not keep
  // stale files either (its directory, if then empty, is removed below).
  for (const entry of await readdir(rawDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(rawDir, entry.name);
    const repo = [...repoSet].find((r) => repoSlug(r) === entry.name);
    for (const name of await readdir(dir)) {
      const month = name.match(/^(\d{4}-\d{2})\.json$/)?.[1];
      if (!month) continue;
      // Keep only in-window months of CONFIGURED repos; a de-configured
      // repo keeps nothing.
      if (repo && keepMonths.has(month)) continue;
      await unlink(path.join(dir, name)).catch(() => {});
      if (repo) pruned.add(partitionKey(repo, month));
    }
  }

  // Manifest entries: drop out-of-window months and unknown repos.
  const manifest = await store.readManifest();
  if (manifest) {
    const kept: typeof manifest.partitions = {};
    for (const [key, st] of Object.entries(manifest.partitions)) {
      const parts = key.split("|");
      const repo = parts[0]!;
      const month = parts[1]!;
      if (repoSet.has(repo) && keepMonths.has(month)) kept[key] = st;
      else pruned.add(key);
    }
    await store.writeManifest({ ...manifest, partitions: kept });
  }

  // Remove empty repo directories (a repo removed from config leaves none behind).
  const slugToRepo = new Map(repos.map((r) => [repoSlug(r), r]));
  for (const entry of await readdir(rawDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (slugToRepo.has(entry.name)) continue;
    const dir = path.join(rawDir, entry.name);
    if ((await readdir(dir)).length === 0) await rmdir(dir).catch(() => {});
  }
  return [...pruned].sort();
}
