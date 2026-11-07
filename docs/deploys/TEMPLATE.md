# Deploy record — <YYYY-MM-DD>

Copy this file per production deploy; fill every section. Lasting rules stay
in `docs/deployment.md`.

## Deployed tree

- **Commit:** `` on branch/tag `` — what the running build contains.
- **Composition:** base + intentional additions/exclusions (with reasons and
  issue links); confirm against the pre-deploy checklist.
- **Runtime identity:** how this relates to previously reviewed/deployed code
  (byte-identical payload change, new feature, etc.).

## Deployment

- **ID:** `dpl_...` (Ready timestamp), built via ``.
- **URLs:** production + aliases; bundle hash matched against the local build.

## Verification (logged-out)

- Real dataset renders / sample indicator state / coverage section state.
- Exclusions present or absent as intended; CSP / security headers.
- Secrets + private-data audit of embedded data and bundle.

## Data coverage at deploy time

N/M contract-window repo-months complete (per repo-month detail); window as
displayed; any consciously accepted limitations recorded with issue links.
