/** Shared test fixtures: config + raw record builders. */
import type { CollectorConfig, Manifest, RawPrRecord, RawReview } from "../../scripts/lib/types";

export const testConfig: CollectorConfig = {
  schemaVersion: 1,
  repos: ["MetaMask/core", "MetaMask/metamask-extension"],
  roster: ["alice", "bob", "dawnseeker8"],
  excludedReviewers: ["excluded1"],
  teamLabel: "team-assets",
  metadataTeam: "MetaMask/metamask-assets",
  displayWindowMonths: 2,
  reviewStates: ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"],
  request: {
    perPage: 100,
    maxRetries: 3,
    retryBaseDelayMs: 1,
    minDelayMs: 0,
    rateCheckInterval: 15,
    rateReserve: 250,
  },
  methodologyVersion: "test-1",
  methodologyNotes: ["note-a"],
};

export function review(
  id: number,
  authorLogin: string,
  state: string,
  submittedAt: string | null,
): RawReview {
  return { id, state, submittedAt, authorLogin };
}

export function pr(
  number: number,
  overrides: Partial<RawPrRecord> = {},
): RawPrRecord {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/example/pr/${number}`,
    state: "OPEN",
    draft: false,
    createdAt: "2025-12-01T00:00:00Z",
    updatedAt: "2026-02-15T00:00:00Z",
    closedAt: null,
    mergedAt: null,
    authorLogin: "carol",
    labels: [],
    reviews: [],
    ...overrides,
  };
}

export function manifestOf(entries: Record<string, Manifest["partitions"][string]>): Manifest {
  return { schemaVersion: 1, partitions: entries };
}

export function completeEntry(collectedAt: string, prCount: number, completeness: "monthEnd" | "asOfCutoff" = "monthEnd") {
  return { status: "complete" as const, completeness, collectedAt, prCount };
}
