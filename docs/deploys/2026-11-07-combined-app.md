# Deploy record — 2026-11-07 (combined app: Daily at `/`, Historical at `/historical`)

One file per production deploy; `docs/deployment.md` keeps the lasting rules.

## Deployed tree

- **Commit:** `7436b17` on merged `main` — PR
  [#15](https://github.com/Prithpal-Sooriya/assets-review-dashboard/pull/15)
  “feat(nav): combined app — Daily at / and Historical at /historical”, merged
  by the first mate after an exact-head CLEAN/green gate. First deploy built
  from **merged `main`** per the updated production-tree rule in
  `docs/deployment.md` (the temporary historical-only exclusion is superseded:
  daily publication was authorized, issue #6 resolved).
- **Composition:** merged `main` exactly — no additions, no exclusions, no
  cherry-picks. Combined app: Daily at `/` (client-side collection from public
  GitHub data, optional PAT), Historical at `/historical` (build-time embedded
  aggregate), `#/today?…` (live share-link format) and `/#/history` (alias)
  preserved on any path.
- **Runtime identity:** supersedes `dpl_Hx3Q4i66PYY4wJ71wfXMA5tPpyZu`
  (historical-only production). Two changes vs that deployment: the combined
  navigation/routing feature (PR #15) **and** the data payload — the embedded
  `data/dashboard.json` now carries the completed backfill from PR #11
  (39/39 repo-months, generatedAt `2026-11-07T19:57:43.809Z`, 2470 PRs, 5281
  review submissions).

## Deployment

- **ID:** `dpl_2BCibo6ZnQj9GunnwsEXUQfUQ5kx` (production), built via
  `vercel build --prod` + `vercel deploy --prebuilt --prod` from the
  CLI-linked project `assets-dashboard-ui` (scope `prithpal-sooriyas-projects`,
  no git integration — nothing auto-deploys from `main`).
- **URLs:** `https://metamask-assets-dashboard-ui.vercel.app` (friendly) and
  `https://assets-dashboard-ui.vercel.app` — same bundle
  (`index-04pkpwPy.js`, hash-matched: the live root references the identical
  filename as the local `.vercel/output` build).

## Verification (logged-out)

- `/` → **Daily** tab active (`aria-current="page"`), “Daily review queue”
  renders; anonymous state honestly labelled (rate-limit note, optional PAT
  panel — no Daily data until a visitor authenticates; by design).
- `/historical` → **Historical** tab active; direct load and reload both stay
  Historical (`vercel.json` rewrites `^/historical$` and `^/historical/$` →
  `/` present in the output config); “Data as of 7 Nov 2026, 19:57 UTC”.
- Full dataset: coverage summary **“39/39 repo-months complete”**; window
  displayed “Nov 2025 – Nov 2026 · 13 months with data”; real-data source
  line present; **no** “Sample data” indicator.
- Navigation both directions; legacy `/#/history` → Historical;
  `/#/today?view=awaiting&sort=newest` → Daily with filter state applied.
  All checks passed on **both** production URLs.
- Bundle audit (pre-deploy): real payload embedded (real-only PR ids present,
  generatedAt matches `data/dashboard.json`); no demo-fixture content;
  no secrets — the `github_pat_` occurrences are the token-redaction regex
  and the PAT input placeholder, not values; no `ghp_`/`gho_` tokens, no
  `VERCEL_OIDC` material in the bundle.
- CSP `connect-src 'self' https://api.github.com` (unchanged; Daily’s
  client-side collection requires the GitHub API).

## Data coverage at deploy time

**39/39** contract-window repo-months complete (2025-11 … 2026-11) — the
completed backfill (PR #11); window displayed as “Nov 2025 – Nov 2026 · 13
months with data”; no consciously accepted coverage limitations at this
deploy.
