# Deployment

This dashboard is a static site: all data is embedded **at build time**. There is
no runtime data fetching, no GitHub API access from the browser, and no server
component.

## Build-time data loading

The Vite build resolves the `virtual:dashboard-data` module (see
`vite.config.ts`) from the first path that exists:

1. `$DASHBOARD_DATA_PATH` (absolute or repo-relative) — used by CI and local
   test builds,
2. `data/dashboard.json` — the collector's committed output (not present in
   this branch; owned by the collector role),
3. `public/sample/demo-dashboard.json` — a clearly-labelled synthetic demo
   fixture.

If the data file is missing, invalid, or empty the app refuses to render
numbers and shows an explicit state card explaining why (the demo fallback only
applies when *no* real data file exists at all). If the loaded data is the demo
fixture — detected via the `DEMO SAMPLE DATA` marker in its methodology notes —
every surface shows a prominent "Demo data" banner and the header chip reads
"Demo data" instead of a real cutoff date.

**A demo-fixture deployment must never be relabelled or presented as real
activity.** If you need to preview UI work without the collector output, keep
the demo fixture and its banner intact.

## Build and preview locally

```sh
bun install
bun run build                 # demo fixture → dist/
bun run preview               # http://localhost:4173

DASHBOARD_DATA_PATH=data/dashboard.json bunx vite build --outDir dist-real
bunx vite preview --outDir dist-real --port 4174
```

`bun run test:ui` builds all four variants (demo, real-shaped, empty, invalid)
and runs the Playwright suite against them.

## Vercel

The repo includes `vercel.json`:

- framework `vite`, install command `bun install`, build `bun run build`,
- a strict CSP (the only allowed inline script is the theme no-flash snippet,
  pinned by hash in `tests/ui/csp.test.ts`),
- `X-Content-Type-Options`, `Referrer-Policy` and `X-Frame-Options` headers.

Project setup (owner: the repo owner — do **not** create projects on other
people's accounts):

```sh
vercel link        # once, in the repo root
vercel deploy --prebuilt   # preview deployment
vercel --prod --prebuilt   # production
```

### Private protection — REQUIRED before any real-data deployment

The source repos are private, but **a private GitHub repo does not make a
Vercel deployment private.** A logged-out request is the source of truth: a
protected deployment answers `302` ("Protected by Vercel Authentication"); a
public one serves the app with `200`.

Before pointing any deployment at real `data/dashboard.json`, verify **both**
environments empirically (curl the URLs without cookies) and record the
result, date, and who checked:

1. **Preview deployments** — a preview URL must return `302` (Vercel
   Authentication) or a password wall, never `200`.
2. **Production deployment** — the production alias must be gated the same
   way. On the Hobby plan password protection for production is not available
   (it is a Pro/Enterprise feature), so **do not deploy real data to a public
   production URL on Hobby**; keep real data on protected preview URLs only,
   or change the plan/domain deliberately.

#### Verification record (2026-11-08, prithpal-sooriyas-projects / hobby)

- Project: `assets-dashboard-ui` (personal account, plan **hobby**).
- Preview deployment
  `https://assets-dashboard-os81g3sqh-prithpal-sooriyas-projects.vercel.app` —
  logged-out curl: **`302` "Protected by Vercel Authentication"** — previews
  are private.
- Production deployment `https://assets-dashboard-ui.vercel.app` — logged-out
  curl: **`200`, dashboard served** — production is **public** on this plan
  (project protection unconfigured; production password protection requires a
  paid plan).
- The currently public production URL serves **only the clearly-labelled
  demo fixture** (prominent "Demo data" banner; zero real activity data).
- The project's **GitHub integration is disconnected** on purpose: merges to
  the default branch can never auto-deploy to the public production alias.
  All deployments are manual (`vercel build` + `vercel deploy --prebuilt`).

**Real data must not be deployed to production** until one of these is true:
- the project is on a plan with password protection/SSO and it is verified
  enabled (paid upgrade — a deliberate owner decision, not to be done
  silently), or
- production is moved behind other enforced access control.

Until then, real-data builds go to preview URLs only (verified private), or
stay local.

### Data refresh

The dashboard is a snapshot; it only changes when it is rebuilt:

1. The collector updates `data/dashboard.json` (monthly, after the month
   closes; PR-reviewed on the default branch).
2. Merge the collector PR.
3. Re-run the frontend build (`vercel deploy --prebuilt` or a Git-connected
   redeploy). The new data is embedded; Vercel's immutable asset hashing means
   old bundles are not mutated.

There is no cron, webhook or runtime refresh by design: every number on the
site traces to one reviewed commit.
