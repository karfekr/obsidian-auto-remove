import { describe, expect, it } from "vitest";
import { buildTree } from "../../src/domain/file-tree";
import type { FolderNode } from "../../src/domain/file-tree";
import { TreeSelection } from "../../src/ui/tree-selection";
import type { ExpiredFile } from "../../src/domain/types";

function expired(path: string): ExpiredFile {
  return {
    file: { path, extension: "md", mtime: 0, frontmatter: null },
    policy: { ttlDays: 1, action: { kind: "trash" }, origin: { source: "frontmatter" } },
    expiredAt: 0,
    ageMs: 0,
  };
}

function tree(...paths: string[]): FolderNode {
  return buildTree(paths.map(expired));
}

function folderNamed(root: FolderNode, name: string): FolderNode {
  const found = root.children.find(
    (child): child is FolderNode => child.kind === "folder" && child.name === name,
  );
  if (found === undefined) throw new Error(`No folder named ${name}`);
  return found;
}

describe("TreeSelection", () => {
  it("starts with everything selected", () => {
    const root = tree("a/one.md", "a/two.md", "b/three.md");
    const selection = TreeSelection.selectAll(root);

    expect(selection.size).toBe(3);
    expect(selection.stateOf(root)).toBe("checked");
  });

  it("reports a folder as partial when only some children are selected", () => {
    const root = tree("a/one.md", "a/two.md");
    const selection = TreeSelection.selectAll(root);

    selection.setFile("a/one.md", false);

    expect(selection.stateOf(folderNamed(root, "a"))).toBe("partial");
    expect(selection.stateOf(root)).toBe("partial");
  });

  it("reports a folder as unchecked once every child is deselected", () => {
    const root = tree("a/one.md", "a/two.md");
    const selection = TreeSelection.selectAll(root);

    selection.setFile("a/one.md", false);
    selection.setFile("a/two.md", false);

    expect(selection.stateOf(folderNamed(root, "a"))).toBe("unchecked");
    expect(selection.size).toBe(0);
  });

  it("cascades a folder toggle to every descendant", () => {
    const root = tree("a/one.md", "a/nested/two.md", "b/three.md");
    const selection = TreeSelection.selectAll(root);

    selection.setSubtree(folderNamed(root, "a"), false);

    expect(selection.isSelected("a/one.md")).toBe(false);
    expect(selection.isSelected("a/nested/two.md")).toBe(false);
    expect(selection.isSelected("b/three.md")).toBe(true);
    expect(selection.stateOf(root)).toBe("partial");
  });

  it("re-selects a whole subtree", () => {
    const root = tree("a/one.md", "a/nested/two.md");
    const selection = TreeSelection.selectAll(root);
    const folderA = folderNamed(root, "a");

    selection.setSubtree(folderA, false);
    selection.setSubtree(folderA, true);

    expect(selection.stateOf(folderA)).toBe("checked");
  });

  it("derives a nested folder’s state from its own descendants only", () => {
    const root = tree("a/one.md", "a/nested/two.md");
    const selection = TreeSelection.selectAll(root);

    selection.setFile("a/one.md", false);

    expect(selection.stateOf(folderNamed(folderNamed(root, "a"), "nested"))).toBe("checked");
    expect(selection.stateOf(folderNamed(root, "a"))).toBe("partial");
  });

  it("treats an empty tree as unchecked rather than fully selected", () => {
    const root = tree();
    expect(TreeSelection.selectAll(root).stateOf(root)).toBe("unchecked");
  });
});
