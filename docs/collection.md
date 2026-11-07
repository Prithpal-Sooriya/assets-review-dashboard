# Dashboard data collection

How the Assets PR workload dashboard data is collected, aggregated, validated,
and refreshed. Operated by the `collect-data` GitHub Actions workflow; all
commands below also run locally with `bun` + `gh` (authenticated).

- Contract: `scripts/lib/types.ts` (`DashboardData`) — schemaVersion 1.
- Config: `config/collector.json` (repos, roster, exclusions, window, rate
  budget). Methodology version and notes are embedded in every output.
- Tests: `tests/collector/` — deterministic aggregation + collection-engine
  tests (fake transport, in-memory store). CI: `ci-collector.yml`.

## Commands

```bash
bun test tests/collector/                                   # tests
bun run scripts/collect.ts --from 2025-11 [--to 2026-10] \
  [--repos MetaMask/core,...] [--as-of <ISO>]               # collect raw partitions
bun run scripts/aggregate.ts [--as-of <ISO>] [--out data/dashboard.json]
bun run scripts/validate-search.ts --month 2026-10          # cross-check vs search
```

`--as-of` fixes the run cutoff (default: now). `collect` exit codes: `0`
complete, `3` stopped at rate-budget reserve (checkpointed, resume by
re-running the same command), `1` usage error or hard failure (the CLI's
catch path still writes a truthful `.last-run.json` with `stopped: "error"`
and the pending list, so aborted runs can't masquerade as complete).
Aggregation is deterministic for fixed partitions + fixed `--as-of`.
`aggregate --prune` additionally deletes partition files and manifest
entries outside the aggregated window, bounding the data branch's growth
under the rolling display window.

## Collection design (completeness)

Search APIs are capped and lossy (dismissed-review history disappears;
result caps). This collector is **complete-by-walk** instead:

1. Each repo's `/pulls?state=all&sort=updated&direction=desc` is walked
   page-by-page (100/page) from newest `updated_at` down to the start of
   `--from`'s month.
2. PRs are bucketed by `updated_at` month. When the walk descends below a
   month's start, that month **closes**: every PR with `updated_at` in that
   month has necessarily been visited (the list is sorted descending).
3. For every bucketed PR, the full review history is fetched once and
   filtered to roster members (all states kept, incl. DISMISSED; PENDING
   excluded).

Load-bearing invariant: **any review submission bumps the PR's
`updated_at`** (validated empirically: 1071/1071 sampled PRs have
`updated_at` ≥ last review `submitted_at`). A review submitted in month M
therefore lives on a PR whose `updated_at` ≥ that review — the PR is
bucketed in month M or later, and month M closes only after the walk has
passed it. Month rows are emitted only when all partitions from that month
through the current month are complete (a PR reviewed in month M can sit in
a *later* partition because later activity moved its `updated_at`;
aggregation dedupes by freshest snapshot per PR).

### Resumability & checkpoints

- Per-page walk state is persisted to `data/raw/.inprogress/<repo>.json`
  (bucketed PR records, closed months) — committed to the data branch so
  incomplete runs survive runner exits. Completed walks delete it.
- `data/raw/manifest.json` records per repo-month status
  (`complete`/`pending`) + completeness kind + counts. Aggregation only
  trusts complete partitions and reports everything else in `coverage`
  (there is deliberately no partition-level `error` status — hard failures
  surface via `.last-run.json` and the red workflow run).
- On graceful rate stops (budget reserve 250), open months are marked
  pending, state persisted, exit 3. Re-runs resume and never re-fetch
  cached PRs; month-end-complete months are skipped entirely; the current
  partial month is always refreshed to the newer cutoff.
- `data/raw/.last-run.json` — machine-readable last-run report (stopped
  state, pending list, rate reset epoch) driving the workflow's
  auto-continuation; written atomically (tmp+rename) on both success and
  hard failure.
- A local lock (`data/raw/.lock`, mtime-based, 2h stale takeover) prevents
  concurrent local runs; it is never committed.

### Month completeness kinds

- `monthEnd` — all PRs whose `updated_at` falls in that calendar month were
  visited. Stable after the month ends; never re-collected.
- `asOfCutoff` — the current partial month, complete through the run cutoff
  (walk start). Refreshed on every run. Reviews submitted during a walk can
  be missed (snapshot drift ≈ walk duration) — disclosed, corrected by the
  next run.

## Metric semantics (contract fields)

- Ownership: PRs are **internal** if labelled `team-assets` OR authored by a
  roster member (`team-label`/`team-author`); everything else external.
- Qualifying reviews: APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED
  by a roster member (case-insensitive), excluding self-reviews and
  `excludedReviewers` (amandaye0h, amitabh94 — their PRs still count as
  external work). Issue comments are never counted.
- Review months come from `submittedAt` (never mergedAt); reviews submitted
  after a merge still count in their submission month.
- `reviewedUnmergedPrs` is a snapshot status (state at collection cutoff).
- `mergedExternalReviewedPrs` requires a qualifying review at/before merge
  time (post-merge reviews don't qualify it).
- `prs[]` includes: any PR with a qualifying review in-window, internal
  merged PRs in-window, and external merged in-window PRs reviewed
  at/before merge (pre-window review evidence retained in `reviewMonths`).
- Roster is fixed across the whole window (dawnseeker8's join date is
  unknown/disclosed — assumed full-window).

## Validation

- `tests/collector/` — unit-level determinism + all semantic edge cases
  (self-review, excluded reviewer, post-merge review, freshest-snapshot
  dedupe, dependency-complete emission, resume/no-refetch).
- `scripts/validate-search.ts` — cross-checks a collected month against
  GitHub `search` (`reviewed-by:` + `updated:` range) per roster member.
  Diffs are classified, not assumed equal: search drops dismissed-review
  history (expected `missingFromSearch`), while any `WALK_GAP` (search found
  a PR the walk missed, still updated in that month) is a real completeness
  failure. Reports land in `data/validation/<month>.json`.
- The aggregation CLI runs `validateDashboardData` invariants and exits 1
  on any violation.

## Workflows

`collect-data.yml` (monthly cron + manual dispatch):

- **Monthly** (3rd of month, 06:10 UTC): window = 12 completed months +
  current partial month; months already `monthEnd` complete are skipped, so
  a run only collects the newly closed month + refreshes the current one.
- **Manual** (`start_date` input, `YYYY-MM-DD`): window starts at that
  month; the cutoff is fixed at run start (deterministic aggregate).
- Runs `bun test tests/collector/` first, on the reviewed default-branch
  code that performs the collection — no data is written on failure.
- Writes only to an **orphan, data-only branch** `data/auto-refresh`
  (**never the default branch**, no force-push): the workflow prepares a
  git worktree of that branch, mirrors `data/` into it with rsync, and
  pushes. The data branch deliberately carries no code — nothing unreviewed
  executes in the token-bearing job, its own pushes fire no `on: push`
  workflows (no workflow files exist on it), merging its data PR never
  touches source files, and there are no merges/conflicts to reconcile. A
  guard refuses to continue if the branch ever carries anything outside
  `data/`.
- Hard collector failures (exit 1) fail the run red immediately with the
  checkpoints already pushed; paused runs finish red with a greppable
  `[EXPECTED-AUTO-RESUME]` annotation (not actionable).
- Opens or updates one data PR; each attempt appends a 🤖 comment with
  coverage/status derived from `.last-run.json`.
- Actions are pinned to commit SHAs; the bun version is pinned once in
  `.bun-version` (read by every workflow).
- **Bounded continuation without sleep loops**: on exit 3 the workflow pushes
  the checkpoint, reports the reset time on the data PR, and finishes
  paused-red. The hourly `collect-data-heartbeat` workflow re-dispatches
  `collect-data` once the rate window resets (same window start, from the
  checkpoint) — automatic, no human re-run, no sleeping runners. Each
  dispatched run consumes a fresh hourly budget and resumes from committed
  checkpoints.
- Auth: `GITHUB_TOKEN` (contents+pull-requests: write). Optional secret
  **`DASHBOARD_GH_TOKEN`** (classic PAT, repo scope) — if set, it is used
  instead for its higher rate budget (its only purpose; data PRs don't
  trigger code CI either way, since `ci-collector.yml` is path-scoped to
  code and the in-workflow test step gates data runs). No secret values
  live in this repo.

`ci-collector.yml` (PRs + pushes touching collector-owned paths):
`bun install --frozen-lockfile` (shared root package.json), typecheck via
`tsconfig.collector.json`, then `bun test tests/collector/`. UI CI is
`ci-ui.yml`, owned by the frontend; filenames are deliberately distinct
so the two roles never edit each other's CI.

`collect-data-heartbeat.yml` (hourly): no-op unless the data-branch
checkpoint reports pending partitions and the rate window has reset (for
hard-failed runs, retries are bounded to ~1/hour), no collect-data run is
active, and the checkpoint's `from` month validates as `YYYY-MM` — then it
re-dispatches `collect-data` with the checkpoint's window start.

## Public-repo safety

The repository is public. Everything committed under `data/` is derived
from public MetaMask repositories: PR numbers/titles/URLs, state, dates,
labels, author and reviewer logins, and review states/timestamps — no PR
bodies, no issue/PR comments, no emails, no credentials, and nothing from
private repositories. Workflow checkpoints (`data/raw/.inprogress/`,
`data/raw/.last-run.json`) contain the same record shapes. Tokens are only
ever provided per-run via Actions secrets/env and are never written to disk
or logs.

```
data/
  dashboard.json          # aggregated output (the contract)
  raw/manifest.json       # per repo-month collection status
  raw/<repo-slug>/<YYYY-MM>.json   # raw partition (immutable once monthEnd)
  raw/.inprogress/<repo>.json      # walk checkpoint (committed)
  raw/.last-run.json      # machine-readable last-run report (committed)
  validation/<month>.json # search cross-validation reports (committed)
```

## Completeness & provenance caveats (read before trusting numbers)

1. Numbers come from the GitHub REST API as walked — no search caps, no
   sampling. Claimed completeness is per repo-month partition (walk-based,
   see above), never inferred from search results.
2. The current partial month is complete only through its cutoff
   (`asOfCutoff`); it can miss activity during the collection walk itself
   (corrected next run). Month rows require all dependency partitions
   complete; `coverage` discloses every gap.
3. Reviews are stored only for current-roster members (roster is fixed by
   the contract; re-aggregation cannot resurrect non-roster history).
4. `reviewedUnmergedPrs` reflects snapshot state at cutoff, not final
   outcome.
5. Post-merge reviews count in their submission month but do not qualify
   `mergedExternalReviewedPrs` (at/before-merge filter).
6. Search cross-validation is advisory: search has its own index lag and
   silently drops dismissed-review history; classifications are recorded in
   `data/validation/`.
