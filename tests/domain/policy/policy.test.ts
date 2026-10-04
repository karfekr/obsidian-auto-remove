import { describe, expect, it } from "vitest";
import { FolderRulePolicySource } from "../../../src/domain/policy/folder-rule-policy-source";
import {
  FrontmatterPolicySource,
  readOptIn,
} from "../../../src/domain/policy/frontmatter-policy-source";
import { PolicyResolver } from "../../../src/domain/policy/policy-resolver";
import type { PolicySource } from "../../../src/domain/policy/policy-source";
import type {
  ExpirationPolicy,
  FileSnapshot,
  FolderRule,
  RemovalAction,
} from "../../../src/domain/types";

/** The policy a source settled on, or `null` for abstain and exempt alike. */
function policyOf(source: PolicySource, file: FileSnapshot): ExpirationPolicy | null {
  const verdict = source.resolve(file);
  return verdict.kind === "expire" ? verdict.policy : null;
}

/** The raw verdict, for the cases where abstain and exempt must be told apart. */
function verdictOf(source: PolicySource, file: FileSnapshot): string {
  return source.resolve(file).kind;
}

const TRASH: RemovalAction = { kind: "trash" };
const MOVE: RemovalAction = { kind: "move", destination: "Archive" };

function markdown(path: string, frontmatter: Record<string, unknown> | null = null): FileSnapshot {
  return { path, extension: "md", mtime: 0, frontmatter };
}

function attachment(path: string, extension: string): FileSnapshot {
  return { path, extension, mtime: 0, frontmatter: null };
}

function rule(overrides: Partial<FolderRule> & Pick<FolderRule, "folder">): FolderRule {
  return {
    id: `rule-${overrides.folder}`,
    enabled: true,
    ttlDays: 30,
    action: "trash",
    moveDestination: "",
    scope: "md",
    ignorePatterns: [],
    ...overrides,
  };
}

function folderRules(rules: FolderRule[], action: RemovalAction = TRASH): FolderRulePolicySource {
  return new FolderRulePolicySource(rules.map((rule) => ({ rule, action })));
}

describe("FrontmatterPolicySource", () => {
  const source = new FrontmatterPolicySource({ ttlDays: 7, action: TRASH });

  it("uses the TTL declared by the note", () => {
    const policy = policyOf(source, markdown("note.md", { "auto-remove": true, ttl: 3 }));
    expect(policy?.ttlDays).toBe(3);
    expect(policy?.origin).toEqual({ source: "frontmatter" });
  });

  it("falls back to the default TTL when the note omits one", () => {
    const policy = policyOf(source, markdown("note.md", { "auto-remove": true }));
    expect(policy?.ttlDays).toBe(7);
  });

  it("falls back to the default TTL when the declared one is unusable", () => {
    const policy = policyOf(source, markdown("note.md", { "auto-remove": true, ttl: "soon" }));
    expect(policy?.ttlDays).toBe(7);
  });

  it("applies the configured default action", () => {
    const moving = new FrontmatterPolicySource({ ttlDays: 7, action: MOVE });
    expect(policyOf(moving, markdown("note.md", { "auto-remove": true }))?.action).toEqual(MOVE);
  });

  it("abstains on a ttl that is not accompanied by an opt-in", () => {
    // The ttl value is ignored, but the note has not refused either — a folder
    // rule may still claim it on its own terms.
    expect(verdictOf(source, markdown("note.md", { ttl: 3 }))).toBe("abstain");
  });

  it("exempts a note that opts out explicitly", () => {
    expect(verdictOf(source, markdown("note.md", { "auto-remove": false }))).toBe("exempt");
    expect(verdictOf(source, markdown("note.md", { "auto-remove": false, ttl: 3 }))).toBe("exempt");
  });

  it("abstains on notes without frontmatter and files that cannot carry any", () => {
    expect(verdictOf(source, markdown("note.md", {}))).toBe("abstain");
    expect(verdictOf(source, markdown("note.md", null))).toBe("abstain");
    expect(verdictOf(source, attachment("board.canvas", "canvas"))).toBe("abstain");
  });

  it("abstains on frontmatter carried by a file that cannot have any", () => {
    // The adapter never reports frontmatter for a non-Markdown file, so this is
    // belt and braces — but the domain refuses to act on the inconsistency
    // rather than trusting a snapshot that says otherwise.
    const impossible = {
      path: "note.png",
      extension: "png",
      mtime: 0,
      frontmatter: { "auto-remove": true },
    };
    expect(verdictOf(source, impossible)).toBe("abstain");
  });

  it("abstains on a value that states neither yes nor no", () => {
    expect(verdictOf(source, markdown("note.md", { "auto-remove": "maybe" }))).toBe("abstain");
    expect(verdictOf(source, markdown("note.md", { "auto-remove": 1 }))).toBe("abstain");
  });
});

describe("readOptIn", () => {
  it.each([
    [true, true],
    ["true", true],
    ["  TRUE  ", true],
    ["yes", true],
    ["on", true],
    [false, false],
    ["false", false],
    ["no", false],
    ["off", false],
    ["maybe", null],
    [1, null],
    [null, null],
    [undefined, null],
  ])("%o → %s", (value, expected) => {
    expect(readOptIn(value)).toBe(expected);
  });
});

describe("FolderRulePolicySource", () => {
  it("claims files inside the configured folder", () => {
    const source = folderRules([rule({ folder: "Inbox", ttlDays: 14 })]);
    const policy = policyOf(source, markdown("Inbox/note.md"));

    expect(policy?.ttlDays).toBe(14);
    expect(policy?.origin).toEqual({
      source: "folder-rule",
      ruleId: "rule-Inbox",
      folder: "Inbox",
    });
  });

  it("leaves files outside every rule alone", () => {
    const source = folderRules([rule({ folder: "Inbox" })]);
    expect(policyOf(source, markdown("Projects/note.md"))).toBeNull();
  });

  describe("file scope", () => {
    // `scope` defaults to `md`. The previous behaviour — claiming attachments —
    // is only reachable by asking for it explicitly, because only Markdown files
    // carry the frontmatter a move strips, so an attachment moved into a folder
    // its own rule covers would be renamed again on every later run.
    it("claims a Markdown file under the default scope", () => {
      const source = folderRules([rule({ folder: "Inbox" })]);
      expect(policyOf(source, markdown("Inbox/note.md"))).not.toBeNull();
    });

    it("does not claim an attachment under the default scope", () => {
      const source = folderRules([rule({ folder: "Inbox" })]);
      expect(verdictOf(source, attachment("Inbox/scan.pdf", "pdf"))).toBe("abstain");
    });

    it("claims an attachment when the rule opts into every file", () => {
      const source = folderRules([rule({ folder: "Inbox", scope: "all" })]);
      expect(policyOf(source, attachment("Inbox/scan.pdf", "pdf"))).not.toBeNull();
    });

    it("still claims Markdown files when the rule opts into every file", () => {
      const source = folderRules([rule({ folder: "Inbox", scope: "all" })]);
      expect(policyOf(source, markdown("Inbox/note.md"))).not.toBeNull();
    });

    it("lets a shallower rule claim an attachment the deeper rule does not cover", () => {
      // Scope narrows a rule in the same way `enabled` does: it makes the file
      // none of that rule's business, rather than vetoing it for everyone.
      const source = folderRules([
        rule({ folder: "Inbox", scope: "all" }),
        rule({ folder: "Inbox/drafts", scope: "md" }),
      ]);

      expect(policyOf(source, attachment("Inbox/drafts/scan.pdf", "pdf"))?.origin).toEqual({
        source: "folder-rule",
        ruleId: "rule-Inbox",
        folder: "Inbox",
      });
    });

    it("matches a .canvas only when the rule covers every file", () => {
      expect(
        verdictOf(folderRules([rule({ folder: "Inbox" })]), attachment("Inbox/b.canvas", "canvas")),
      ).toBe("abstain");
      expect(
        verdictOf(
          folderRules([rule({ folder: "Inbox", scope: "all" })]),
          attachment("Inbox/b.canvas", "canvas"),
        ),
      ).toBe("expire");
    });
  });

  it("applies a root rule to the whole vault", () => {
    const source = folderRules([rule({ folder: "" })]);
    expect(policyOf(source, markdown("note.md"))).not.toBeNull();
    expect(policyOf(source, markdown("deep/nested/note.md"))).not.toBeNull();
  });

  it("lets the deepest rule win when rules nest", () => {
    const source = folderRules([
      rule({ folder: "Inbox", ttlDays: 30 }),
      rule({ folder: "Inbox/drafts", ttlDays: 3 }),
    ]);

    expect(policyOf(source, markdown("Inbox/note.md"))?.ttlDays).toBe(30);
    expect(policyOf(source, markdown("Inbox/drafts/note.md"))?.ttlDays).toBe(3);
  });

  it("skips disabled rules and falls through to the next match", () => {
    const source = folderRules([
      rule({ folder: "Inbox", ttlDays: 30 }),
      rule({ folder: "Inbox/drafts", ttlDays: 3, enabled: false }),
    ]);

    expect(policyOf(source, markdown("Inbox/drafts/note.md"))?.ttlDays).toBe(30);
  });

  it("excludes paths matched by the rule ignore patterns", () => {
    const source = folderRules([
      rule({ folder: "Inbox", ignorePatterns: ["Templates/**", "*.pdf"] }),
    ]);

    expect(policyOf(source, markdown("Inbox/Templates/daily.md"))).toBeNull();
    expect(policyOf(source, attachment("Inbox/scan.pdf", "pdf"))).toBeNull();
    expect(policyOf(source, markdown("Inbox/note.md"))).not.toBeNull();
  });

  it("matches ignore patterns relative to the rule folder", () => {
    // The same pattern means different things depending on the folder that
    // owns it: under `Inbox` it is `Inbox/Templates`, at the root it is the
    // top-level `Templates`.
    const scoped = folderRules([rule({ folder: "Inbox", ignorePatterns: ["Templates/**"] })]);
    expect(policyOf(scoped, markdown("Inbox/Templates/daily.md"))).toBeNull();

    const atRoot = folderRules([rule({ folder: "", ignorePatterns: ["Templates/**"] })]);
    expect(policyOf(atRoot, markdown("Templates/daily.md"))).toBeNull();
    expect(policyOf(atRoot, markdown("Inbox/Templates/daily.md"))).not.toBeNull();
  });

  it("anchors a pattern containing a slash, exactly as gitignore does", () => {
    // `Templates/**` is anchored to the rule folder, so a nested `Templates`
    // is untouched; `**/Templates/**` is how you catch it at any depth.
    const anchored = folderRules([rule({ folder: "Inbox", ignorePatterns: ["Templates/**"] })]);
    expect(policyOf(anchored, markdown("Inbox/notes/Templates/daily.md"))).not.toBeNull();

    const everywhere = folderRules([
      rule({ folder: "Inbox", ignorePatterns: ["**/Templates/**"] }),
    ]);
    expect(policyOf(everywhere, markdown("Inbox/notes/Templates/daily.md"))).toBeNull();
  });

  it("honours negation patterns", () => {
    const source = folderRules([
      rule({ folder: "Inbox", ignorePatterns: ["Templates/**", "!Templates/keep.md"] }),
    ]);

    expect(policyOf(source, markdown("Inbox/Templates/daily.md"))).toBeNull();
    expect(policyOf(source, markdown("Inbox/Templates/keep.md"))).not.toBeNull();
  });

  it("does not let an outer rule reclaim what an inner rule ignored", () => {
    const source = folderRules([
      rule({ folder: "", ttlDays: 30 }),
      rule({ folder: "Templates", ignorePatterns: ["**"] }),
    ]);

    expect(policyOf(source, markdown("Templates/daily.md"))).toBeNull();
  });

  it("uses the action bound to each individual rule", () => {
    const source = new FolderRulePolicySource([
      { rule: rule({ folder: "Inbox" }), action: MOVE },
      { rule: rule({ folder: "Logs" }), action: TRASH },
    ]);

    expect(policyOf(source, markdown("Inbox/note.md"))?.action).toEqual(MOVE);
    expect(policyOf(source, markdown("Logs/note.md"))?.action).toEqual(TRASH);
  });
});

describe("PolicyResolver", () => {
  const frontmatter = new FrontmatterPolicySource({ ttlDays: 7, action: TRASH });

  it("prefers frontmatter over a folder rule", () => {
    const resolver = new PolicyResolver([
      frontmatter,
      folderRules([rule({ folder: "Inbox", ttlDays: 30 })]),
    ]);

    const policy = resolver.resolve(markdown("Inbox/note.md", { "auto-remove": true, ttl: 2 }));
    expect(policy?.ttlDays).toBe(2);
    expect(policy?.origin.source).toBe("frontmatter");
  });

  it("falls back to a folder rule when frontmatter says nothing", () => {
    const resolver = new PolicyResolver([
      frontmatter,
      folderRules([rule({ folder: "Inbox", ttlDays: 30 })]),
    ]);

    expect(resolver.resolve(markdown("Inbox/note.md"))?.origin.source).toBe("folder-rule");
  });

  it("lets an opt-in override the folder ignore patterns that would exclude it", () => {
    // Frontmatter outranks folder rules, and ignore patterns only ever narrow a
    // folder rule — so an explicit opt-in inside an ignored folder still expires.
    const resolver = new PolicyResolver([
      frontmatter,
      folderRules([rule({ folder: "", ttlDays: 30, ignorePatterns: ["Templates/**"] })]),
    ]);

    expect(resolver.resolve(markdown("Templates/daily.md"))).toBeNull();
    expect(resolver.resolve(markdown("Templates/keep.md", { "auto-remove": true }))?.ttlDays).toBe(
      7,
    );
  });

  it("lets an explicit opt-out veto the folder rule covering it", () => {
    // Without this, `auto-remove: false` would be meaningless: it is the only
    // way to exempt a single note from a rule covering its folder.
    const resolver = new PolicyResolver([
      frontmatter,
      folderRules([rule({ folder: "Inbox", ttlDays: 30 })]),
    ]);

    expect(resolver.resolve(markdown("Inbox/note.md", { "auto-remove": false }))).toBeNull();
    expect(
      resolver.resolve(markdown("Inbox/note.md", { "auto-remove": false, ttl: 1 })),
    ).toBeNull();
  });

  it("still lets a folder rule claim a note carrying only a stray ttl", () => {
    // The `ttl` is ignored — the folder's own TTL applies — but the note never
    // said "leave me alone", so there is nothing to respect.
    const resolver = new PolicyResolver([
      frontmatter,
      folderRules([rule({ folder: "Inbox", ttlDays: 30 })]),
    ]);

    const policy = resolver.resolve(markdown("Inbox/note.md", { ttl: 1 }));
    expect(policy?.ttlDays).toBe(30);
    expect(policy?.origin.source).toBe("folder-rule");
  });

  it("leaves a file alone when no source claims it", () => {
    const resolver = new PolicyResolver([frontmatter, folderRules([])]);
    expect(resolver.resolve(markdown("note.md"))).toBeNull();
  });

  it("returns null when there are no sources at all", () => {
    expect(new PolicyResolver([]).resolve(markdown("note.md"))).toBeNull();
  });
});
