/**
 * Disk-backed store for the collector: manifest, per-month partitions,
 * per-repo walk state, and a best-effort single-writer lock.
 * All writes are atomic (tmp file + rename) so a crash can never leave a
 * half-written partition or manifest.
 */
import { mkdir, rename, unlink, writeFile, stat, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { Manifest, RawPartition, WalkState } from "./types";
import { repoSlug } from "./config";
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
