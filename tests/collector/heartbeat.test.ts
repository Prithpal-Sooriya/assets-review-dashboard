import { describe, expect, test } from "bun:test";
import { parseCheckpoint, resumeDecision, staleness } from "../../scripts/lib/heartbeat";
import type { Checkpoint } from "../../scripts/lib/heartbeat";

const NOW = Date.parse("2026-11-07T15:00:00Z");
const base = (): Checkpoint => ({
  ranAt: "2026-11-07T13:06:51Z",
  from: "2025-11",
  to: "2026-11",
  stopped: "rate",
  pending: ["MetaMask/core|2026-08", "MetaMask/core|2026-07"],
  resetEpoch: Math.floor(NOW / 1000) - 3600, // reset an hour ago
});

describe("parseCheckpoint (strict — drift must be loud)", () => {
  test("accepts a well-formed rate-paused record", () => {
    expect(parseCheckpoint(base())).toEqual(base());
  });

  test("accepts the error-path record shape (no resetEpoch)", () => {
    const cp = { ...base(), stopped: "error" as const, resetEpoch: undefined, error: "gh api 502 after 3 retries" };
    const parsed = parseCheckpoint({ ranAt: cp.ranAt, from: cp.from, to: cp.to, stopped: "error", pending: cp.pending, error: cp.error });
    expect(parsed?.stopped).toBe("error");
    expect(parsed?.resetEpoch).toBeUndefined();
  });

  test("rejects unknown fields (schema change must be acknowledged)", () => {
    expect(parseCheckpoint({ ...base(), newField: 1 })).toBeNull();
  });

  test.each([
    ["missing pending", (c: Checkpoint) => ({ ranAt: c.ranAt, from: c.from, to: c.to, stopped: c.stopped, resetEpoch: c.resetEpoch })],
    ["bad month format", (c: Checkpoint) => ({ ...base(), from: "2025-11-01" })],
    ["out-of-vocabulary stopped", (c: Checkpoint) => ({ ...base(), stopped: "paused" })],
    ["pending not array", (c: Checkpoint) => ({ ...base(), pending: "MetaMask/core|2026-08" })],
    ["resetEpoch not number", (c: Checkpoint) => ({ ...base(), resetEpoch: "123" })],
    ["ranAt not ISO", (c: Checkpoint) => ({ ...base(), ranAt: "yesterday" })],
    ["not an object", () => "nope"],
  ])("rejects: %s", (_name, mutate) => {
    expect(parseCheckpoint(mutate(base()))).toBeNull();
  });
});

describe("resumeDecision", () => {
  test("no pending -> noop", () => {
    const d = resumeDecision({ ...base(), pending: [] }, NOW);
    expect(d.action).toBe("noop");
  });

  test("rate-paused, window reset -> dispatch from checkpoint month", () => {
    const d = resumeDecision(base(), NOW);
    expect(d).toEqual({ action: "dispatch", fromMonth: "2025-11", reason: expect.stringContaining("rate window reset") });
  });

  test("rate-paused, window NOT reset (within 60s slack) -> noop", () => {
    const d = resumeDecision({ ...base(), resetEpoch: Math.floor(NOW / 1000) }, NOW);
    expect(d.action).toBe("noop");
    expect(d.reason).toContain("has not reset");
  });

  test("rate-paused without resetEpoch -> noop flagged as drift", () => {
    const { resetEpoch: _drop, ...cp } = base();
    const d = resumeDecision(cp as Checkpoint, NOW);
    expect(d.action).toBe("noop");
    expect(d.reason).toContain("schema drift");
  });

  test("error run, retried too soon -> noop (bounded, no tight loop)", () => {
    const cp: Checkpoint = { ...base(), stopped: "error", ranAt: new Date(NOW - 10 * 60_000).toISOString(), resetEpoch: undefined, error: "boom" };
    const d = resumeDecision(cp, NOW);
    expect(d.action).toBe("noop");
    expect(d.reason).toContain("bounded retry");
  });

  test("error run, >55min old -> dispatch (self-heal, at most hourly)", () => {
    const cp: Checkpoint = { ...base(), stopped: "error", ranAt: new Date(NOW - 56 * 60_000).toISOString(), error: "gh api 502" };
    const d = resumeDecision(cp, NOW);
    expect(d.action).toBe("dispatch");
    expect(d.reason).toContain("retrying failed run");
  });

  test("done with pending -> noop flagged as drift (writer bug)", () => {
    const d = resumeDecision({ ...base(), stopped: "done" }, NOW);
    expect(d.action).toBe("noop");
    expect(d.reason).toContain("schema drift");
  });
});

describe("staleness (freshness canary)", () => {
  test("fresh dashboard -> null", () => {
    expect(staleness({ generatedAt: new Date(NOW - 2 * 24 * 3_600_000).toISOString() }, NOW)).toBeNull();
  });

  test("stale beyond 7 days -> actionable reason", () => {
    const reason = staleness({ generatedAt: new Date(NOW - 9 * 24 * 3_600_000).toISOString() }, NOW);
    expect(reason).toContain("stale");
    expect(reason).toContain("unmerged data PR");
  });

  test("missing/unparseable generatedAt -> stale reason", () => {
    expect(staleness({}, NOW)).toContain("no parseable generatedAt");
    expect(staleness({ generatedAt: "whenever" }, NOW)).toContain("no parseable generatedAt");
  });
});
