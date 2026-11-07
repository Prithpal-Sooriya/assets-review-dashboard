import { describe, expect, test } from "bun:test";
import path from "node:path";

/**
 * Composite-action template hygiene.
 *
 * GitHub expands template expressions ANYWHERE in an action manifest —
 * including description prose — and the `secrets` context does not exist
 * in composite-action files at all: an expanded reference fails template
 * validation at job load, before any step runs. Real failures of this
 * class: run 42416009318 (step env) and run 42420249910 (expression
 * inside the input description text). actionlint cannot lint
 * action-file expressions, so this test is the guard.
 *
 * The check is a DENYLIST, not a leading-token allowlist (an allowlist
 * prefix check missed `inputs.x || secrets.Y` and misfired on
 * function-first expressions like `format(...)` / `hashFiles(...)`;
 * see the PR #17 adverse round). Denied contexts:
 *   secrets            — proven unavailable in composite actions (both
 *                        real job-load failures above)
 *   jobs               — not an expression context anywhere
 *   job, needs, strategy, matrix
 *                      — workflow-file contexts; two independent
 *                        doc-checks (adverse round) found no
 *                        composite-action availability for them
 * `steps` stays allowed (documented for composite-action outputs), as do
 * github/inputs/env/vars/runner and the expression functions.
 */

/** Contexts that do not resolve in composite-action manifests. */
const UNAVAILABLE_CONTEXTS = ["secrets", "jobs", "job", "needs", "strategy", "matrix"] as const;

/**
 * Extract `${{ ... }}` bodies, tolerating `}` inside the expression
 * (quoted literals like `format('{0}', x)`, `fromJSON('{"a":1}')`) —
 * a plain negated-brace character-class regex silently skips those —
 * the precise bug class this guard exists for.
 */
export function extractTemplateExpressions(text: string): string[] {
  const bodies: string[] = [];
  let start = text.indexOf("${{");
  while (start !== -1) {
    let quote: string | null = null;
    let depth = 0;
    let body = "";
    let end = -1;
    for (let j = start + 3; j < text.length; j++) {
      const c = text[j]!;
      if (quote) {
        body += c;
        if (c === quote && text[j - 1] !== "\\") quote = null;
        continue;
      }
      if (c === "'" || c === '"') {
        quote = c;
        body += c;
        continue;
      }
      if (c === "{") {
        depth++;
        body += c;
        continue;
      }
      if (c === "}") {
        if (depth > 0) {
          depth--;
          body += c;
          continue;
        }
        if (text[j + 1] === "}") {
          end = j;
          break;
        }
        body += c; // lone '}' at depth 0 not followed by '}': keep scanning
        continue;
      }
      body += c;
    }
    if (end !== -1) bodies.push(body.trim());
    start = text.indexOf("${{", start + 3);
  }
  return bodies;
}

/** Remove quoted string literals so 'secrets.x' inside a string is not flagged. */
function stripStringLiterals(expr: string): string {
  return expr.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''");
}

/** Any denied-context reference anywhere in the expression (operand boundary, not mid-property). */
function unavailableContextRefs(expr: string): string[] {
  const cleaned = stripStringLiterals(expr);
  const refs: string[] = [];
  for (const ctx of UNAVAILABLE_CONTEXTS) {
    // Operand boundary: start, or a char that is not a word char, '.', or quote —
    // so github.secrets.name (a property named "secrets") is not flagged,
    // but `x || secrets.Y` is.
    const re = new RegExp(`(^|[^\\w.'"])(${ctx})\\s*\\.`, "g");
    if (re.test(cleaned)) refs.push(ctx);
  }
  return refs;
}

describe("composite-action template hygiene", () => {
  const actionsDir = path.join(import.meta.dir, "..", "..", ".github", "actions");

  test("the guard itself: catches the evasions and passes the valid forms (meta)", () => {
    const flagged = [
      "secrets.DASHBOARD_GH_TOKEN",
      "inputs.pat-secret || secrets.DASHBOARD_GH_TOKEN", // leading-token allowlist missed this
      "format('{0}', secrets.DASHBOARD_GH_TOKEN)", // '}' inside — naive regex skipped this
      "fromJSON('{\"a\":1}') || secrets.X",
      "needs.build.outputs.x || github.token", // workflow-only context
      "matrix.os",
      "job.status",
      "strategy.job-index",
      "jobs.foo.bar", // not an expression context anywhere
    ];
    const clean = [
      "github.ref",
      "inputs.pat-secret",
      "github.token",
      "env.DEFAULT_BRANCH",
      "github.event.repository.name", // property chain — only 'github' is a context
      "steps.build.outputs.x", // documented for composite-action outputs
      "format('{0}', inputs.name)", // function-first is valid
      "toJSON(inputs.x)",
      "hashFiles('src/**')",
      "fromJSON('{\"a\":1}').x",
      "!inputs.flag",
      "inputs['pat-secret']",
      "'__UNSET__'",
      "github.event_name == 'release' && inputs.mode || 'default'",
    ];
    const missed = flagged.filter((e) => unavailableContextRefs(e).length === 0);
    expect(missed).toEqual([]); // evasions that slipped past the guard
    const falseFlags = clean.filter((e) => unavailableContextRefs(e).length !== 0);
    expect(falseFlags).toEqual([]); // valid forms the guard misfired on
    // Extraction itself must not skip brace-bearing expressions.
    const extracted = extractTemplateExpressions(
      "prose: ${{ format('{0}', secrets.DASHBOARD_GH_TOKEN) }} and ${{ github.ref }}",
    );
    expect(extracted).toEqual(["format('{0}', secrets.DASHBOARD_GH_TOKEN)", "github.ref"]);
  });

  test("no template expression in any action file references an unavailable context", async () => {
    const files = [
      ...new Bun.Glob("**/action.yml").scanSync({ cwd: actionsDir }),
      ...new Bun.Glob("**/action.yaml").scanSync({ cwd: actionsDir }),
    ];
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const f of files) {
      const text = await Bun.file(path.join(actionsDir, f)).text();
      for (const expr of extractTemplateExpressions(text)) {
        for (const ctx of unavailableContextRefs(expr)) {
          violations.push(`${f}: expression "{{ ${expr} }}" references '${ctx}', unavailable in composite actions`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
