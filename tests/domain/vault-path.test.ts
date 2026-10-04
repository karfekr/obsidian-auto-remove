import { describe, expect, it } from "vitest";
import {
  basename,
  depth,
  extensionOf,
  isInsideFolder,
  joinPath,
  normalizeFolder,
  parentFolder,
  relativeToFolder,
  splitExtension,
  VAULT_ROOT,
} from "../../src/domain/vault-path";

describe("normalizeFolder", () => {
  it("strips leading, trailing and duplicated slashes", () => {
    expect(normalizeFolder("/Inbox//drafts/")).toBe("Inbox/drafts");
  });

  it("maps every spelling of the root onto the empty string", () => {
    expect(normalizeFolder("/")).toBe(VAULT_ROOT);
    expect(normalizeFolder("")).toBe(VAULT_ROOT);
    expect(normalizeFolder("   ")).toBe(VAULT_ROOT);
  });

  it("trims each segment, since these paths come from text boxes", () => {
    expect(normalizeFolder(" Inbox / drafts ")).toBe("Inbox/drafts");
  });
});

describe("isInsideFolder", () => {
  it("places every file inside the vault root", () => {
    expect(isInsideFolder("note.md", VAULT_ROOT)).toBe(true);
    expect(isInsideFolder("a/b/note.md", "/")).toBe(true);
  });

  it("matches nested paths at any depth", () => {
    expect(isInsideFolder("Inbox/a/b/note.md", "Inbox")).toBe(true);
  });

  it("does not match a sibling folder sharing a prefix", () => {
    expect(isInsideFolder("Inbox-archive/note.md", "Inbox")).toBe(false);
  });

  it("does not treat a folder as being inside itself", () => {
    expect(isInsideFolder("Inbox", "Inbox")).toBe(false);
  });
});

describe("relativeToFolder", () => {
  it("returns the path unchanged for the vault root", () => {
    expect(relativeToFolder("Inbox/note.md", VAULT_ROOT)).toBe("Inbox/note.md");
  });

  it("strips the folder prefix", () => {
    expect(relativeToFolder("Inbox/a/note.md", "Inbox")).toBe("a/note.md");
    expect(relativeToFolder("Inbox/a/note.md", "/Inbox/")).toBe("a/note.md");
  });

  it("returns null when the path is outside the folder", () => {
    expect(relativeToFolder("Other/note.md", "Inbox")).toBeNull();
  });
});

describe("depth", () => {
  it("ranks nested folders above shallow ones", () => {
    expect(depth(VAULT_ROOT)).toBe(0);
    expect(depth("Inbox")).toBe(1);
    expect(depth("Inbox/drafts")).toBe(2);
  });
});

describe("basename and parentFolder", () => {
  it("splits a nested path", () => {
    expect(basename("Inbox/drafts/note.md")).toBe("note.md");
    expect(parentFolder("Inbox/drafts/note.md")).toBe("Inbox/drafts");
  });

  it("treats a top-level file as living in the root", () => {
    expect(basename("note.md")).toBe("note.md");
    expect(parentFolder("note.md")).toBe(VAULT_ROOT);
  });
});

describe("joinPath", () => {
  it("skips empty parts so the root joins cleanly", () => {
    expect(joinPath(VAULT_ROOT, "Inbox")).toBe("Inbox");
    expect(joinPath("Inbox", "", "note.md")).toBe("Inbox/note.md");
  });
});

describe("extensionOf", () => {
  it("lower-cases the extension and drops the dot", () => {
    expect(extensionOf("Inbox/Note.MD")).toBe("md");
  });

  it("returns an empty string when there is no extension", () => {
    expect(extensionOf("Inbox/README")).toBe("");
  });

  it("does not treat a dotfile as an extension", () => {
    expect(extensionOf(".gitignore")).toBe("");
  });
});

describe("splitExtension", () => {
  it("separates the stem from the suffix", () => {
    expect(splitExtension("note.md")).toEqual({ stem: "note", suffix: ".md" });
    expect(splitExtension("archive.tar.gz")).toEqual({ stem: "archive.tar", suffix: ".gz" });
    expect(splitExtension("README")).toEqual({ stem: "README", suffix: "" });
  });
});
