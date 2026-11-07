#!/usr/bin/env bash
# run-token: ref guard + run-token selection + auth preflight for
# collect-data / collect-data-heartbeat. Extracted from the composite
# action so this security control is unit-testable — the inline version
# lived in GitHub template expressions inside the action file, exactly
# where the secrets-context bug class lives and where no static lint
# (actionlint lints workflow files and call-site inputs only) reaches.
#
# Env contract (all required):
#   REF             github.ref of this run; must be refs/heads/$DEFAULT_BRANCH
#   PAT_SECRET      DASHBOARD_GH_TOKEN value; empty string = unset = GITHUB_TOKEN
#   BASE_TOKEN      github.token
#   DEFAULT_BRANCH  derived by the caller via `gh repo view`
#   GITHUB_ENV      optional (set in Actions); RUN_TOKEN and RUN_TOKEN_KIND
#                   are appended there for subsequent gh-consuming steps
#
# Exits: 0 = token selected and auth-preflighted (RUN_TOKEN in env/output);
#        1 = refused or auth failed (workflow annotation names the cause).
set -euo pipefail

if [ "$REF" != "refs/heads/$DEFAULT_BRANCH" ]; then
  echo "::error::refusing to run from a non-default ref ($REF); dispatch from $DEFAULT_BRANCH so only reviewed code executes"
  exit 1
fi

kind="" token=""
if [ -n "$PAT_SECRET" ]; then
  case "$PAT_SECRET" in
    github_pat_*)
      token="$PAT_SECRET" kind=DASHBOARD_GH_TOKEN
      # Explicit masking: don't rely on the runner's value-based masking
      # surviving the input routing.
      echo "::add-mask::$PAT_SECRET"
      echo "run token: DASHBOARD_GH_TOKEN (fine-grained PAT)"
      ;;
    ghp_*)
      echo "::error::DASHBOARD_GH_TOKEN is a CLASSIC PAT (ghp_ prefix) — classic repo-scope tokens grant every repository their owner can access and cannot be contained by workflow guards. Replace it with a fine-grained PAT (github_pat_ prefix) scoped to this repository only, or unset the secret to fall back to GITHUB_TOKEN."
      exit 1
      ;;
    *)
      echo "::error::DASHBOARD_GH_TOKEN has an unrecognized format — expected a fine-grained PAT (github_pat_ prefix). Unset it to fall back to GITHUB_TOKEN."
      exit 1
      ;;
  esac
else
  token="$BASE_TOKEN" kind=GITHUB_TOKEN
  # Visible annotation, not a gray log line: a caller that omits the input
  # fails at workflow load (required input), so empty here means unset.
  echo "::notice::run token: GITHUB_TOKEN (DASHBOARD_GH_TOKEN unset)"
fi

export RUN_TOKEN="$token" RUN_TOKEN_KIND="$kind"
if [ -n "${GITHUB_ENV:-}" ]; then
  printf 'RUN_TOKEN=%s\nRUN_TOKEN_KIND=%s\n' "$token" "$kind" >> "$GITHUB_ENV"
fi

# Auth preflight: the selected token only falls back to GITHUB_TOKEN when
# the secret is ABSENT — an expired-but-present PAT yields 401s with the
# fallback never engaging. Detect it here, named after the token actually
# in use, with the matching remedy.
if ! GH_TOKEN="$token" gh api /rate_limit >/dev/null 2>&1; then
  if [ "$kind" = "DASHBOARD_GH_TOKEN" ]; then
    echo "::error::DASHBOARD_GH_TOKEN failed authentication — it has likely EXPIRED; rotate it (Settings > Secrets) or unset it to fall back to GITHUB_TOKEN."
  else
    echo "::error::GITHUB_TOKEN failed authentication — the runner-provisioned token was rejected (check the workflow's GITHUB_TOKEN permissions and GitHub status); DASHBOARD_GH_TOKEN is unset, so there is no secret to rotate."
  fi
  exit 1
fi
GH_TOKEN="$token" gh api /rate_limit --jq '.resources.core | "rate budget: \(.remaining)/\(.limit)"'
