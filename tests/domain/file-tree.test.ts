import { describe, expect, it } from "vitest";
import {
  buildTree,
  collapseSingleChildFolders,
  collectFilePaths,
} from "../../src/domain/file-tree";
import type { FolderNode } from "../../src/domain/file-tree";
import type { ExpiredFile } from "../../src/domain/types";

function expired(path: string): ExpiredFile {
  return {
    file: { path, extension: "md", mtime: 0, frontmatter: null },
    policy: { ttlDays: 1, action: { kind: "trash" }, origin: { source: "frontmatter" } },
    expiredAt: 0,
    ageMs: 0,
  };
}

/** Renders the tree as indented text, so assertions read like the dialog looks. */
function outline(node: FolderNode): string {
  const lines: string[] = [];
  const walk = (current: FolderNode, indent: string): void => {
    for (const child of current.children) {
      lines.push(`${indent}${child.name}`);
      if (child.kind === "folder") walk(child, `${indent}  `);
    }
  };
  walk(node, "");
  return lines.join("\n");
}

describe("buildTree", () => {
  it("groups files under their folders", () => {
    const tree = buildTree([
      expired("Inbox/ideas/note1.md"),
      expired("Inbox/ideas/note2.md"),
      expired("Inbox/drafts/old.md"),
    ]);

    expect(outline(tree)).toBe(
      ["Inbox", "  drafts", "    old.md", "  ideas", "    note1.md", "    note2.md"].join("\n"),
    );
  });

  it("places top-level files directly under the root", () => {
    const tree = buildTree([expired("note.md")]);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]?.name).toBe("note.md");
  });

  it("sorts folders before files, then alphabetically", () => {
    const tree = buildTree([expired("zebra.md"), expired("alpha.md"), expired("Folder/inner.md")]);
    expect(tree.children.map((child) => child.name)).toEqual(["Folder", "alpha.md", "zebra.md"]);
  });

  it("sorts numerically so note10 follows note2", () => {
    const tree = buildTree([expired("note10.md"), expired("note2.md")]);
    expect(tree.children.map((child) => child.name)).toEqual(["note2.md", "note10.md"]);
  });

  it("gives every node its full vault path", () => {
    const tree = buildTree([expired("Inbox/ideas/note.md")]);
    const inbox = tree.children[0];
    expect(inbox?.path).toBe("Inbox");
    expect(inbox?.kind === "folder" && inbox.children[0]?.path).toBe("Inbox/ideas");
  });

  it("produces an empty root for an empty input", () => {
    expect(buildTree([]).children).toEqual([]);
  });
});

describe("collapseSingleChildFolders", () => {
  it("joins a chain of single-child folders into one row", () => {
    const tree = collapseSingleChildFolders(buildTree([expired("a/b/c/note.md")]));
    expect(outline(tree)).toBe(["a/b/c", "  note.md"].join("\n"));
  });

  it("stops collapsing where a folder branches", () => {
    const tree = collapseSingleChildFolders(
      buildTree([expired("a/b/one.md"), expired("a/b/two.md")]),
    );
    expect(outline(tree)).toBe(["a/b", "  one.md", "  two.md"].join("\n"));
  });

  it("preserves the collapsed folder’s real vault path", () => {
    const tree = collapseSingleChildFolders(buildTree([expired("a/b/c/note.md")]));
    expect(tree.children[0]?.path).toBe("a/b/c");
  });
});

describe("collectFilePaths", () => {
  it("gathers every descendant file path", () => {
    const tree = buildTree([expired("a/one.md"), expired("a/b/two.md"), expired("c/three.md")]);
    expect(collectFilePaths(tree).sort()).toEqual(["a/b/two.md", "a/one.md", "c/three.md"]);
  });

  it("returns a single path for a file node", () => {
    const tree = buildTree([expired("note.md")]);
    const file = tree.children[0];
    expect(file && collectFilePaths(file)).toEqual(["note.md"]);
  });
});
