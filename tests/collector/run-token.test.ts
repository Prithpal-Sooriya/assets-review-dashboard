import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

/**
 * run-token.sh is the security control for the token policy (ref guard,
 * classic-PAT refusal, format gate, auth preflight). These tests cover its
 * branches with fake tokens and a stubbed `gh` — no network, no secrets.
 */

const script = path.join(import.meta.dir, "..", "..", "scripts", "run-token.sh");

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

interface RunResult {
  code: number;
  stdout: string;
  envFile: string;
}

/** A fake `gh` on PATH: fails for the auth-failure fixtures, succeeds otherwise. */
async function stubGh(): Promise<string> {
  const bin = await mkdtemp(path.join(tmpdir(), "runtoken-gh-"));
  dirs.push(bin);
  await writeFile(
    path.join(bin, "gh"),
    [
      "#!/usr/bin/env bash",
      '# Fails for the two auth-failure fixtures; succeeds otherwise.',
      'if [ "$GH_TOKEN" = "AUTH_FAIL_TOKEN" ] || [ "$GH_TOKEN" = "github_pat_expired_1" ]; then exit 1; fi',
      'echo "rate budget: 4818/5000"',
    ].join("\n"),
  );
  await $`chmod +x ${path.join(bin, "gh")}`.quiet();
  return bin;
}

async function runScript(env: Record<string, string>, ghBin: string): Promise<RunResult> {
  const dir = await mkdtemp(path.join(tmpdir(), "runtoken-"));
  dirs.push(dir);
  const envFile = path.join(dir, "github_env");
  const proc = await $`bash ${script}`.env({
    ...process.env as Record<string, string>,
    ...env,
    GITHUB_ENV: envFile,
    PATH: `${ghBin}:${process.env.PATH ?? ""}`,
  }).nothrow().quiet();
  let content = "";
  try {
    content = await Bun.file(envFile).text();
  } catch {
    /* not written on refusal paths */
  }
  return { code: proc.exitCode, stdout: proc.stdout.toString(), envFile: content };
}

describe("run-token.sh", () => {
  test("refuses a non-default ref before any token logic", async () => {
    const r = await runScript({ REF: "refs/heads/feature", PAT_SECRET: "", BASE_TOKEN: "t", DEFAULT_BRANCH: "main" }, await stubGh());
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("refusing to run from a non-default ref (refs/heads/feature)");
    expect(r.envFile).toBe("");
  });

  test("refuses a classic repo-scope PAT outright", async () => {
    const r = await runScript({ REF: "refs/heads/main", PAT_SECRET: "ghp_classictoken", BASE_TOKEN: "t", DEFAULT_BRANCH: "main" }, await stubGh());
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("CLASSIC PAT (ghp_ prefix)");
  });

  test("refuses an unrecognized token format", async () => {
    const r = await runScript({ REF: "refs/heads/main", PAT_SECRET: "not-a-token", BASE_TOKEN: "t", DEFAULT_BRANCH: "main" }, await stubGh());
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("unrecognized format");
  });

  test("accepts a fine-grained PAT: exports token+kind, masks the value", async () => {
    const r = await runScript({ REF: "refs/heads/main", PAT_SECRET: "github_pat_fine_123", BASE_TOKEN: "base", DEFAULT_BRANCH: "main" }, await stubGh());
    expect(r.code).toBe(0);
    expect(r.envFile).toContain("RUN_TOKEN=github_pat_fine_123");
    expect(r.envFile).toContain("RUN_TOKEN_KIND=DASHBOARD_GH_TOKEN");
    expect(r.stdout).toContain("::add-mask::github_pat_fine_123");
    expect(r.stdout).toContain("rate budget: 4818/5000");
  });

  test("unrouted input (empty string) fails closed, not a silent downgrade", async () => {
    const r = await runScript({ REF: "refs/heads/main", PAT_SECRET: "", BASE_TOKEN: "github_base_tok", DEFAULT_BRANCH: "main" }, await stubGh());
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("pat-secret input was not routed");
    expect(r.envFile).toBe("");
  });

  test("__UNSET__ routes an unset secret to GITHUB_TOKEN with a visible notice", async () => {
    const r = await runScript({ REF: "refs/heads/main", PAT_SECRET: "__UNSET__", BASE_TOKEN: "github_base_tok", DEFAULT_BRANCH: "main" }, await stubGh());
    expect(r.code).toBe(0);
    expect(r.envFile).toContain("RUN_TOKEN=github_base_tok");
    expect(r.envFile).toContain("RUN_TOKEN_KIND=GITHUB_TOKEN");
    expect(r.stdout).toContain("::notice::run token: GITHUB_TOKEN (DASHBOARD_GH_TOKEN unset)");
    expect(r.stdout).not.toContain("add-mask");
  });

  test("expired-PAT preflight failure names DASHBOARD_GH_TOKEN and the remedy", async () => {
    const r = await runScript({ REF: "refs/heads/main", PAT_SECRET: "github_pat_expired_1", BASE_TOKEN: "base", DEFAULT_BRANCH: "main" }, await stubGh());
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("DASHBOARD_GH_TOKEN failed authentication");
    expect(r.stdout).toContain("EXPIRED");
  });

  test("GITHUB_TOKEN preflight failure names GITHUB_TOKEN, not the secret", async () => {
    const r = await runScript({ REF: "refs/heads/main", PAT_SECRET: "__UNSET__", BASE_TOKEN: "AUTH_FAIL_TOKEN", DEFAULT_BRANCH: "main" }, await stubGh());
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("GITHUB_TOKEN failed authentication");
    expect(r.stdout).not.toContain("DASHBOARD_GH_TOKEN failed authentication");
    expect(r.stdout).toContain("no secret to rotate");
  });
});
describe("composite-action template hygiene", () => {
  const actionsDir = path.join(import.meta.dir, "..", "..", ".github", "actions");
  const availableInComposite = /^(github|inputs|env|runner|vars|steps|job|needs|strategy|matrix)\./;

  test("no template expression in any action file references an unavailable context", async () => {
    // GitHub expands ${{...}} ANYWHERE in an action manifest — including
    // description prose — and composite-action files have no secrets
    // context at all. An expanded reference fails template validation at
    // job load, before any step runs. Runs 42416009318 (step env) and
    // 42420249910 (expression inside the input description text) both
    // failed on exactly this class; actionlint cannot catch it (it does
    // not lint action-file expressions), so this test is the guard.
    const files = [...new Bun.Glob("*/action.yml").scanSync({ cwd: actionsDir })];
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const f of files) {
      const text = await Bun.file(path.join(actionsDir, f)).text();
      for (const m of text.matchAll(/\$\{\{([^}]*)\}\}/g)) {
        const expr = m[1]!.trim();
        if (!availableInComposite.test(expr)) violations.push(`${f}: expression "{{ ${expr} }}" uses a context unavailable in composite actions`);
      }
    }
    expect(violations).toEqual([]);
  });
});
