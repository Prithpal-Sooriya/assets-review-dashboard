/**
 * Config loading + validation, and shared date/month helpers.
 * All date math is UTC; months are "YYYY-MM" strings.
 */
import type { CollectorConfig } from "./types";

export async function readJsonFile(path: string): Promise<unknown> {
  const text = await Bun.file(path).text();
  return JSON.parse(text);
}

export async function loadConfig(path: string): Promise<CollectorConfig> {
  const cfg = await readJsonFile(path);
  return validateConfig(cfg);
}

export function validateConfig(cfg: unknown): CollectorConfig {
  const c = cfg as CollectorConfig;
  const errors: string[] = [];
  if (!Array.isArray(c.repos) || c.repos.length === 0) errors.push("repos must be a non-empty array");
  else {
    for (const r of c.repos) {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)) {
        errors.push("repos must be owner/name slugs");
        break;
      }
      // '.'/'..' segments would escape data/raw via path joins (a partition
      // path like data/raw/../<month>.json) — reject them outright.
      const segs = r.split("/");
      if (segs.some((s) => s === "." || s === "..")) {
        errors.push(`repos entry '${r}' must not contain '.' or '..' segments`);
        break;
      }
    }
    // Same-named repos in different orgs map to one partition directory and
    // one walk-state file — silent cross-repo overwrite; reject collisions.
    const slugs = c.repos.map((r) => repoSlug(r));
    if (new Set(slugs).size !== slugs.length) errors.push("repo names must be unique (same-named repos would share partition files)");
  }
  if (!Array.isArray(c.roster) || c.roster.length === 0) errors.push("roster must be a non-empty array");
  if (!Array.isArray(c.excludedReviewers)) errors.push("excludedReviewers must be an array");
  if (typeof c.teamLabel !== "string" || !c.teamLabel) errors.push("teamLabel must be a non-empty string");
  if (!Number.isInteger(c.displayWindowMonths) || c.displayWindowMonths < 1) errors.push("displayWindowMonths must be a positive integer");
  if (!Array.isArray(c.reviewStates) || c.reviewStates.length === 0) errors.push("reviewStates must be a non-empty array");
  // request.* must validate loudly too: a typo here (e.g. maxRetires) would
  // silently disable retries/pacing and surface later as confusing API
  // errors mid-walk instead of a startup config error.
  const rq = c.request as Record<string, unknown> | undefined;
  if (rq === undefined || typeof rq !== "object") {
    errors.push("request must be an object");
  } else {
    for (const k of ["perPage", "maxRetries", "retryBaseDelayMs", "minDelayMs", "rateCheckInterval", "rateReserve"]) {
      const v = rq[k];
      if (!Number.isInteger(v) || (v as number) < 1) errors.push(`request.${k} must be a positive integer`);
    }
    for (const k of Object.keys(rq)) {
      if (!["perPage", "maxRetries", "retryBaseDelayMs", "minDelayMs", "rateCheckInterval", "rateReserve"].includes(k)) {
        errors.push(`request has unknown key '${k}'`);
      }
    }
  }
  const overlap = (c.roster ?? []).filter((r) => (c.excludedReviewers ?? []).some((e) => e.toLowerCase() === r.toLowerCase()));
  if (overlap.length) errors.push(`roster and excludedReviewers overlap: ${overlap.join(", ")}`);
  if (errors.length) throw new Error(`Invalid collector config: ${errors.join("; ")}`);
  return c;
}

// ============================================================================
// Month helpers (UTC, string "YYYY-MM")
// ============================================================================

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonth(s: string): boolean {
  return MONTH_RE.test(s);
}

export function assertMonth(s: string, what = "month"): string {
  if (!isMonth(s)) throw new Error(`Invalid ${what}: ${s} (expected YYYY-MM)`);
  return s;
}

/** Month of an ISO UTC timestamp ("2026-11-07T09:46:41Z" -> "2026-11"). */
export function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

/** First instant of a month, ISO UTC. */
export function startOfMonthIso(month: string): string {
  assertMonth(month);
  return `${month}-01T00:00:00.000Z`;
}

/** month + delta months. */
export function addMonths(month: string, delta: number): string {
  assertMonth(month);
  const parts = month.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}`;
}

/** Inclusive list of months from..to (to >= from). */
export function monthRange(from: string, to: string): string[] {
  assertMonth(from, "from");
  assertMonth(to, "to");
  const out: string[] = [];
  let m = from;
  while (m <= to) {
    out.push(m);
    m = addMonths(m, 1);
  }
  return out;
}

/** Chronological compare of ISO timestamps (mixed precision safe). */
export function tsLt(a: string, b: string): boolean {
  return Date.parse(a) < Date.parse(b);
}

export function repoSlug(repo: string): string {
  return repo.split("/")[1] ?? repo.replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function partitionKey(repo: string, month: string): string {
  return `${repo}|${month}`;
}

/** Case-insensitive membership helper. */
export function loginSetLower(logins: string[]): Set<string> {
  return new Set(logins.map((l) => l.toLowerCase()));
}
