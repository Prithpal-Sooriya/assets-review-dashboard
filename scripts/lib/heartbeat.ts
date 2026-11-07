/**
 * Pure decision core for the hourly heartbeat (collect-data-heartbeat.yml).
 * Kept free of I/O so every branch is unit-tested: schema drift in the
 * checkpoint contract must fail LOUDLY (red run), never silently no-op.
 */

export interface Checkpoint {
  ranAt: string; // ISO timestamp
  from: string; // YYYY-MM
  to: string; // YYYY-MM
  stopped: "done" | "rate" | "error";
  pending: string[]; // "owner/repo|YYYY-MM" keys
  resetEpoch?: number; // unix seconds; absent on error-path records
  error?: string;
}

export type ResumeDecision =
  | { action: "noop"; reason: string }
  | { action: "dispatch"; fromMonth: string; reason: string };

const MONTH_RE = /^\d{4}-\d{2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/**
 * Strict checkpoint parse. Returns null on ANY unrecognized shape — unknown
 * fields, missing fields, wrong types, out-of-vocabulary `stopped` values.
 * The heartbeat turns null into a red run (drift detected loudly).
 */
export function parseCheckpoint(obj: unknown): Checkpoint | null {
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  // Exact field set: forward-compat additions are a schema change that must
  // be acknowledged here, not silently ignored.
  const allowed = new Set(["ranAt", "from", "to", "stopped", "pending", "resetEpoch", "error", "rateRemaining"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) return null;
  if (typeof o.ranAt !== "string" || !ISO_RE.test(o.ranAt)) return null;
  if (typeof o.from !== "string" || !MONTH_RE.test(o.from)) return null;
  if (typeof o.to !== "string" || !MONTH_RE.test(o.to)) return null;
  if (o.stopped !== "done" && o.stopped !== "rate" && o.stopped !== "error") return null;
  if (!Array.isArray(o.pending) || !o.pending.every((p) => typeof p === "string")) return null;
  if (o.resetEpoch !== undefined && (typeof o.resetEpoch !== "number" || !Number.isFinite(o.resetEpoch) || o.resetEpoch < 0)) return null;
  if (o.error !== undefined && typeof o.error !== "string") return null;
  if (o.rateRemaining !== undefined && typeof o.rateRemaining !== "number") return null;
  if (o.stopped === "error" && o.resetEpoch !== undefined) return null; // error records carry no reset
  return {
    ranAt: o.ranAt,
    from: o.from,
    to: o.to,
    stopped: o.stopped,
    pending: o.pending as string[],
    ...(o.resetEpoch !== undefined ? { resetEpoch: o.resetEpoch } : {}),
    ...(o.error !== undefined ? { error: o.error } : {}),
  };
}

const HOUR_MS = 3_600_000;

/**
 * Whether to re-dispatch collect-data now. Bounded: rate-paused runs wait
 * for the documented reset epoch (+60s slack); hard-failed runs retry at
 * most ~hourly (55 min since the failed run wrote its checkpoint).
 */
export function resumeDecision(cp: Checkpoint, nowMs: number): ResumeDecision {
  if (cp.pending.length === 0) return { action: "noop", reason: "no pending partitions" };
  if (cp.stopped === "done") {
    // The CLI only writes done with empty pending; anything else is drift.
    return { action: "noop", reason: "inconsistent checkpoint: stopped=done with pending partitions (schema drift?)" };
  }
  if (cp.stopped === "rate") {
    const reset = cp.resetEpoch;
    if (reset === undefined) return { action: "noop", reason: "inconsistent checkpoint: stopped=rate without resetEpoch (schema drift?)" };
    if (nowMs < reset * 1000 + 60_000) return { action: "noop", reason: `rate window has not reset yet (epoch ${reset})` };
    return { action: "dispatch", fromMonth: cp.from, reason: `${cp.pending.length} pending partitions, rate window reset` };
  }
  // stopped === "error": bounded retry, never a tight loop.
  const ranAt = Date.parse(cp.ranAt);
  if (!Number.isFinite(ranAt)) return { action: "noop", reason: "unparseable ranAt (schema drift?)" };
  if (nowMs - ranAt < 55 * 60_000) return { action: "noop", reason: `last run failed less than 55min ago (bounded retry; error: ${cp.error ?? "unknown"})` };
  return { action: "dispatch", fromMonth: cp.from, reason: `retrying failed run (${cp.error ?? "unknown"}), >55min since failure` };
}

export const DASHBOARD_STALE_DAYS = 7;

/**
 * Freshness canary input: the dashboard contract's generatedAt (honest max
 * walk start). Returns null when fresh; a reason string when stale beyond
 * maxAgeDays — the one red that is never expected.
 */
export function staleness(
  dashboard: { generatedAt?: unknown },
  nowMs: number,
  maxAgeDays: number = DASHBOARD_STALE_DAYS,
): string | null {
  const g = dashboard.generatedAt;
  if (typeof g !== "string" || !Number.isFinite(Date.parse(g))) {
    return "dashboard.json has no parseable generatedAt";
  }
  const age = nowMs - Date.parse(g);
  if (age > maxAgeDays * 24 * HOUR_MS) {
    const days = Math.floor(age / (24 * HOUR_MS));
    return `dashboard.json is ${days}d stale (generatedAt ${g}) — likely an unmerged data PR, a broken heartbeat, or a failed monthly cron`;
  }
  return null;
}
