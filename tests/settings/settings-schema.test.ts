import { describe, expect, it } from "vitest";
import { toRemovalAction } from "../../src/domain/removal-action";
import { DEFAULT_SETTINGS, DEFAULT_TTL_DAYS } from "../../src/settings/defaults";
import {
  describeRuleProblem,
  parseSettings,
  splitPatternLines,
} from "../../src/settings/settings-schema";
import type { FolderRule } from "../../src/domain/types";

function rule(overrides: Partial<FolderRule> = {}): FolderRule {
  return {
    id: "rule-1",
    enabled: true,
    folder: "Inbox",
    ttlDays: 7,
    action: "trash",
    moveDestination: "",
    scope: "md",
    ignorePatterns: [],
    ...overrides,
  };
}

describe("parseSettings", () => {
  it("falls back to defaults for missing or malformed data", () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("nonsense")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings([])).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps values it recognises", () => {
    const parsed = parseSettings({
      defaultTtlDays: 21,
      defaultAction: "move",
      defaultMoveDestination: "/Archive/",
      debugLogging: true,
    });

    expect(parsed.defaultTtlDays).toBe(21);
    expect(parsed.defaultAction).toBe("move");
    expect(parsed.defaultMoveDestination).toBe("Archive");
    expect(parsed.debugLogging).toBe(true);
  });

  it("replaces an unusable TTL with the default rather than expiring early", () => {
    expect(parseSettings({ defaultTtlDays: -5 }).defaultTtlDays).toBe(DEFAULT_TTL_DAYS);
    expect(parseSettings({ defaultTtlDays: "soon" }).defaultTtlDays).toBe(DEFAULT_TTL_DAYS);
    expect(parseSettings({ defaultTtlDays: 1.5 }).defaultTtlDays).toBe(DEFAULT_TTL_DAYS);
  });

  it("replaces a TTL beyond the supported range rather than never expiring", () => {
    // `Number.isInteger(1e21)` is true, so without a ceiling this produced an
    // expiry no clock would reach: a note that looks configured and never fires.
    expect(parseSettings({ defaultTtlDays: 1e21 }).defaultTtlDays).toBe(DEFAULT_TTL_DAYS);
    expect(
      parseSettings({ folderRules: [{ folder: "Inbox", ttlDays: 1e21 }] }).folderRules[0]?.ttlDays,
    ).toBe(DEFAULT_TTL_DAYS);
  });

  it("treats an unrecognised action as trash", () => {
    expect(parseSettings({ defaultAction: "incinerate" }).defaultAction).toBe("trash");
  });

  it("defaults debug logging off unless explicitly enabled", () => {
    expect(parseSettings({}).debugLogging).toBe(false);
    expect(parseSettings({ debugLogging: "yes" }).debugLogging).toBe(false);
  });

  it("reads the file scope, treating anything but an explicit `all` as markdown", () => {
    const parsed = parseSettings({
      folderRules: [
        { id: "a", folder: "Inbox", scope: "all" },
        { id: "b", folder: "Logs", scope: "everything" },
        { id: "c", folder: "Notes" },
      ],
    });

    expect(parsed.folderRules.map((entry) => entry.scope)).toEqual(["all", "md", "md"]);
  });

  it("ignores a leftover trigger list from an older version", () => {
    // The setting no longer exists: reconciliation is always on. Reading it as
    // `undefined` keeps an old `data.json` loadable without inventing behaviour.
    expect(parseSettings({ triggers: ["startup"] })).toEqual(DEFAULT_SETTINGS);
  });

  it("normalises folder rules and skips non-object entries", () => {
    const parsed = parseSettings({
      folderRules: [
        { id: "a", folder: "/Inbox/", ttlDays: 3, action: "move", moveDestination: "Archive/" },
        "not a rule",
        null,
      ],
    });

    expect(parsed.folderRules).toEqual([
      {
        id: "a",
        enabled: true,
        folder: "Inbox",
        ttlDays: 3,
        action: "move",
        moveDestination: "Archive",
        scope: "md",
        ignorePatterns: [],
      },
    ]);
  });

  it("accepts ignore patterns as an array or as newline-separated text", () => {
    const fromArray = parseSettings({ folderRules: [{ ignorePatterns: ["*.pdf", 42] }] });
    expect(fromArray.folderRules[0]?.ignorePatterns).toEqual(["*.pdf"]);

    const fromText = parseSettings({ folderRules: [{ ignorePatterns: "*.pdf\n\n  *.canvas  " }] });
    expect(fromText.folderRules[0]?.ignorePatterns).toEqual(["*.pdf", "*.canvas"]);
  });

  it("gives a rule an id when one is missing, so the UI can track it", () => {
    const parsed = parseSettings({ folderRules: [{ folder: "Inbox" }] });
    expect(parsed.folderRules[0]?.id).toBeTruthy();
  });

  it("always stamps the current schema version", () => {
    expect(parseSettings({ schemaVersion: 0 }).schemaVersion).toBe(DEFAULT_SETTINGS.schemaVersion);
  });
});

describe("toRemovalAction", () => {
  it("resolves trash unconditionally", () => {
    expect(toRemovalAction("trash", "")).toEqual({ kind: "trash" });
  });

  it("resolves move only when a destination is configured", () => {
    expect(toRemovalAction("move", "Archive")).toEqual({ kind: "move", destination: "Archive" });
    expect(toRemovalAction("move", "/Archive/")).toEqual({ kind: "move", destination: "Archive" });
    expect(toRemovalAction("move", "")).toBeNull();
    expect(toRemovalAction("move", "  ")).toBeNull();
  });
});

describe("describeRuleProblem", () => {
  it("accepts a usable rule", () => {
    expect(describeRuleProblem(rule())).toBeNull();
    expect(describeRuleProblem(rule({ action: "move", moveDestination: "Archive" }))).toBeNull();
  });

  it("reports a move with no destination", () => {
    expect(describeRuleProblem(rule({ action: "move" }))).toContain("destination");
  });

  it("reports a destination nested inside the rule folder, which would re-expire", () => {
    const nested = rule({ folder: "Inbox", action: "move", moveDestination: "Inbox/Archive" });
    expect(describeRuleProblem(nested)).toContain("inside");

    const itself = rule({ folder: "Inbox", action: "move", moveDestination: "Inbox" });
    expect(describeRuleProblem(itself)).toContain("inside");
  });

  it("reports any destination under a whole-vault rule", () => {
    const wholeVault = rule({ folder: "", action: "move", moveDestination: "Archive" });
    expect(describeRuleProblem(wholeVault)).toContain("inside");
  });

  it("accepts a sibling destination that only shares a prefix", () => {
    const sibling = rule({ folder: "Inbox", action: "move", moveDestination: "Inbox-archive" });
    expect(describeRuleProblem(sibling)).toBeNull();
  });
});

describe("splitPatternLines", () => {
  it("trims and drops blank lines", () => {
    expect(splitPatternLines("*.pdf\n\n  Templates/**  \n")).toEqual(["*.pdf", "Templates/**"]);
  });
});
