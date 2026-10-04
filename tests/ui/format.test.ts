import { describe, expect, it } from "vitest";
import { MILLISECONDS_PER_DAY } from "../../src/domain/types";
import { describeOrigin, formatAge, formatTtl, pluralize } from "../../src/ui/format";

describe("formatAge", () => {
  it("describes anything under a day as today", () => {
    expect(formatAge(0)).toBe("today");
    expect(formatAge(MILLISECONDS_PER_DAY - 1)).toBe("today");
  });

  it("counts whole days", () => {
    expect(formatAge(MILLISECONDS_PER_DAY)).toBe("yesterday");
    expect(formatAge(12 * MILLISECONDS_PER_DAY)).toBe("12 days ago");
  });
});

describe("formatTtl", () => {
  it.each([
    [0, "immediately"],
    [1, "1 day"],
    [7, "7 days"],
  ])("%i → %s", (days, expected) => {
    expect(formatTtl(days)).toBe(expected);
  });
});

describe("describeOrigin", () => {
  it("names frontmatter", () => {
    expect(describeOrigin({ source: "frontmatter" })).toBe("Frontmatter");
  });

  it("names the folder a rule covers", () => {
    expect(describeOrigin({ source: "folder-rule", ruleId: "a", folder: "Inbox" })).toBe(
      "Rule: Inbox",
    );
  });

  it("spells out a rule covering the whole vault", () => {
    expect(describeOrigin({ source: "folder-rule", ruleId: "a", folder: "" })).toBe("Vault rule");
  });
});

describe("pluralize", () => {
  it("agrees with the count", () => {
    expect(pluralize(1, "file")).toBe("1 file");
    expect(pluralize(2, "file")).toBe("2 files");
    expect(pluralize(0, "file")).toBe("0 files");
  });

  it("accepts an irregular plural", () => {
    expect(pluralize(2, "entry", "entries")).toBe("2 entries");
  });
});
