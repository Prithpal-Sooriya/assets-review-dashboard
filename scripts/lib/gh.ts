/**
 * REST transport backed by the `gh` CLI (`gh api`), so the same code path
 * works locally (existing gh auth) and in GitHub Actions (preinstalled gh
 * authenticated as GITHUB_TOKEN, or GH_TOKEN=COLLECTOR_TOKEN when a
 * higher-budget token is configured).
 *
 * Bounded retries with bounded backoff; no unbounded sleeps; tokens are
 * never read, stored or printed by this code.
 */

export interface RateInfo {
  remaining: number;
  limit: number;
  resetEpoch: number;
}

export class RateLimitedError extends Error {
  constructor(public resetEpoch: number) {
    super(`rate limit exhausted (resets at epoch ${resetEpoch})`);
  }
}

export class HttpError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export interface RestTransport {
  /** GET a REST API path (with query string) and parse JSON. */
  getJson(path: string): Promise<unknown>;
  /** Current core rate budget (call is free, does not consume quota). */
  getRate(): Promise<RateInfo>;
}

export interface TransportOptions {
  maxRetries: number;
  retryBaseDelayMs: number;
  minDelayMs: number;
  log?: (msg: string) => void;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function execGh(path: string): Promise<ExecResult> {
  const proc = Bun.spawn(["gh", "api", path], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

function httpStatusFromStderr(stderr: string): number | undefined {
  const m = stderr.match(/HTTP (\d{3})/);
  return m ? Number(m[1]) : undefined;
}

function isRateLimitStderr(stderr: string): boolean {
  return /rate limit/i.test(stderr) && /HTTP 403|HTTP 429/.test(stderr);
}

export function createGhCliTransport(opts: TransportOptions): RestTransport {
  const log = opts.log ?? (() => {});
  let requestsSinceDelay = 0;

  async function politeDelay(): Promise<void> {
    requestsSinceDelay++;
    if (opts.minDelayMs > 0 && requestsSinceDelay >= 10) {
      requestsSinceDelay = 0;
      await Bun.sleep(opts.minDelayMs * 10);
    } else if (opts.minDelayMs > 0) {
      await Bun.sleep(opts.minDelayMs);
    }
  }

  async function request(path: string, attempt = 0): Promise<unknown> {
    await politeDelay();
    let res: ExecResult;
    try {
      res = await execGh(path);
    } catch (err) {
      // spawn failure (gh missing, network down) — retry a bounded number of times
      if (attempt < opts.maxRetries) {
        log(`gh spawn failed (${String(err)}); retry ${attempt + 1}/${opts.maxRetries}`);
        await Bun.sleep(Math.min(30_000, opts.retryBaseDelayMs * 2 ** attempt));
        return request(path, attempt + 1);
      }
      throw new HttpError(`gh api failed to execute: ${String(err)}`);
    }
    if (res.code === 0) {
      try {
        return JSON.parse(res.stdout);
      } catch {
        throw new HttpError(`gh api returned non-JSON output for ${path.split("?")[0]}`);
      }
    }
    const status = httpStatusFromStderr(res.stderr);
    if (isRateLimitStderr(res.stderr)) {
      const rate = await safeRate();
      throw new RateLimitedError(rate?.resetEpoch ?? 0);
    }
    const transient = status === undefined || status >= 500 || status === 429;
    if (transient && attempt < opts.maxRetries) {
      log(`gh api ${status ?? "network"} error for ${path.split("?")[0]}; retry ${attempt + 1}/${opts.maxRetries}`);
      await Bun.sleep(Math.min(30_000, opts.retryBaseDelayMs * 2 ** attempt));
      return request(path, attempt + 1);
    }
    throw new HttpError(
      `gh api error for ${path.split("?")[0]}: ${res.stderr.trim().split("\n")[0] ?? "unknown"}`,
      status,
    );
  }

  async function safeRate(): Promise<RateInfo | null> {
    try {
      const res = await execGh("rate_limit");
      if (res.code !== 0) return null;
      const parsed = JSON.parse(res.stdout) as {
        resources: { core: { remaining: number; limit: number; reset: number } };
      };
      const core = parsed.resources.core;
      return { remaining: core.remaining, limit: core.limit, resetEpoch: core.reset };
    } catch {
      return null;
    }
  }

  return {
    getJson: (path) => request(path),
    getRate: async () => {
      // Transient failures here shouldn't kill a run; retry a few times
      // (the rate_limit endpoint is free — it does not count against the
      // core budget). Persistent failure is a hard error (visible, retryable
      // by re-running — checkpoints preserve progress).
      let lastErr: unknown = null;
      for (let i = 0; i < 3; i++) {
        try {
          const rate = await safeRate();
          if (rate) return rate;
          lastErr = new HttpError("could not read rate limit status");
        } catch (e) {
          lastErr = e;
        }
        await Bun.sleep(500 * (i + 1));
      }
      throw lastErr instanceof Error ? lastErr : new HttpError("could not read rate limit status");
    },
  };
}
