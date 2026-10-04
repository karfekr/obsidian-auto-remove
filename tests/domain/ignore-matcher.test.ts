import { describe, expect, it } from "vitest";
import {
	createIgnoreMatcher,
	isMeaningfulPattern,
	validateIgnorePattern,
} from "../../src/domain/ignore-matcher";

describe("createIgnoreMatcher", () => {
	it("ignores nothing when there are no patterns", () => {
		const matcher = createIgnoreMatcher([]);
		expect(matcher.ignores("anything.md")).toBe(false);
	});

	it("matches a folder glob at any depth", () => {
		const matcher = createIgnoreMatcher(["Templates/**"]);
		expect(matcher.ignores("Templates/daily.md")).toBe(true);
		expect(matcher.ignores("Templates/nested/deep.md")).toBe(true);
		expect(matcher.ignores("Notes/daily.md")).toBe(false);
	});

	it("matches an extension glob anywhere in the tree", () => {
		const matcher = createIgnoreMatcher(["*.canvas", "*.pdf"]);
		expect(matcher.ignores("board.canvas")).toBe(true);
		expect(matcher.ignores("deep/nested/board.canvas")).toBe(true);
		expect(matcher.ignores("paper.pdf")).toBe(true);
		expect(matcher.ignores("note.md")).toBe(false);
	});

	it("re-includes a path with a negation pattern", () => {
		const matcher = createIgnoreMatcher(["Templates/**", "!Templates/keep.md"]);
		expect(matcher.ignores("Templates/daily.md")).toBe(true);
		expect(matcher.ignores("Templates/keep.md")).toBe(false);
	});

	it("honours the order in which patterns are written", () => {
		const matcher = createIgnoreMatcher(["!Templates/keep.md", "Templates/**"]);
		expect(matcher.ignores("Templates/keep.md")).toBe(true);
	});

	it("skips blank lines and comments", () => {
		const matcher = createIgnoreMatcher(["", "  ", "# drafts are transient", "*.canvas"]);
		expect(matcher.ignores("board.canvas")).toBe(true);
		expect(matcher.ignores("note.md")).toBe(false);
	});

	it("anchors a leading-slash pattern to the rule folder", () => {
		const matcher = createIgnoreMatcher(["/note.md"]);
		expect(matcher.ignores("note.md")).toBe(true);
		expect(matcher.ignores("nested/note.md")).toBe(false);
	});

	it("never matches an empty or absolute path", () => {
		const matcher = createIgnoreMatcher(["**"]);
		expect(matcher.ignores("")).toBe(false);
		expect(matcher.ignores("/absolute.md")).toBe(false);
	});
});

describe("isMeaningfulPattern", () => {
	it.each([
		["*.md", true],
		["", false],
		["   ", false],
		["# a comment", false],
	])("%s → %s", (pattern, expected) => {
		expect(isMeaningfulPattern(pattern)).toBe(expected);
	});
});

describe("validateIgnorePattern", () => {
	it("accepts ordinary patterns", () => {
		expect(validateIgnorePattern("Templates/**")).toBeNull();
		expect(validateIgnorePattern("!keep.md")).toBeNull();
	});

	it("accepts inert lines without complaining", () => {
		expect(validateIgnorePattern("")).toBeNull();
		expect(validateIgnorePattern("# note")).toBeNull();
	});

	it("accepts anchored patterns, which are valid gitignore syntax", () => {
		expect(validateIgnorePattern("/Templates/**")).toBeNull();
	});
});
