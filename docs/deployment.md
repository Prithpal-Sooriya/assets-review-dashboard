# Deployment

This dashboard is a static site: all data is embedded **at build time**. There is
no runtime data fetching, no GitHub API access from the browser, and no server
component.

## Build-time data loading

The Vite build resolves the `virtual:dashboard-data` module (see
`vite.config.ts`) from the first path that exists:

1. `$DASHBOARD_DATA_PATH` — a path **relative to the project root** that
   resolves inside it (absolute paths, `..` traversal and symlink escapes are
   rejected at build time). Used by CI and local test builds.
2. `data/dashboard.json` — the collector's committed output (committed on
   the default branch by the collector role in this repo; production builds
   embed it, UI test variants pin their own fixtures explicitly),
3. `src/data/demo-fixture.json` — a clearly-labelled synthetic demo
   fixture.

If the data file is missing, invalid, or empty the app refuses to render
numbers and shows an explicit state card explaining why (the demo fallback only
applies when *no* real data file exists at all). If the loaded data is the demo
fixture — detected via the `DEMO SAMPLE DATA` marker in its methodology notes —
every surface carries accurate sample-data labelling: a discreet
"Sample data" strip (synthetic figures, never real GitHub activity) and a
header chip that reads "Sample data" instead of a real cutoff date.

**A demo-fixture deployment must never be relabelled or presented as real
activity.** If you need to preview UI work without the collector output, keep
the sample fixture and its "Sample data" labelling intact.

## Build and preview locally

```sh
bun install
bun run build                 # data/dashboard.json → dist/ (demo fixture
                              # only when no real data file is committed)
bun run preview               # http://localhost:4173
```

The e2e variant builds are produced by `bun run build:test-fixtures` into
`dist-variants/` — no manual commands needed. Every variant pins its fixture
explicitly via `DASHBOARD_DATA_PATH` (`tests/ui/variants.ts`); in particular
the demo variant pins `src/data/demo-fixture.json`, so a committed real
`data/dashboard.json` can never leak into a test build. Preview ports
4173-4176 must be free when running the suite
(`--strictPort` fails fast on collisions; kill leftover preview servers).

`bun run test:ui` builds all four variants (demo, real-shaped, empty, invalid —
see `tests/ui/variants.ts`) and runs the Playwright suite against them.

Prerequisites and knobs:

- e2e tests default to the locally installed **Google Chrome** (`channel:
  'chrome'`, no browser download). Set `PW_CHANNEL=chromium` to use the
  Playwright-bundled browser instead (after `bunx playwright install
  chromium`).
- Sourcemaps are off by default and only for local debugging
  (`VITE_SOURCEMAP=1 bun run build`); they embed full original sources and
  must not ship on public deployments.
- The full gate before any deploy: `bun run typecheck && bun run test:unit &&
  bun run test:ui`.

## Vercel

The repo includes `vercel.json`:

- framework `vite`, install command `bun install`, build `bun run build`,
- a strict CSP (the only allowed inline script is the theme no-flash snippet,
  pinned by hash in `tests/ui/csp.test.ts`),
- `X-Content-Type-Options`, `Referrer-Policy` and `X-Frame-Options` headers.

Project setup (owner: the repo owner — do **not** create projects on other
people's accounts):

```sh
vercel link                        # once, in the repo root
vercel build                       # builds .vercel/output from dist/
vercel deploy --prebuilt           # preview deployment
vercel deploy --prebuilt --prod    # production deployment (see below)
```

### Visibility policy — public repo, public production (2026-11-07)

The repository and the production dashboard URL are **public by explicit
owner decision** (recorded 2026-11-07; dates in this record were corrected
from 2026-11-08 on 2026-11-07 — the original entries were written against a
misread clock, the system UTC date was 2026-11-07): the dashboard shows team-level
aggregates only (no individual reviewer metrics or names — enforced by tests),
so publishing it publicly is acceptable. Real `data/dashboard.json` may be
embedded in production builds.

Historical context — the earlier posture (kept for the record):

- Before 2026-11-07 the repo was treated as private and production was gated
  behind a "no real data on the public production alias" rule (a build-time
  `VERCEL_ENV=production` refusal plus preview-only real-data deploys). The
  owner's decision to make the repository and production public made that
  guard obsolete; it was removed rather than left as dead code that no longer
  matches policy.

What still holds regardless of visibility:

- **Sample-data labelling is mandatory.** A deployment embedding the synthetic
  fixture must always show the "Sample data" strip (invented figures are never
  presented as real GitHub data); presence and content are enforced by the
  `DEMO SAMPLE DATA` marker, unit tests and e2e tests (including that the
  real-source line never renders on sample builds). The strip is deliberately
  discreet — a small tinted one-liner, not a banner — by owner decision
  (2026-11-07): it must stay visible and accurate, not loud. ("demo" in code,
  the detection marker and the fixture filename, and "sample" in user-facing
  labels refer to the same synthetic fixture.)
- **Preview deployments stay behind Vercel Authentication** (verified 2026-11-07
  on the hobby plan: logged-out curl → `302` "Protected by Vercel
  Authentication"). If a logged-out request to a preview URL ever returns
  `200`, stop and re-check project protection before relying on previews for
  anything sensitive.
- Real-data builds state their source up front ("Source: public GitHub PRs
  from MetaMask Mobile, Core, and Extension" — the repo scope fixed by the
  shared contract v1; change this sentence, its docs mention and its e2e
  assertion together if that scope ever changes) alongside the collection
  coverage section; sample-data builds never show that line.
- Production URLs: `https://assets-dashboard-ui.vercel.app` (and any custom
  domain). Anyone can read a public production dashboard — that is the point.
- The project's **GitHub integration is disconnected** on purpose: deploys are
  deliberate (`vercel build` + `vercel deploy --prebuilt`), never automatic on
  merge. Reconnecting it would auto-deploy every default-branch merge to the
  public production alias — do not do that casually.
- **Re-check after Vercel plan/account changes:** any plan change, project
  transfer or protection setting change can alter what preview/production
  URLs expose. A logged-out curl of each URL remains the source of truth
  (`302` = protected, `200` = public); re-run it quarterly and after changes.

### Data refresh

The dashboard is a snapshot; it only changes when it is rebuilt. Monthly flow:

1. The collector updates `data/dashboard.json` (after the month closes;
   PR-reviewed on the default branch).
2. Merge the collector PR.
3. Rebuild and deploy: `vercel build && vercel deploy --prebuilt --prod`.
   Preview deployments (`--prebuilt` without `--prod`) are available for
   checking a refresh before promoting it, and stay behind Vercel
   Authentication.

There is no cron, webhook or runtime refresh by design: every number on the
site traces to one reviewed commit.

**If a deployment ever embeds something it should not have** (wrong data file,
secret, pre-release numbers): redeploying does **not** unpublish it. Vercel
keeps every deployment live at its unique `project-<hash>.vercel.app` URL.
Delete the affected deployments explicitly (`vercel rm <deployment-url>` for
each, or the dashboard) and treat the content as disclosed.
