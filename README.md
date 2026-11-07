# assets-review-dashboard

Assets team PR review workload dashboard for MetaMask (Core, Mobile, Extension) —
two pages, one app:

- **Daily** — <https://metamask-assets-dashboard-ui.vercel.app/>
  The live review queue: open PRs that need Assets review right now (explicit
  review requests to the team or its members, plus team-authored PRs waiting on
  others). Collected in the browser from public GitHub REST data; an optional
  read-only personal access token (held in memory only, never stored or sent
  anywhere else) makes team review requests visible.
- **Historical** — <https://metamask-assets-dashboard-ui.vercel.app/historical>
  Team-level monthly aggregates across the full collection window (reviews,
  merges, unmerged PRs, coverage), embedded at build time from
  `data/dashboard.json`. Team-level metrics only — no individual data.

The top navigation switches between the two pages (real URLs — direct loads,
reloads and back/forward all work). Legacy hash links are preserved: `#/today`
still opens Daily (shareable Daily filter links keep their state in the hash
query, e.g. `/#/today?repo=MetaMask%2Fcore&sort=newest`) and `#/history` still
opens Historical.

## Local development

```sh
bun install
bun run dev        # http://localhost:5173
bun run build      # production build (embeds data/dashboard.json)
bun run preview    # http://localhost:4173
```

## Tests

```sh
bun run test       # typecheck + unit + e2e (builds all UI variants first)
```

See [`docs/collection.md`](docs/collection.md) for the collector and
[`docs/deployment.md`](docs/deployment.md) for data loading, the test matrix
and the deploy procedure.

## Deployment

The site is a static build deployed to the existing Vercel project
(`assets-dashboard-ui`, aliases `metamask-assets-dashboard-ui.vercel.app` and
`assets-dashboard-ui.vercel.app`). Deploys are deliberate, manual
`vercel build --prod && vercel deploy --prebuilt --prod` runs — the project's
GitHub integration is disconnected on purpose.

**Deploy the combined `main` branch** — the app that ships both the Daily and
Historical pages. Do not deploy a historical-only tree: that regresses the
public site to the pre-Daily state (root showing only history, no nav) and
breaks the `/historical` URL. `vercel.json` rewrites `/historical` to the SPA
shell; verify both URLs after every deploy.

Per-deploy records live in [`docs/deploys/`](docs/deploys/). The full gate
before any deploy: `bun run typecheck && bun run test:unit && bun run test:ui`.
