/** Deterministic aggregation tests: raw partitions -> exact dashboard contract. */
import { describe, expect, test } from "bun:test";
import { aggregate, findMissingCompletePartitions, validateDashboardData } from "../../scripts/lib/aggregate";
import { isoWeekKey } from "../../scripts/lib/config";
import type { Manifest, RawPartition, RawPrRecord } from "../../scripts/lib/types";
import { completeEntry, manifestOf, pr, review, testConfig } from "./fixtures";

const AS_OF = "2026-03-15T12:00:00Z"; // window: 2026-01 .. 2026-03 (partial March)

function partition(
  repo: string,
  month: string,
  completeness: "monthEnd" | "asOfCutoff",
  collectedAt: string,
  prs: RawPrRecord[],
): RawPartition {
  return { schemaVersion: 1, repo, month, completeness, collectedAt, prCount: prs.length, prs };
}

/** Core scenario set (repo: MetaMask/core, all months complete). */
function corePartitions(): RawPartition[] {
  const jan = partition("MetaMask/core", "2026-01", "monthEnd", "2026-02-01T00:00:00Z", [
    // PR1 external, reviewed Jan+Feb, merged Feb. Stale Jan snapshot
    // (pre-merge); the fresher Feb snapshot below supplies both review
    // months. Walk-valid: a Feb merge/review bumps updated_at into Feb.
    pr(1, {
      authorLogin: "carol",
      updatedAt: "2026-01-10T00:00:00Z",
      state: "OPEN",
      reviews: [review(11, "alice", "APPROVED", "2026-01-10T10:00:00Z")],
    }),
    // PR2 internal via label only (author not on roster), still OPEN
    pr(2, {
      authorLogin: "zoe",
      labels: ["team-assets"],
      updatedAt: "2026-01-05T00:00:00Z",
      reviews: [review(13, "alice", "COMMENTED", "2026-01-06T10:00:00Z")],
    }),
    // PR4 internal author, self-review only + excluded reviewer; merged Jan
    pr(4, {
      authorLogin: "alice",
      updatedAt: "2026-01-15T00:00:00Z",
      mergedAt: "2026-01-15T09:00:00Z",
      state: "MERGED",
      reviews: [
        review(14, "alice", "CHANGES_REQUESTED", "2026-01-14T10:00:00Z"), // self -> excluded
        review(15, "excluded1", "APPROVED", "2026-01-14T11:00:00Z"), // excluded reviewer
      ],
    }),
    // PR9 appears in Jan AND Feb partitions; Feb snapshot is fresher (merged)
    pr(9, {
      authorLogin: "carol",
      updatedAt: "2026-01-20T00:00:00Z",
      state: "OPEN",
      reviews: [review(16, "alice", "COMMENTED", "2026-01-20T10:00:00Z")],
    }),
    // PR10 internal, merged before window -> out of scope
    pr(10, {
      authorLogin: "bob",
      updatedAt: "2026-01-02T00:00:00Z",
      mergedAt: "2025-12-15T00:00:00Z",
      state: "MERGED",
    }),
    // PR11 external, merged Jan, only pre-window review evidence (Dec)
    pr(11, {
      authorLogin: "dave",
      updatedAt: "2026-01-20T00:00:00Z",
      mergedAt: "2026-01-20T10:00:00Z",
      state: "MERGED",
      reviews: [review(17, "alice", "APPROVED", "2025-12-28T10:00:00Z")],
    }),
  ]);
  const feb = partition("MetaMask/core", "2026-02", "monthEnd", "2026-03-01T00:00:00Z", [
    // PR3 internal author, reviewed+merged Feb
    pr(3, {
      authorLogin: "alice",
      updatedAt: "2026-02-03T00:00:00Z",
      mergedAt: "2026-02-03T09:00:00Z",
      state: "MERGED",
      reviews: [review(18, "bob", "APPROVED", "2026-02-01T10:00:00Z")],
    }),
    // PR5 external, only excluded reviewer reviewed; merged Feb -> NOT counted
    pr(5, {
      authorLogin: "erin",
      updatedAt: "2026-02-10T00:00:00Z",
      mergedAt: "2026-02-10T09:00:00Z",
      state: "MERGED",
      reviews: [review(19, "excluded1", "APPROVED", "2026-02-09T10:00:00Z")],
    }),
    // PR1 freshest snapshot: merged Feb with Jan+Feb reviews
    pr(1, {
      authorLogin: "carol",
      updatedAt: "2026-02-25T00:00:00Z",
      mergedAt: "2026-02-25T09:00:00Z",
      state: "MERGED",
      reviews: [review(11, "alice", "APPROVED", "2026-01-10T10:00:00Z"), review(12, "bob", "COMMENTED", "2026-02-20T10:00:00Z")],
    }),
    // PR9 freshest snapshot: merged Feb, extra bob review Feb
    pr(9, {
      authorLogin: "carol",
      updatedAt: "2026-02-28T00:00:00Z",
      mergedAt: "2026-02-28T09:00:00Z",
      state: "MERGED",
      reviews: [
        review(16, "alice", "COMMENTED", "2026-01-20T10:00:00Z"),
        review(20, "bob", "APPROVED", "2026-02-27T10:00:00Z"),
      ],
    }),
  ]);
  const mar = partition("MetaMask/core", "2026-03", "asOfCutoff", "2026-03-15T11:00:00Z", [
    // PR6 external, PENDING review only -> not qualifying
    pr(6, {
      authorLogin: "frank",
      updatedAt: "2026-03-01T00:00:00Z",
      reviews: [review(21, "bob", "PENDING", null)],
    }),
    // PR7 external, dismissed review in March (partial month) -> qualifying
    pr(7, {
      authorLogin: "grace",
      updatedAt: "2026-03-02T00:00:00Z",
      reviews: [review(22, "alice", "DISMISSED", "2026-03-02T10:00:00Z")],
    }),
    // PR8 external, review submitted DURING the walk (after this partition's
    // own cutoff 2026-03-15T11:00, before the global asOf 12:00) -> defensively
    // excluded: the partition only guarantees capture strictly before its
    // own walk start (per-record cutoff, not the global asOf)
    pr(8, {
      authorLogin: "heidi",
      updatedAt: "2026-03-03T00:00:00Z",
      reviews: [review(23, "bob", "COMMENTED", "2026-03-15T11:30:00Z")],
    }),
    // PR12 external, review submitted after the asOf cutoff entirely
    pr(12, {
      authorLogin: "ivan",
      updatedAt: "2026-03-03T00:00:00Z",
      reviews: [review(24, "bob", "COMMENTED", "2026-03-20T10:00:00Z")],
    }),
  ]);
  return [jan, feb, mar];
}

function coreManifest(): Manifest {
  return manifestOf({
    "MetaMask/core|2026-01": completeEntry("2026-02-01T00:00:00Z", 7),
    "MetaMask/core|2026-02": completeEntry("2026-03-01T00:00:00Z", 4),
    "MetaMask/core|2026-03": completeEntry("2026-03-15T11:00:00Z", 4, "asOfCutoff"),
    // extension: Feb+Mar complete, Jan pending -> Jan row must be omitted
    "MetaMask/metamask-extension|2026-02": completeEntry("2026-03-01T00:00:00Z", 1),
    "MetaMask/metamask-extension|2026-03": completeEntry("2026-03-15T11:00:00Z", 0, "asOfCutoff"),
  });
}

function extensionPartitions(): RawPartition[] {
  return [
    partition("MetaMask/metamask-extension", "2026-02", "monthEnd", "2026-03-01T00:00:00Z", [
      pr(100, {
        authorLogin: "ivan",
        updatedAt: "2026-02-12T00:00:00Z",
        reviews: [review(30, "alice", "APPROVED", "2026-02-12T10:00:00Z")],
      }),
    ]),
    partition("MetaMask/metamask-extension", "2026-03", "asOfCutoff", "2026-03-15T11:00:00Z", []),
  ];
}

describe("aggregate", () => {
  test("emits the exact contract shape and passes validation", () => {
    const data = aggregate({
      config: testConfig,
      asOf: AS_OF,
      manifest: coreManifest(),
      partitions: [...corePartitions(), ...extensionPartitions()],
    });
    expect(Object.keys(data)).toEqual([
      "schemaVersion",
      "generatedAt",
      "range",
      "methodology",
      "coverage",
      "months",
      "prs",
      "weeks",
      "firstReviews",
      "teamMerges",
    ]);
    expect(data.schemaVersion).toBe(1);
    expect(data.generatedAt).toBe(AS_OF);
    expect(data.range).toEqual({ start: "2026-01-01T00:00:00.000Z", end: AS_OF });
    expect(data.methodology.version).toBe("test-1");
    expect(validateDashboardData(data)).toEqual([]);
  });

  test("month rows: full metric semantics for MetaMask/core", () => {
    const data = aggregate({
      config: testConfig,
      asOf: AS_OF,
      manifest: coreManifest(),
      partitions: [...corePartitions(), ...extensionPartitions()],
    });
    const rows = (m: string, repo: string) => data.months.find((r) => r.month === m && r.repo === repo);

    // January (core): reviewed in Jan = PR1 (ext), PR2 (int), PR9 (ext, via freshest Feb snapshot); PR11 has only pre-window review
    const jan = rows("2026-01", "MetaMask/core")!;
    expect(jan).toBeDefined();
    expect(jan.internalReviewedPrs).toBe(1); // PR2 (label-internal)
    expect(jan.externalReviewedPrs).toBe(2); // PR1, PR9
    expect(jan.reviewSubmissions).toBe(3); // PR1 alice, PR2 alice, PR9 alice
    expect(jan.reviewedUnmergedPrs).toBe(1); // PR2 still OPEN (PR1, PR9 merged at snapshot)
    expect(jan.mergedInternalPrs).toBe(1); // PR4
    expect(jan.mergedExternalReviewedPrs).toBe(1); // PR11 (pre-window review evidence)

    // February (core)
    const feb = rows("2026-02", "MetaMask/core")!;
    expect(feb.internalReviewedPrs).toBe(1); // PR3
    expect(feb.externalReviewedPrs).toBe(2); // PR1 (bob Feb review), PR9 (bob Feb review)
    expect(feb.reviewSubmissions).toBe(3); // PR1 bob, PR3 bob, PR9 bob
    expect(feb.reviewedUnmergedPrs).toBe(0); // all merged
    expect(feb.mergedInternalPrs).toBe(1); // PR3
    expect(feb.mergedExternalReviewedPrs).toBe(2); // PR1 (review at/before merge), PR9 (alice Jan + bob Feb-27 <= merge Feb-28); PR5 excluded (excluded reviewer only)

    // March partial (core)
    const mar = rows("2026-03", "MetaMask/core")!;
    expect(mar.internalReviewedPrs).toBe(0);
    expect(mar.externalReviewedPrs).toBe(1); // PR7 dismissed review qualifies
    expect(mar.reviewSubmissions).toBe(1);
    expect(mar.reviewedUnmergedPrs).toBe(1); // PR7 OPEN
    expect(mar.mergedInternalPrs).toBe(0);
    expect(mar.mergedExternalReviewedPrs).toBe(0);

    // Months sorted ascending, repo order stable
    expect(data.months.map((r) => `${r.month}|${r.repo}`)).toEqual([
      "2026-01|MetaMask/core",
      "2026-02|MetaMask/core",
      "2026-02|MetaMask/metamask-extension",
      "2026-03|MetaMask/core",
      "2026-03|MetaMask/metamask-extension",
    ]);
  });

  test("month row omitted when dependency partitions are incomplete", () => {
    const data = aggregate({
      config: testConfig,
      asOf: AS_OF,
      manifest: coreManifest(),
      partitions: [...corePartitions(), ...extensionPartitions()],
    });
    // extension Jan partition pending -> no Jan row for extension
    const janExt = data.months.find((r) => r.month === "2026-01" && r.repo === "MetaMask/metamask-extension");
    expect(janExt).toBeUndefined();
    // but Feb/Mar rows exist (deps complete through current month)
    const febExt = data.months.find((r) => r.month === "2026-02" && r.repo === "MetaMask/metamask-extension");
    expect(febExt?.externalReviewedPrs).toBe(1);
    expect(febExt?.internalReviewedPrs).toBe(0);
  });

  test("coverage reflects manifest, sorted repo-then-month", () => {
    const data = aggregate({
      config: testConfig,
      asOf: AS_OF,
      manifest: coreManifest(),
      partitions: [...corePartitions(), ...extensionPartitions()],
    });
    expect(data.coverage.map((c) => `${c.repo}|${c.month}|${c.status}`)).toEqual([
      "MetaMask/core|2026-01|complete",
      "MetaMask/core|2026-02|complete",
      "MetaMask/core|2026-03|complete",
      "MetaMask/metamask-extension|2026-01|pending",
      "MetaMask/metamask-extension|2026-02|complete",
      "MetaMask/metamask-extension|2026-03|complete",
    ]);
    expect(data.coverage.find((c) => c.repo === "MetaMask/metamask-extension" && c.month === "2026-01")?.detail).toBe("not collected");
  });

  test("prs[] scope, ownership attribution, self/excluded/pending filtering", () => {
    const data = aggregate({
      config: testConfig,
      asOf: AS_OF,
      manifest: coreManifest(),
      partitions: [...corePartitions(), ...extensionPartitions()],
    });
    const byId = new Map(data.prs.map((p) => [p.id, p]));

    // In scope: 1,2,3,4 (internal merged), 7,9,11 + extension 100
    // (Map keys string-sorted: "#11" < "#2")
    expect([...byId.keys()].sort()).toEqual([
      "MetaMask/core#1",
      "MetaMask/core#11",
      "MetaMask/core#2",
      "MetaMask/core#3",
      "MetaMask/core#4",
      "MetaMask/core#7",
      "MetaMask/core#9",
      "MetaMask/metamask-extension#100",
    ]);
    // Out of scope: 5 (excluded reviewer only), 6 (pending only), 8 (post-cutoff), 10 (pre-window merge)

    expect(byId.get("MetaMask/core#2")?.ownership).toBe("internal");
    expect(byId.get("MetaMask/core#2")?.ownershipReason).toBe("team-label");
    expect(byId.get("MetaMask/core#3")?.ownershipReason).toBe("team-author");
    expect(byId.get("MetaMask/core#1")?.ownership).toBe("external");
    expect(byId.get("MetaMask/core#1")?.ownershipReason).toBe("other");

    // PR4: internal merged, self-review excluded -> empty review evidence
    expect(byId.get("MetaMask/core#4")?.reviewMonths).toEqual([]);
    expect(byId.get("MetaMask/core#4")?.reviewCountsByMonth).toEqual({});

    // PR9: freshest snapshot wins (merged state, both review months)
    expect(byId.get("MetaMask/core#9")?.state).toBe("MERGED");
    expect(byId.get("MetaMask/core#9")?.mergedAt).toBe("2026-02-28T09:00:00Z");
    expect(byId.get("MetaMask/core#9")?.reviewMonths).toEqual(["2026-01", "2026-02"]);
    expect(byId.get("MetaMask/core#9")?.reviewCountsByMonth).toEqual({ "2026-01": 1, "2026-02": 1 });

    // PR11: pre-window review evidence retained for merge-condition PRs
    expect(byId.get("MetaMask/core#11")?.reviewMonths).toEqual(["2025-12"]);
  });

  test("case-insensitive roster membership", () => {
    const partitions = [
      partition("MetaMask/core", "2026-02", "monthEnd", "2026-03-01T00:00:00Z", [
        pr(50, {
          authorLogin: "x",
          updatedAt: "2026-02-05T00:00:00Z",
          mergedAt: "2026-02-06T00:00:00Z",
          state: "MERGED",
          labels: ["Team-Assets"], // label case-insensitive
          reviews: [
            review(60, "Alice", "APPROVED", "2026-02-05T10:00:00Z"), // reviewer case-insensitive
            review(61, "ALICE", "COMMENTED", "2026-02-05T11:00:00Z"), // same member, second submission
          ],
        }),
      ]),
      partition("MetaMask/core", "2026-03", "asOfCutoff", "2026-03-15T11:00:00Z", []),
    ];
    const manifest = manifestOf({
      "MetaMask/core|2026-01": completeEntry("2026-02-01T00:00:00Z", 0),
      "MetaMask/core|2026-02": completeEntry("2026-03-01T00:00:00Z", 1),
      "MetaMask/core|2026-03": completeEntry("2026-03-15T11:00:00Z", 0, "asOfCutoff"),
    });
    const data = aggregate({ config: testConfig, asOf: AS_OF, manifest, partitions });
    const feb = data.months.find((r) => r.month === "2026-02" && r.repo === "MetaMask/core")!;
    expect(feb.internalReviewedPrs).toBe(1);
    expect(feb.reviewSubmissions).toBe(2); // two submissions by same member
    expect(feb.mergedInternalPrs).toBe(1);
    expect(data.prs.find((p) => p.number === 50)?.ownershipReason).toBe("team-label");
    expect(data.prs.find((p) => p.number === 50)?.reviewCountsByMonth).toEqual({ "2026-02": 2 });
  });

  test("weeks match month totals, and timing samples use first review and team merge", () => {
    const data = aggregate({
      config: testConfig,
      asOf: AS_OF,
      manifest: coreManifest(),
      partitions: [...corePartitions(), ...extensionPartitions()],
    });
    const sum = (
      rows: { repo: string; reviewSubmissions: number; mergedInternalPrs: number; mergedExternalReviewedPrs: number }[],
      repo: string,
      field: "reviewSubmissions" | "mergedInternalPrs" | "mergedExternalReviewedPrs",
    ) => rows.filter((r) => r.repo === repo).reduce((s, r) => s + r[field], 0);
    for (const repo of ["MetaMask/core", "MetaMask/metamask-extension"]) {
      for (const field of ["reviewSubmissions", "mergedInternalPrs", "mergedExternalReviewedPrs"] as const) {
        expect(sum(data.weeks, repo, field)).toBe(sum(data.months, repo, field));
      }
    }

    // Leading week (Mon 29 Dec 2025) is clipped by the 1 Jan window start.
    // The week containing asOf (15 Mar, a Sunday) runs Mon 9 Mar–Mon 16 Mar.
    const coreWeeks = data.weeks.filter((w) => w.repo === "MetaMask/core");
    expect(coreWeeks[0]?.week).toBe("2026-W01");
    expect(coreWeeks[0]?.weekStart).toBe("2025-12-29T00:00:00.000Z");
    expect(coreWeeks[0]?.partial).toBe(true);
    expect(coreWeeks.at(-1)?.week).toBe(isoWeekKey(Date.parse(AS_OF)));
    expect(coreWeeks.at(-1)?.partial).toBe(true);

    // PR2 review 6 Jan (Tue) sits in the week of Mon 5 Jan. PR1 review 10 Jan too.
    const w02 = coreWeeks.find((w) => w.week === isoWeekKey(Date.parse("2026-01-06T10:00:00Z")))!;
    expect(w02.week).toBe("2026-W02");
    expect(w02.partial).toBe(false);
    expect(w02.internalReviewedPrs).toBe(1); // PR2
    expect(w02.externalReviewedPrs).toBe(1); // PR1
    expect(w02.reviewSubmissions).toBe(2);

    // Extension January is pending, so weeks that overlap January are partial
    // (January events dropped) and weeks wholly inside January are omitted.
    const extWeeks = data.weeks.filter((w) => w.repo === "MetaMask/metamask-extension");
    expect(extWeeks.some((w) => w.week === "2026-W01")).toBe(false);
    const extBoundary = extWeeks.find((w) => w.week === isoWeekKey(Date.parse("2026-02-01T00:00:00Z")))!;
    expect(extBoundary.partial).toBe(true);
    const extReviewWeek = extWeeks.find((w) => w.week === isoWeekKey(Date.parse("2026-02-12T10:00:00Z")))!;
    expect(extReviewWeek.partial).toBe(false);
    expect(extReviewWeek.externalReviewedPrs).toBe(1);
    expect(extReviewWeek.reviewSubmissions).toBe(1);

    const minutes = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 60_000);
    // Default fixture createdAt is 2025-12-01. Self-review / excluded-reviewer
    // PR4 has a merge sample and no first-review sample.
    expect(data.firstReviews.map((s) => `${s.repo}#${s.ownership}@${s.at}`)).toEqual([
      "MetaMask/core#internal@2026-01-06T10:00:00Z", // PR2
      "MetaMask/core#external@2026-01-10T10:00:00Z", // PR1
      "MetaMask/core#external@2026-01-20T10:00:00Z", // PR9
      "MetaMask/core#internal@2026-02-01T10:00:00Z", // PR3
      "MetaMask/metamask-extension#external@2026-02-12T10:00:00Z", // PR100
      "MetaMask/core#external@2026-03-02T10:00:00Z", // PR7
    ]);
    expect(data.firstReviews[0]?.minutes).toBe(minutes("2025-12-01T00:00:00Z", "2026-01-06T10:00:00Z"));
    expect(data.firstReviews.find((s) => s.at === "2026-01-06T10:00:00Z")?.minutes).toBe(52440);
    // PR11's only review is pre-window; PR4's reviews are self/excluded.
    expect(data.firstReviews.some((s) => s.at.startsWith("2025-12"))).toBe(false);

    expect(data.teamMerges).toEqual([
      { repo: "MetaMask/core", mergedAt: "2026-01-15T09:00:00Z", minutes: minutes("2025-12-01T00:00:00Z", "2026-01-15T09:00:00Z") },
      { repo: "MetaMask/core", mergedAt: "2026-02-03T09:00:00Z", minutes: minutes("2025-12-01T00:00:00Z", "2026-02-03T09:00:00Z") },
    ]);
    expect(data.teamMerges[0]?.minutes).toBe(65340);
    expect(data.teamMerges[1]?.minutes).toBe(92700);
  });

  test("a review before createdAt is dropped from timing samples", () => {
    const partitions = [
      partition("MetaMask/core", "2026-02", "monthEnd", "2026-03-01T00:00:00Z", [
        pr(70, {
          authorLogin: "carol",
          createdAt: "2026-02-10T00:00:00Z",
          updatedAt: "2026-02-10T00:00:00Z",
          reviews: [review(70, "alice", "APPROVED", "2026-02-01T00:00:00Z")],
        }),
      ]),
      partition("MetaMask/core", "2026-03", "asOfCutoff", "2026-03-15T11:00:00Z", []),
    ];
    const manifest = manifestOf({
      "MetaMask/core|2026-01": completeEntry("2026-02-01T00:00:00Z", 0),
      "MetaMask/core|2026-02": completeEntry("2026-03-01T00:00:00Z", 1),
      "MetaMask/core|2026-03": completeEntry("2026-03-15T11:00:00Z", 0, "asOfCutoff"),
    });
    const data = aggregate({ config: testConfig, asOf: AS_OF, manifest, partitions });
    expect(data.months.find((r) => r.month === "2026-02")?.externalReviewedPrs).toBe(1);
    expect(data.firstReviews).toEqual([]);
    expect(validateDashboardData(data)).toEqual([]);
  });

  test("empty input -> valid empty dashboard with pending coverage", () => {
    const data = aggregate({
      config: testConfig,
      asOf: AS_OF,
      manifest: manifestOf({}),
      partitions: [],
    });
    expect(data.months).toEqual([]);
    expect(data.prs).toEqual([]);
    expect(data.weeks).toEqual([]);
    expect(data.firstReviews).toEqual([]);
    expect(data.teamMerges).toEqual([]);
    expect(data.coverage).toHaveLength(6); // 2 repos x 3 months, all pending
    expect(data.coverage.every((c) => c.status === "pending")).toBe(true);
    expect(validateDashboardData(data)).toEqual([]);
  });

  test("manifest complete but file missing -> coverage error, dependent rows omitted", () => {
    const manifest = coreManifest();
    const partitions = [...corePartitions(), ...extensionPartitions()].filter(
      (p) => !(p.repo === "MetaMask/core" && p.month === "2026-02"),
    );
    const data = aggregate({ config: testConfig, asOf: AS_OF, manifest, partitions });
    expect(data.coverage.find((c) => c.repo === "MetaMask/core" && c.month === "2026-02")?.status).toBe("error");
    // Jan row needs Jan..Mar and Feb row needs Feb..Mar -> both omitted;
    // March row needs only March (reviews submitted in March can only live
    // in the March partition since updated_at >= review submittedAt <= asOf).
    const coreMonths = data.months.filter((r) => r.repo === "MetaMask/core").map((r) => r.month);
    expect(coreMonths).toEqual(["2026-03"]);
    expect(data.months.find((r) => r.repo === "MetaMask/core" && r.month === "2026-03")?.externalReviewedPrs).toBe(1);
    expect(validateDashboardData(data)).toEqual([]);
  });

  test("deterministic: identical output for identical input", () => {
    const input = {
      config: testConfig,
      asOf: AS_OF,
      manifest: coreManifest(),
      partitions: [...corePartitions(), ...extensionPartitions()],
    };
    const a = JSON.stringify(aggregate(input));
    const b = JSON.stringify(aggregate(input));
    expect(a).toBe(b);
  });
});

describe("findMissingCompletePartitions", () => {
  const repos = ["MetaMask/core", "MetaMask/metamask-extension"];
  const months = ["2026-01", "2026-02"];
  const manifest = manifestOf({
    "MetaMask/core|2026-01": completeEntry("2026-02-01T00:00:00Z", 3),
    "MetaMask/core|2026-02": { status: "pending" }, // not complete -> not required
    "MetaMask/metamask-extension|2026-01": completeEntry("2026-02-01T00:00:00Z", 5),
    "MetaMask/metamask-extension|2026-02": completeEntry("2026-03-01T00:00:00Z", 7),
  });

  test("all complete partitions have files -> empty", async () => {
    const hasFile = async () => true;
    expect(await findMissingCompletePartitions(manifest, repos, months, hasFile)).toEqual([]);
  });

  test("complete partition with a missing file is named (hand deletion propagated)", async () => {
    const hasFile = async (repo: string, m: string) => !(repo === "MetaMask/core" && m === "2026-01");
    expect(await findMissingCompletePartitions(manifest, repos, months, hasFile)).toEqual([
      "MetaMask/core|2026-01",
    ]);
  });

  test("pending partitions without files are not flagged", async () => {
    const hasFile = async (repo: string, m: string) => !(repo === "MetaMask/core" && m === "2026-02");
    expect(await findMissingCompletePartitions(manifest, repos, months, hasFile)).toEqual([]);
  });
});
