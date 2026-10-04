import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../../src/settings/defaults";
import {
  buildPolicyResolver,
  createPolicyResolver,
} from "../../../src/domain/policy/resolver-factory";
import type { AutoRemoveSettings, FileSnapshot, FolderRule } from "../../../src/domain/types";

function settings(overrides: Partial<AutoRemoveSettings> = {}): AutoRemoveSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
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

function file(path: string, frontmatter: Record<string, unknown> | null = null): FileSnapshot {
  return { path, extension: "md", mtime: 0, frontmatter };
}

describe("createPolicyResolver", () => {
  it("wires frontmatter ahead of folder rules", () => {
    const resolver = createPolicyResolver(
      settings({ folderRules: [rule({ folder: "Inbox", ttlDays: 30 })] }),
    );

    expect(resolver.resolve(file("Inbox/a.md", { "auto-remove": true, ttl: 2 }))?.ttlDays).toBe(2);
    expect(resolver.resolve(file("Inbox/b.md"))?.ttlDays).toBe(30);
  });

  it("gives frontmatter notes the configured default action", () => {
    const resolver = createPolicyResolver(
      settings({ defaultAction: "move", defaultMoveDestination: "Archive" }),
    );

    expect(resolver.resolve(file("a.md", { "auto-remove": true }))?.action).toEqual({
      kind: "move",
      destination: "Archive",
    });
  });

  it("disables frontmatter opt-in when the default action is unusable", () => {
    // Move with no destination cannot run, so no file is claimed rather than
    // being claimed and then failing at execution time.
    const resolver = createPolicyResolver(
      settings({ defaultAction: "move", defaultMoveDestination: "" }),
    );

    expect(resolver.resolve(file("a.md", { "auto-remove": true }))).toBeNull();
  });

  it("drops folder rules that move without a destination", () => {
    const resolver = createPolicyResolver(
      settings({ folderRules: [rule({ folder: "Inbox", action: "move", moveDestination: "" })] }),
    );

    expect(resolver.resolve(file("Inbox/a.md"))).toBeNull();
  });

  it("keeps folder rules that move to a configured destination", () => {
    const resolver = createPolicyResolver(
      settings({
        folderRules: [rule({ folder: "Inbox", action: "move", moveDestination: "Archive" })],
      }),
    );

    expect(resolver.resolve(file("Inbox/a.md"))?.action).toEqual({
      kind: "move",
      destination: "Archive",
    });
  });

  it("claims nothing when nothing is configured", () => {
    const resolver = createPolicyResolver(settings());
    expect(resolver.resolve(file("a.md"))).toBeNull();
  });
});

describe("buildPolicyResolver — configuration problems", () => {
  // `createPolicyResolver` alone cannot express any of this: it answers "what
  // does this rule claim", and the failure mode the audit found was precisely
  // that an unusable rule claimed nothing *silently*. Reporting the problem is
  // what makes the difference visible.

  it("reports no problems for a usable configuration", () => {
    expect(buildPolicyResolver(settings()).problems).toEqual([]);
  });

  it("reports a default action that cannot be carried out", () => {
    const { resolver, problems } = buildPolicyResolver(
      settings({ defaultAction: "move", defaultMoveDestination: "" }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]?.target).toBe("default-action");
    expect(problems[0]?.code).toBe("move-without-destination");
    expect(resolver.resolve(file("a.md", { "auto-remove": true }))).toBeNull();
  });

  it("never turns an invalid move into a deletion", () => {
    // The single most important guarantee in this file: an unusable move
    // produces no policy at all, so nothing is claimed — and nothing can be
    // trashed by a fallback nobody asked for.
    const { resolver } = buildPolicyResolver(
      settings({ defaultAction: "move", defaultMoveDestination: "   " }),
    );

    const claimed = resolver.resolve(file("a.md", { "auto-remove": true }));
    expect(claimed).toBeNull();
  });

  it("still honours frontmatter opt-out while the default action is broken", () => {
    const { resolver } = buildPolicyResolver(settings({ defaultAction: "move" }));

    // Nothing is claimed either way, so the exemption cannot be distinguished
    // from the misconfiguration by resolve() alone — which is why the problem
    // list exists.
    expect(resolver.resolve(file("a.md", { "auto-remove": false }))).toBeNull();
  });

  it("reports a folder rule whose destination is inside its own folder, and does not bind it", () => {
    const { resolver, problems } = buildPolicyResolver(
      settings({
        folderRules: [rule({ folder: "Inbox", action: "move", moveDestination: "Inbox/Archive" })],
      }),
    );

    expect(problems.map((problem) => problem.code)).toEqual(["destination-inside-rule-folder"]);
    expect(resolver.resolve(file("Inbox/a.md"))).toBeNull();
  });

  it("reports a folder rule with an unsafe destination, and does not bind it", () => {
    const { resolver, problems } = buildPolicyResolver(
      settings({
        folderRules: [rule({ folder: "Inbox", action: "move", moveDestination: ".trash" })],
      }),
    );

    expect(problems.map((problem) => problem.code)).toEqual(["destination-unsafe"]);
    expect(resolver.resolve(file("Inbox/a.md"))).toBeNull();
  });

  it("keeps the usable rules around a broken one", () => {
    const { resolver, problems } = buildPolicyResolver(
      settings({
        folderRules: [rule({ folder: "Logs" }), rule({ folder: "Inbox", action: "move" })],
      }),
    );

    expect(problems.map((problem) => problem.target)).toEqual(["rule:rule-Inbox"]);
    expect(resolver.resolve(file("Logs/a.md"))?.origin).toMatchObject({ folder: "Logs" });
    expect(resolver.resolve(file("Inbox/a.md"))).toBeNull();
  });
});
