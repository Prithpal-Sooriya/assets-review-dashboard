/** Collection engine tests: fake transport + in-memory store. */
import { describe, expect, test } from "bun:test";
import { collectPartitions, type CollectDeps, type Store } from "../../scripts/lib/collect";
import type { RateInfo, RestTransport } from "../../scripts/lib/gh";
import type { CollectorConfig, Manifest, RawPartition, WalkState } from "../../scripts/lib/types";
import { testConfig } from "./fixtures";

interface RestPullShape {
  number: number;
  title: string;
  html_url: string;
  state: string;
  draft?: boolean;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  merged_at?: string | null;
  user: { login: string } | null;
  labels?: { name: string }[];
}

interface RestReviewShape {
  id: number;
  state: string;
  submitted_at: string | null;
  user: { login: string } | null;
}

class MemoryStore implements Store {
  manifest: Manifest | null = null;
  partitions: RawPartition[] = [];
  walkStates = new Map<string, WalkState>();
  lockCount = 0;

  async readManifest() {
    return this.manifest;
  }
  async writeManifest(m: Manifest) {
    this.manifest = JSON.parse(JSON.stringify(m));
  }
  async writePartition(p: RawPartition) {
    this.partitions.push(JSON.parse(JSON.stringify(p)));
  }
  async readWalkState(repo: string) {
    return this.walkStates.get(repo) ?? null;
  }
  async writeWalkState(s: WalkState) {
    this.walkStates.set(s.repo, JSON.parse(JSON.stringify(s)));
  }
  async clearWalkState(repo: string) {
    this.walkStates.delete(repo);
  }
  async acquireLock() {
    this.lockCount++;
    if (this.lockCount > 1) throw new Error("concurrent run refused");
    return () => {
      this.lockCount--;
    };
  }
}

class FakeTransport implements RestTransport {
  pullsPages = new Map<string, RestPullShape[]>(); // "repo|page"
  reviews = new Map<string, RestReviewShape[]>(); // "repo#number"
  calls: string[] = [];
  reviewCalls = new Map<string, number>();
  rate: RateInfo = { remaining: 5000, limit: 5000, resetEpoch: 0 };
  /** When set, getRate() reports a low budget once this many calls happened. */
  exhaustAfter = Infinity;

  async getJson(path: string): Promise<unknown> {
    this.calls.push(path);
    const pullsMatch = path.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\?.*page=(\d+)$/);
    if (pullsMatch) {
      const key = `${pullsMatch[1]}|${pullsMatch[2]}`;
      return this.pullsPages.get(key) ?? [];
    }
    const reviewsMatch = path.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews/);
    if (reviewsMatch) {
      const key = `${reviewsMatch[1]}#${reviewsMatch[2]}`;
      this.reviewCalls.set(key, (this.reviewCalls.get(key) ?? 0) + 1);
      return this.reviews.get(key) ?? [];
    }
    throw new Error(`unexpected path ${path}`);
  }

  async getRate(): Promise<RateInfo> {
    if (this.calls.length > this.exhaustAfter) this.rate = { ...this.rate, remaining: 10 };
    return this.rate;
  }
}

function pull(n: number, updatedAt: string, login = "carol", merged: string | null = null): RestPullShape {
  return {
    number: n,
    title: `PR ${n}`,
    html_url: `https://github.com/x/pull/${n}`,
    state: merged ? "closed" : "open",
    created_at: "2025-06-01T00:00:00Z",
    updated_at: updatedAt,
    merged_at: merged,
    user: { login },
    labels: [],
  };
}

function rev(id: number, login: string, state: string, submittedAt: string | null): RestReviewShape {
  return { id, state, submitted_at: submittedAt, user: { login } };
}

const NOW = () => new Date("2026-03-15T12:00:00Z");

function depsFor(transport: FakeTransport, store: MemoryStore): CollectDeps {
  return { transport, store, now: NOW, log: () => {} };
}

/** Repo with PRs spanning 2026-01..2026-03 plus one pre-floor PR. */
function seedRepo(repo: string, t: FakeTransport): void {
  // Page 1 (desc by updated_at): March + late Feb + pre-floor sentinel last
  t.pullsPages.set(`${repo}|1`, [
    pull(31, "2026-03-14T10:00:00Z", "ext1"),
    pull(30, "2026-03-02T09:00:00Z", "ext2", "2026-03-02T10:00:00Z"),
    pull(21, "2026-02-28T23:59:59Z", "ext3"),
    pull(20, "2026-02-01T00:00:00Z", "ext4", "2026-02-01T01:00:00Z"), // exactly at Feb start
    pull(11, "2026-01-31T23:59:59Z", "ext5"),
    pull(10, "2026-01-05T00:00:00Z", "ext6", "2026-01-06T00:00:00Z"),
    pull(9, "2025-12-30T00:00:00Z", "ext7"), // below floor -> stops walk
  ]);
  t.pullsPages.set(`${repo}|2`, []);
  // Reviews: roster members only survive the filter; non-roster dropped.
  t.reviews.set(`${repo}#31`, [rev(1, "alice", "COMMENTED", "2026-03-14T11:00:00Z"), rev(2, "stranger", "APPROVED", "2026-03-14T12:00:00Z")]);
  t.reviews.set(`${repo}#30`, [rev(3, "BOB", "APPROVED", "2026-03-01T08:00:00Z")]); // case-insensitive roster
  t.reviews.set(`${repo}#21`, []);
  t.reviews.set(`${repo}#20`, [rev(4, "alice", "PENDING", null)]);
  t.reviews.set(`${repo}#11`, [rev(5, "excluded1", "APPROVED", "2026-01-30T00:00:00Z")]);
  t.reviews.set(`${repo}#10`, []);
  t.reviews.set(`${repo}#9`, []); // pre-floor: must never be fetched
}

describe("collectPartitions", () => {
  test("walk buckets PRs by updated_at month, stops at floor, closes partitions", async () => {
    const t = new FakeTransport();
    const store = new MemoryStore();
    seedRepo("MetaMask/core", t);
    const cfg: CollectorConfig = { ...testConfig, repos: ["MetaMask/core"] };

    const report = await collectPartitions(cfg, depsFor(t, store), { fromMonth: "2026-01" });

    expect(report.stopped).toBe("done");
    expect(report.pending).toEqual([]);
    const byMonth = new Map(store.partitions.map((p) => [p.month, p]));
    expect([...byMonth.keys()].sort()).toEqual(["2026-01", "2026-02", "2026-03"]);

    expect(byMonth.get("2026-01")?.prs.map((p) => p.number)).toEqual([10, 11]);
    expect(byMonth.get("2026-01")?.completeness).toBe("monthEnd");
    expect(byMonth.get("2026-02")?.prs.map((p) => p.number)).toEqual([20, 21]);
    expect(byMonth.get("2026-03")?.prs.map((p) => p.number)).toEqual([30, 31]);
    expect(byMonth.get("2026-03")?.completeness).toBe("asOfCutoff");

    // pre-floor PR 9 never fetched
    expect(t.reviewCalls.has("MetaMask/core#9")).toBe(false);

    // roster filtering: non-roster reviews dropped, case-insensitive kept
    const p31 = byMonth.get("2026-03")?.prs.find((p) => p.number === 31)!;
    expect(p31.reviews.map((r) => r.authorLogin)).toEqual(["alice"]);
    const p30 = byMonth.get("2026-03")?.prs.find((p) => p.number === 30)!;
    expect(p30.reviews.map((r) => r.authorLogin)).toEqual(["BOB"]);

    // merged state derived from merged_at
    expect(p30.state).toBe("MERGED");
    expect(p31.state).toBe("OPEN");

    // manifest fully complete for target months
    expect(Object.keys(store.manifest!.partitions).sort()).toEqual([
      "MetaMask/core|2026-01",
      "MetaMask/core|2026-02",
      "MetaMask/core|2026-03",
    ]);
    // walk state cleared after completion
    expect(await store.readWalkState("MetaMask/core")).toBeNull();
  });

  test("exhausted repo history closes partitions via empty page", async () => {
    const t = new FakeTransport();
    const store = new MemoryStore();
    // Repo whose entire history is within one month; page 2 empty.
    t.pullsPages.set("MetaMask/core|1", [pull(1, "2026-03-10T00:00:00Z")]);
    t.pullsPages.set("MetaMask/core|2", []);
    t.reviews.set("MetaMask/core#1", []);
    const cfg: CollectorConfig = { ...testConfig, repos: ["MetaMask/core"] };
    const report = await collectPartitions(cfg, depsFor(t, store), { fromMonth: "2026-03" });
    expect(report.stopped).toBe("done");
    expect(store.partitions).toHaveLength(1);
    expect(store.partitions[0]!.month).toBe("2026-03");
    expect(store.partitions[0]!.completeness).toBe("asOfCutoff");
  });

  test("month-end complete months are skipped on re-run (no review fetches)", async () => {
    const t = new FakeTransport();
    const store = new MemoryStore();
    seedRepo("MetaMask/core", t);
    const cfg: CollectorConfig = { ...testConfig, repos: ["MetaMask/core"] };
    await collectPartitions(cfg, depsFor(t, store), { fromMonth: "2026-01" });

    // Second run: only current month (asOfCutoff) is refreshed.
    const t2calls = t.reviewCalls;
    t.reviewCalls = new Map();
    await collectPartitions(cfg, depsFor(t, store), { fromMonth: "2026-01" });
    // Only March PRs refetched
    expect([...t.reviewCalls.keys()].sort()).toEqual(["MetaMask/core#30", "MetaMask/core#31"]);
    expect(t2calls.size).toBeGreaterThanOrEqual(5);
    // January partition not rewritten
    const janWrites = store.partitions.filter((p) => p.month === "2026-01");
    expect(janWrites).toHaveLength(1);
  });

  test("graceful rate stop: open months pending, state persisted, resume works", async () => {
    const t = new FakeTransport();
    const store = new MemoryStore();
    seedRepo("MetaMask/core", t);
    // rateCheckInterval 1 so the fake budget gate fires deterministically.
    const cfg: CollectorConfig = {
      ...testConfig,
      repos: ["MetaMask/core"],
      request: { ...testConfig.request, rateCheckInterval: 1 },
    };

    // Exhaust after 3 transport calls: page 1 + reviews for #31/#30 are
    // fetched, March closes mid-walk (asOfCutoff), then the budget stops at
    // #20's review fetch. Jan+Feb remain open (pending).
    t.exhaustAfter = 3;
    const report1 = await collectPartitions(cfg, depsFor(t, store), { fromMonth: "2026-01" });
    expect(report1.stopped).toBe("rate");
    expect(report1.pending.sort()).toEqual(["MetaMask/core|2026-01", "MetaMask/core|2026-02"]);
    // March partition already closed mid-walk (complete through walk start)
    expect(store.partitions.map((p) => `${p.month}:${p.completeness}:${p.prs.map((x) => x.number)}`)).toEqual([
      "2026-03:asOfCutoff:30,31",
    ]);
    const state = await store.readWalkState("MetaMask/core");
    expect(state).not.toBeNull();
    expect(state!.floorMonth).toBe("2026-01");
    expect(state!.closedMonths).toEqual(["2026-03"]);
    expect(Object.keys(state!.buckets["2026-02"] ?? {})).toEqual(["21"]); // cached, not re-fetched
    expect(state!.buckets["2026-01"]).toEqual({});

    // Resume with restored budget: current month re-opened for refresh,
    // cached PR #21 not re-fetched, remaining months complete.
    t.exhaustAfter = Infinity;
    t.rate = { remaining: 5000, limit: 5000, resetEpoch: 0 };
    const report2 = await collectPartitions(cfg, depsFor(t, store), { fromMonth: "2026-01" });
    expect(report2.stopped).toBe("done");
    expect(report2.pending).toEqual([]);
    expect(t.reviewCalls.get("MetaMask/core#21")).toBe(1); // resume cache hit
    expect(t.reviewCalls.get("MetaMask/core#31")).toBe(2); // March refreshed
    expect(t.reviewCalls.get("MetaMask/core#30")).toBe(2);
    expect(t.reviewCalls.get("MetaMask/core#20")).toBe(1);
    expect(t.reviewCalls.get("MetaMask/core#9")).toBeUndefined(); // pre-floor never fetched
    // Last write per month
    const last = new Map<string, RawPartition>();
    for (const p of store.partitions) last.set(p.month, p);
    expect(last.get("2026-01")?.prs.map((p) => p.number)).toEqual([10, 11]);
    expect(last.get("2026-01")?.completeness).toBe("monthEnd");
    expect(last.get("2026-02")?.prs.map((p) => p.number)).toEqual([20, 21]);
    expect(last.get("2026-03")?.prs.map((p) => p.number)).toEqual([30, 31]);
    expect(last.get("2026-03")?.completeness).toBe("asOfCutoff");
    expect(await store.readWalkState("MetaMask/core")).toBeNull();
  });

  test("multiple repos: budget stop on first repo skips later repos (pending reported)", async () => {
    const t = new FakeTransport();
    const store = new MemoryStore();
    seedRepo("MetaMask/core", t);
    seedRepo("MetaMask/metamask-extension", t);
    const cfg: CollectorConfig = {
      ...testConfig,
      request: { ...testConfig.request, rateCheckInterval: 1 },
    };
    t.exhaustAfter = 2;
    const report = await collectPartitions(cfg, depsFor(t, store), { fromMonth: "2026-01" });
    expect(report.stopped).toBe("rate");
    // extension months reported pending (never touched)
    expect(report.pending.filter((k) => k.startsWith("MetaMask/metamask-extension|")).length).toBe(3);
  });

  test("refuses concurrent runs via store lock", async () => {
    const t = new FakeTransport();
    const store = new MemoryStore();
    const release = await store.acquireLock();
    await expect(
      collectPartitions(testConfig, depsFor(t, store), { fromMonth: "2026-01" }),
    ).rejects.toThrow(/concurrent/i);
    release();
  });

  test("toMonth bounds the target set", async () => {
    const t = new FakeTransport();
    const store = new MemoryStore();
    seedRepo("MetaMask/core", t);
    const cfg: CollectorConfig = { ...testConfig, repos: ["MetaMask/core"] };
    // Collect only February: walk passes through March PRs without fetching reviews.
    const report = await collectPartitions(cfg, depsFor(t, store), { fromMonth: "2026-02", toMonth: "2026-02" });
    expect(report.stopped).toBe("done");
    expect(store.partitions.map((p) => p.month)).toEqual(["2026-02"]);
    expect(t.reviewCalls.has("MetaMask/core#31")).toBe(false); // March PR not fetched
    expect(t.reviewCalls.has("MetaMask/core#20")).toBe(true);
  });
});
