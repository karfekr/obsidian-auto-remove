import { describe, expect, it } from "vitest";
import { MAX_TTL_DAYS } from "../../src/domain/types";
import type { FolderRule } from "../../src/domain/types";
import {
  validateDefaultAction,
  validateFolderRule,
  validateSettings,
} from "../../src/domain/validation";
import { DEFAULT_SETTINGS } from "../../src/settings/defaults";

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

describe("validateFolderRule", () => {
  it("accepts a trash rule", () => {
    expect(validateFolderRule(rule())).toBeNull();
  });

  it("accepts a move rule with a destination outside its own folder", () => {
    expect(validateFolderRule(rule({ action: "move", moveDestination: "Archive" }))).toBeNull();
  });

  describe("move without a destination", () => {
    // This is the case the audit called indefensible. It used to resolve to "no
    // policy at all", which silently disabled every note carrying
    // `auto-remove: true`. It is now an explicit configuration error.
    it("is rejected rather than reinterpreted", () => {
      expect(validateFolderRule(rule({ action: "move" }))?.code).toBe("move-without-destination");
    });

    it("is rejected when the destination is only whitespace or slashes", () => {
      expect(validateFolderRule(rule({ action: "move", moveDestination: "  " }))?.code).toBe(
        "move-without-destination",
      );
      expect(validateFolderRule(rule({ action: "move", moveDestination: "///" }))?.code).toBe(
        "move-without-destination",
      );
    });

    it("never suggests deleting instead", () => {
      const message = validateFolderRule(rule({ action: "move" }))?.message ?? "";
      expect(message.toLowerCase()).not.toContain("trash it");
      expect(message.toLowerCase()).toContain("destination");
    });
  });

  describe("destination inside the rule's own folder", () => {
    // A Markdown file escapes because its frontmatter is stripped after the
    // move. An attachment under `scope: "all"` does not, so it is renamed again
    // on every later run, without limit.
    it("is rejected when nested below the rule folder", () => {
      expect(
        validateFolderRule(rule({ action: "move", moveDestination: "Inbox/Archive" }))?.code,
      ).toBe("destination-inside-rule-folder");
    });

    it("is rejected when it is the rule folder itself", () => {
      expect(validateFolderRule(rule({ action: "move", moveDestination: "Inbox" }))?.code).toBe(
        "destination-inside-rule-folder",
      );
    });

    it("rejects any destination under a whole-vault rule", () => {
      expect(
        validateFolderRule(rule({ folder: "", action: "move", moveDestination: "Archive" }))?.code,
      ).toBe("destination-inside-rule-folder");
    });

    it("allows a sibling folder that merely shares a prefix", () => {
      expect(
        validateFolderRule(rule({ action: "move", moveDestination: "Inbox-archive" })),
      ).toBeNull();
    });

    it("allows a destination that contains the rule folder as a substring", () => {
      expect(
        validateFolderRule(rule({ folder: "In", action: "move", moveDestination: "Inbox" })),
      ).toBeNull();
    });
  });

  describe("unsafe destinations", () => {
    // Obsidian's Vault API does not resolve paths inside hidden folders, so a
    // destination of `.trash` would defeat the collision check and move files
    // somewhere the plugin can no longer see them.
    it.each([".trash", ".obsidian", "Archive/.hidden", "..", "../outside", "Archive/../.."])(
      "rejects %s",
      (destination) => {
        expect(
          validateFolderRule(rule({ action: "move", moveDestination: destination }))?.code,
        ).toBe("destination-unsafe");
      },
    );
  });

  describe("time to live", () => {
    it("accepts zero and the maximum", () => {
      expect(validateFolderRule(rule({ ttlDays: 0 }))).toBeNull();
      expect(validateFolderRule(rule({ ttlDays: MAX_TTL_DAYS }))).toBeNull();
    });

    it.each([-1, 1.5, MAX_TTL_DAYS + 1, 1e21])("rejects %s", (ttlDays) => {
      expect(validateFolderRule(rule({ ttlDays }))?.code).toBe("ttl-out-of-range");
    });

    it("reports the TTL problem even when the action is a move", () => {
      expect(
        validateFolderRule(rule({ action: "move", moveDestination: "Archive", ttlDays: -1 }))?.code,
      ).toBe("ttl-out-of-range");
    });
  });
});

describe("validateDefaultAction", () => {
  it("accepts trash", () => {
    expect(validateDefaultAction(DEFAULT_SETTINGS)).toBeNull();
  });

  it("accepts move with a destination", () => {
    expect(
      validateDefaultAction({
        ...DEFAULT_SETTINGS,
        defaultAction: "move",
        defaultMoveDestination: "Archive",
      }),
    ).toBeNull();
  });

  it("rejects move without a destination", () => {
    expect(
      validateDefaultAction({
        ...DEFAULT_SETTINGS,
        defaultAction: "move",
        defaultMoveDestination: "",
      })?.code,
    ).toBe("move-without-destination");
  });

  it("rejects an unsafe destination", () => {
    expect(
      validateDefaultAction({
        ...DEFAULT_SETTINGS,
        defaultAction: "move",
        defaultMoveDestination: ".trash",
      })?.code,
    ).toBe("destination-unsafe");
  });
});

describe("validateSettings", () => {
  it("reports nothing for a usable configuration", () => {
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual([]);
  });

  it("names the offending piece of configuration", () => {
    const problems = validateSettings({
      ...DEFAULT_SETTINGS,
      defaultAction: "move",
      defaultMoveDestination: "",
      folderRules: [rule({ id: "broken", action: "move" })],
    });

    expect(problems.map((problem) => problem.target)).toEqual(["default-action", "rule:broken"]);
    expect(problems.every((problem) => problem.code === "move-without-destination")).toBe(true);
  });

  it("reports one problem per broken rule", () => {
    const problems = validateSettings({
      ...DEFAULT_SETTINGS,
      folderRules: [
        rule({ id: "ok" }),
        rule({ id: "nested", action: "move", moveDestination: "Inbox/Archive" }),
        rule({ id: "unsafe", action: "move", moveDestination: ".trash" }),
      ],
    });

    expect(problems.map((problem) => problem.target)).toEqual(["rule:nested", "rule:unsafe"]);
  });

  it("reports a latent problem on a paused rule too", () => {
    // The settings card is on screen either way, so flagging it now means the
    // user sees the problem before re-enabling rather than after.
    expect(
      validateSettings({
        ...DEFAULT_SETTINGS,
        folderRules: [rule({ enabled: false, action: "move" })],
      }).map((problem) => problem.code),
    ).toEqual(["move-without-destination"]);
  });
});
