import { describe, expect, it } from "vitest";
import { expiresAt, isExpired, parseTtlDays, toExpiredFile } from "../../src/domain/expiration";
import { MILLISECONDS_PER_DAY } from "../../src/domain/types";
import type { ExpirationPolicy, FileSnapshot } from "../../src/domain/types";

const NOW = Date.UTC(2026, 0, 15);

function snapshot(mtime: number): FileSnapshot {
  return { path: "note.md", extension: "md", mtime, frontmatter: null };
}

function policy(ttlDays: number): ExpirationPolicy {
  return { ttlDays, action: { kind: "trash" }, origin: { source: "frontmatter" } };
}

describe("expiresAt", () => {
  it("adds the TTL to the modification time", () => {
    expect(expiresAt(NOW, 3)).toBe(NOW + 3 * MILLISECONDS_PER_DAY);
  });
});

describe("isExpired", () => {
  it("is false while the file is younger than its TTL", () => {
    const file = snapshot(NOW - 2 * MILLISECONDS_PER_DAY);
    expect(isExpired(file, policy(3), NOW)).toBe(false);
  });

  it("is true exactly at the TTL boundary", () => {
    const file = snapshot(NOW - 3 * MILLISECONDS_PER_DAY);
    expect(isExpired(file, policy(3), NOW)).toBe(true);
  });

  it("is true once the file is older than its TTL", () => {
    const file = snapshot(NOW - 10 * MILLISECONDS_PER_DAY);
    expect(isExpired(file, policy(3), NOW)).toBe(true);
  });

  it("treats a TTL of zero as expiring immediately", () => {
    expect(isExpired(snapshot(NOW), policy(0), NOW)).toBe(true);
  });

  it("does not expire a file modified in the future", () => {
    const file = snapshot(NOW + MILLISECONDS_PER_DAY);
    expect(isExpired(file, policy(0), NOW)).toBe(false);
  });
});

describe("toExpiredFile", () => {
  it("records when the file expired and how old it is", () => {
    const file = snapshot(NOW - 5 * MILLISECONDS_PER_DAY);
    const expired = toExpiredFile(file, policy(3), NOW);

    expect(expired.expiredAt).toBe(file.mtime + 3 * MILLISECONDS_PER_DAY);
    expect(expired.ageMs).toBe(5 * MILLISECONDS_PER_DAY);
  });
});

describe("parseTtlDays", () => {
  it("accepts non-negative integers", () => {
    expect(parseTtlDays(0)).toBe(0);
    expect(parseTtlDays(7)).toBe(7);
  });

  it("accepts numeric strings, since YAML quoting is easy to get wrong", () => {
    expect(parseTtlDays("7")).toBe(7);
    expect(parseTtlDays(" 7 ")).toBe(7);
  });

  it.each([
    ["a negative number", -1],
    ["a fractional number", 1.5],
    ["an empty string", ""],
    ["a blank string", "   "],
    ["a non-numeric string", "soon"],
    ["a boolean", true],
    ["null", null],
    ["undefined", undefined],
    ["NaN", NaN],
  ])("rejects %s so the default TTL applies instead", (_label, value) => {
    expect(parseTtlDays(value)).toBeNull();
  });
});
