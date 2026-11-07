import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { prunePartitions } from "../../scripts/lib/store";
import type { Manifest } from "../../scripts/lib/types";

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await Bun.$`rm -rf ${d}`.quiet();
  dirs = [];
});

async function seed(): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "prune-"));
  dirs.push(dataDir);
  const raw = path.join(dataDir, "raw");
  await mkdir(path.join(raw, "core"), { recursive: true });
  await mkdir(path.join(raw, "old-repo"), { recursive: true });
  await mkdir(path.join(raw, ".inprogress"), { recursive: true });
  await writeFile(path.join(raw, "core", "2026-07.json"), "{}");
  await writeFile(path.join(raw, "core", "2026-08.json"), "{}");
  await writeFile(path.join(raw, "core", "2026-09.json"), "{}");
  await writeFile(path.join(raw, "old-repo", "2026-08.json"), "{}");
  await writeFile(path.join(raw, ".inprogress", "core.json"), "{}"); // walk state: never pruned
  const manifest: Manifest = {
    schemaVersion: 1,
    partitions: {
      "MetaMask/core|2026-07": { status: "pending" },
      "MetaMask/core|2026-08": { status: "complete", completeness: "monthEnd", collectedAt: "2026-09-01T00:00:00Z", prCount: 1 },
      "MetaMask/core|2026-09": { status: "complete", completeness: "asOfCutoff", collectedAt: "2026-09-10T00:00:00Z", prCount: 1 },
      "MetaMask/old-repo|2026-08": { status: "complete", completeness: "monthEnd", collectedAt: "2026-09-01T00:00:00Z", prCount: 1 },
    },
  };
  await writeFile(path.join(raw, "manifest.json"), JSON.stringify(manifest));
  return dataDir;
}

describe("prunePartitions", () => {
  test("deletes out-of-window partitions/files and manifest entries, keeps window", async () => {
    const dataDir = await seed();
    const pruned = await prunePartitions(dataDir, new Set(["2026-08", "2026-09"]), ["MetaMask/core"]);

    expect(pruned).toEqual(["MetaMask/core|2026-07", "MetaMask/old-repo|2026-08"]);

    const coreFiles = (await readdir(path.join(dataDir, "raw", "core"))).sort();
    expect(coreFiles).toEqual(["2026-08.json", "2026-09.json"]); // 2026-07 file deleted

    const manifest: Manifest = JSON.parse(await Bun.file(path.join(dataDir, "raw", "manifest.json")).text());
    expect(Object.keys(manifest.partitions).sort()).toEqual(["MetaMask/core|2026-08", "MetaMask/core|2026-09"]);

    // Walk state untouched.
    expect(existsSync(path.join(dataDir, "raw", ".inprogress", "core.json"))).toBe(true);
  });

  test("removes empty directories left by de-configured repos", async () => {
    const dataDir = await seed();
    await prunePartitions(dataDir, new Set(["2026-08", "2026-09"]), ["MetaMask/core"]);
    // old-repo's only file was pruned above; its (now empty) directory goes too.
    expect(existsSync(path.join(dataDir, "raw", "old-repo"))).toBe(false);
    // core still has in-window files, so it stays.
    expect(existsSync(path.join(dataDir, "raw", "core"))).toBe(true);
  });

  test("no-op when everything is in-window", async () => {
    const dataDir = await seed();
    const pruned = await prunePartitions(
      dataDir,
      new Set(["2026-07", "2026-08", "2026-09"]),
      ["MetaMask/core", "MetaMask/old-repo"],
    );
    expect(pruned).toEqual([]);
  });
});

import { validateConfig } from "../../scripts/lib/config";
import configJson from "../../config/collector.json";

describe("validateConfig request block", () => {
  test("accepts the real config", () => {
    expect(() => validateConfig(configJson)).not.toThrow();
  });

  test("a typo'd request key fails loudly at startup, not mid-walk", () => {
    const bad = { ...(configJson as object), request: { perPage: 100, maxRetries: 3, retryBaseDelayMs: 2000, minDelayMs: 150, rateCheckInterval: 15, rateReserve: 250, maxRetires: 3 } } as unknown;
    expect(() => validateConfig(bad)).toThrow(/unknown key 'maxRetires'/);
  });

  test("non-integer pacing values are rejected", () => {
    const bad = { ...(configJson as object), request: { perPage: 100, maxRetries: "3", retryBaseDelayMs: 2000, minDelayMs: 150, rateCheckInterval: 15, rateReserve: 250 } } as unknown;
    expect(() => validateConfig(bad)).toThrow(/request\.maxRetries must be a positive integer/);
  });
});
