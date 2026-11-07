/**
 * Validation tool: cross-checks a collected partition month against
 * GitHub's reviewed-by search for every roster member, to validate the
 * walk-based discovery (review submissions update PR updated_at).
 *
 * Search is known to potentially lose dismissed-review history, so this
 * tool classifies differences instead of asserting equality:
 *  - missingFromPartition: search found a PR the walk missed — serious
 *    (would falsify completeness); each case is spot-checked and reported.
 *  - missingFromSearch: partition has a reviewed PR search did not return —
 *    expected for dismissed-only reviews (search limitation), spot-checked.
 *
 * Usage:
 *   bun run scripts/validate-search.ts --month 2026-10 [--repos ...]
 *                                      [--data-dir data] [--config config/collector.json]
 *                                      [--max-search-pages 5] [--spot-checks 15]
 * Writes data/validation/<month>.json and prints a human summary.
 */
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { assertMonth, loadConfig, repoSlug } from "./lib/config";
import { createGhCliTransport } from "./lib/gh";
import { resolveDataDir } from "./lib/store";
import type { RawPartition } from "./lib/types";

function argValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`--${name} requires a value`);
  return v;
}

interface RestSearchItem {
  number: number;
  pull_request?: unknown;
}

interface DiffCase {
  repo: string;
  member: string;
  prNumber: number;
  classification: string;
  detail?: string;
}

async function main(): Promise<number> {
  const month = argValue("month");
  if (!month) {
    console.error("missing --month YYYY-MM");
    return 1;
  }
  assertMonth(month, "month");
  const dataDir = resolveDataDir(argValue("data-dir"));
  const configPath = argValue("config") ?? "config/collector.json";
  const cfg = await loadConfig(configPath);
  const repos = argValue("repos")?.split(",").map((s) => s.trim()).filter(Boolean) ?? cfg.repos;
  const maxSearchPages = Number(argValue("max-search-pages") ?? 5);
  const spotChecks = Number(argValue("spot-checks") ?? 15);

  const log = (msg: string) => console.log(msg);
  const transport = createGhCliTransport({ ...cfg.request, log });

  // Search date range: whole month (inclusive of last day).
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const fromDate = `${month}-01`;
  const toDate = `${month}-${String(lastDay).padStart(2, "0")}`;

  const results: Record<string, unknown>[] = [];
  const missingFromPartition: DiffCase[] = [];
  const missingFromSearch: DiffCase[] = [];
  let truncations = 0;

  for (const repo of repos) {
    const partitionFile = path.join(dataDir, "raw", repoSlug(repo), `${month}.json`);
    const partition: RawPartition | null = (await Bun.file(partitionFile).exists())
      ? (JSON.parse(await Bun.file(partitionFile).text()) as RawPartition)
      : null;
    if (!partition || partition.completeness !== "monthEnd") {
      log(`[${repo}] partition ${month} not month-end complete; skipping repo (collect it first).`);
      continue;
    }
    const byMember = new Map<string, Set<number>>();
    for (const pr of partition.prs) {
      for (const r of pr.reviews) {
        if (!r.submittedAt) continue;
        const set = byMember.get(r.authorLogin.toLowerCase()) ?? new Set<number>();
        set.add(pr.number);
        byMember.set(r.authorLogin.toLowerCase(), set);
      }
    }

    for (const member of cfg.roster) {
      const memberLc = member.toLowerCase();
      const searchNumbers = new Set<number>();
      const q = `repo:${repo} is:pr reviewed-by:${member} updated:${fromDate}..${toDate}`;
      let total = 0;
      for (let p = 1; p <= maxSearchPages; p++) {
        await Bun.sleep(2200); // search secondary limit: stay under 30/min
        const res = (await transport.getJson(
          `/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${p}`,
        )) as { total_count: number; items: RestSearchItem[] };
        total = res.total_count;
        for (const item of res.items ?? []) {
          if (item.pull_request !== undefined) searchNumbers.add(item.number);
        }
        if ((res.items?.length ?? 0) < 100) break;
        if (p === maxSearchPages && total > p * 100) {
          truncations++;
          log(`[${repo}] ${member}: search truncated at ${maxSearchPages} pages (total ${total})`);
        }
      }
      const partitionNumbers = byMember.get(memberLc) ?? new Set<number>();
      for (const n of searchNumbers) {
        if (!partitionNumbers.has(n)) missingFromPartition.push({ repo, member, prNumber: n, classification: "unverified" });
      }
      for (const n of partitionNumbers) {
        if (!searchNumbers.has(n)) missingFromSearch.push({ repo, member, prNumber: n, classification: "unverified" });
      }
      results.push({
        repo,
        member,
        searchTotal: total,
        searchUnique: searchNumbers.size,
        partitionReviewedPrs: partitionNumbers.size,
        matched: [...searchNumbers].filter((n) => partitionNumbers.has(n)).length,
      });
      log(
        `[${repo}] ${member}: search ${searchNumbers.size}/${total}, partition ${partitionNumbers.size}, matched ${[...searchNumbers].filter((n) => partitionNumbers.has(n)).length}`,
      );
    }
  }

  // Spot-check bounded samples of each diff class.
  const spot = async (cases: DiffCase[], kind: string): Promise<void> => {
    for (const c of cases.slice(0, spotChecks)) {
      try {
        const pr = (await transport.getJson(`/repos/${c.repo}/pulls/${c.prNumber}`)) as {
          number: number;
          updated_at: string;
          state: string;
          merged_at: string | null;
        };
        const inMonth = pr.updated_at.slice(0, 7) === month;
        if (kind === "missingFromPartition") {
          c.classification = inMonth ? "WALK_GAP" : "search-index-drift (updated_at now outside month)";
          c.detail = `updated_at=${pr.updated_at}`;
        } else {
          const reviews = (await transport.getJson(
            `/repos/${c.repo}/pulls/${c.prNumber}/reviews?per_page=100`,
          )) as { state: string; submitted_at: string | null; user: { login: string } | null }[];
          const memberReviews = reviews.filter((r) => (r.user?.login ?? "").toLowerCase() === c.member.toLowerCase());
          const dismissed = memberReviews.some((r) => r.state === "DISMISSED");
          const pendingOnly = memberReviews.every((r) => !r.submitted_at);
          c.classification = dismissed
            ? "dismissed-review (search limitation)"
            : pendingOnly
              ? "pending-only review (never submitted)"
              : "unexplained";
          c.detail = `updated_at=${pr.updated_at}; member review states: ${memberReviews.map((r) => r.state).join(",") || "none"}`;
        }
      } catch (err) {
        c.classification = `spot-check failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  };

  await spot(missingFromPartition, "missingFromPartition");
  await spot(missingFromSearch, "missingFromSearch");

  const walkGaps = missingFromPartition.filter((c) => c.classification === "WALK_GAP");
  const report = {
    schemaVersion: 1,
    month,
    generatedAt: new Date().toISOString(),
    searchTruncations: truncations,
    perMember: results,
    missingFromPartition,
    missingFromSearch,
    summary: {
      missingFromPartitionTotal: missingFromPartition.length,
      walkGaps: walkGaps.length,
      missingFromSearchTotal: missingFromSearch.length,
      missingFromSearchClassified: missingFromSearch.reduce<Record<string, number>>((acc, c) => {
        acc[c.classification] = (acc[c.classification] ?? 0) + 1;
        return acc;
      }, {}),
    },
  };
  const outDir = path.join(dataDir, "validation");
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `${month}.json`);
  await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  log(`--- validation ${month} ---`);
  log(`missingFromPartition: ${missingFromPartition.length} (WALK_GAPS: ${walkGaps.length})`);
  log(`missingFromSearch: ${missingFromSearch.length} -> ${JSON.stringify(report.summary.missingFromSearchClassified)}`);
  log(`wrote ${outFile}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`validate-search failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
