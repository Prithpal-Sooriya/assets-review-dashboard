/**
 * Diff size as GitHub reports it on a pull request: additions, deletions,
 * and changed files. All three must be present for the snapshot to count;
 * a partial triple is treated as unknown so medians are not fed a zero
 * that GitHub never sent.
 *
 * Line buckets (additions + deletions), shared with the historical UI copy:
 *   small  < 100
 *   medium 100–499
 *   large  500–999
 *   xlarge ≥ 1000
 */

export interface DiffSize {
  additions: number;
  deletions: number;
  changedFiles: number;
}

export type SizeBucket = "small" | "medium" | "large" | "xlarge";

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export function parseDiffSize(value: {
  additions?: unknown;
  deletions?: unknown;
  changedFiles?: unknown;
}): DiffSize | null {
  const additions = count(value.additions);
  const deletions = count(value.deletions);
  const changedFiles = count(value.changedFiles);
  if (additions === null || deletions === null || changedFiles === null) return null;
  return { additions, deletions, changedFiles };
}

export function changedLines(size: DiffSize): number {
  return size.additions + size.deletions;
}

export function sizeBucket(lines: number): SizeBucket {
  if (lines < 100) return "small";
  if (lines < 500) return "medium";
  if (lines < 1000) return "large";
  return "xlarge";
}
