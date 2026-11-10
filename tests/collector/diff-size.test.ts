import { describe, expect, test } from "bun:test";
import { changedLines, parseDiffSize, sizeBucket } from "../../scripts/lib/diff-size";

describe("parseDiffSize", () => {
  test("requires a complete non-negative triple", () => {
    expect(parseDiffSize({ additions: 1, deletions: 0, changedFiles: 2 })).toEqual({
      additions: 1,
      deletions: 0,
      changedFiles: 2,
    });
    expect(parseDiffSize({ additions: 1, deletions: 0 })).toBeNull();
    expect(parseDiffSize({ additions: 1.5, deletions: 0, changedFiles: 1 })).toBeNull();
    expect(parseDiffSize({ additions: -1, deletions: 0, changedFiles: 1 })).toBeNull();
  });

  test("line count and buckets", () => {
    expect(changedLines({ additions: 40, deletions: 60, changedFiles: 1 })).toBe(100);
    expect(sizeBucket(0)).toBe("small");
    expect(sizeBucket(99)).toBe("small");
    expect(sizeBucket(100)).toBe("medium");
    expect(sizeBucket(499)).toBe("medium");
    expect(sizeBucket(500)).toBe("large");
    expect(sizeBucket(999)).toBe("large");
    expect(sizeBucket(1000)).toBe("xlarge");
  });
});
