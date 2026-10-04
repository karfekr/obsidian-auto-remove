import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceOpenFileTracker } from "../../src/adapters/workspace-open-files";
import type { FakeApp } from "../support/obsidian-mock";
import { installObsidianMock } from "../support/obsidian-mock";

/**
 * Knowing which files the user has open.
 *
 * This is a safety mechanism: an expired note must not be moved out from under
 * someone who is reading it. Two details matter and neither is obvious:
 *
 * - the file is read from the leaf's *view state*, not from `leaf.view`, because
 *   since Obsidian 1.7.2 a background tab holds a `DeferredView` and `leaf.view.file`
 *   is absent for exactly the quiet tabs that most need protecting;
 * - `iterateAllLeaves` covers the main area, both sidebars and pop-out windows, so
 *   a note open in a detached window is still protected.
 */
describe("WorkspaceOpenFileTracker", () => {
	function setup(openPaths: string[] = []): { app: FakeApp; tracker: WorkspaceOpenFileTracker } {
		const app = installObsidianMock({ files: [{ path: "Inbox/note.md", mtime: 0 }], openPaths });
		return { app, tracker: new WorkspaceOpenFileTracker(app as never) };
	}

	describe("getOpenPaths", () => {
		it("reports nothing when no tab is open", () => {
			expect(setup().tracker.getOpenPaths().size).toBe(0);
		});

		it("reports the file each leaf is showing", () => {
			const { tracker } = setup(["Inbox/note.md", "Inbox/other.md"]);
			expect([...tracker.getOpenPaths()].sort()).toEqual(["Inbox/note.md", "Inbox/other.md"]);
		});

		it("reads the leaf's view state, so a deferred view still counts", () => {
			const { tracker } = setup(["Inbox/note.md"]);
			// The path comes from `getViewState().state.file`; nothing touches `.view`.
			expect(tracker.getOpenPaths().has("Inbox/note.md")).toBe(true);
		});

		it("returns a fresh set each time, so a caller cannot corrupt it", () => {
			const { tracker } = setup(["Inbox/note.md"]);
			const first = tracker.getOpenPaths() as Set<string>;
			first.clear();
			expect(tracker.getOpenPaths().has("Inbox/note.md")).toBe(true);
		});
	});

	describe("subscribing", () => {
		// These tests drive the debounce itself, which is a real timer inside the
		// adapter. Fake timers are used here and nowhere else: business logic gets an
		// injected clock, but a debounce has no seam to inject into.
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("does not notify until the workspace settles", () => {
			const { app, tracker } = setup();
			const listener = vi.fn();
			tracker.subscribe(listener);

			app.workspace.emit("layout-change");
			app.workspace.emit("active-leaf-change");
			vi.advanceTimersByTime(150);
			vi.advanceTimersByTime(100);

			// A burst of workspace churn is coalesced before every leaf is re-read.
			expect(listener).toHaveBeenCalledOnce();
		});

		it("notifies a late subscriber alongside the earlier ones", () => {
			const { app, tracker } = setup();
			const first = vi.fn();
			const second = vi.fn();
			tracker.subscribe(first);
			tracker.subscribe(second);

			app.workspace.emit("layout-change");
			vi.advanceTimersByTime(250);

			expect(first).toHaveBeenCalledOnce();
			expect(second).toHaveBeenCalledOnce();
		});

		it("stops notifying once unsubscribed", () => {
			const { app, tracker } = setup();
			const listener = vi.fn();
			tracker.subscribe(listener)();

			app.workspace.emit("layout-change");
			vi.advanceTimersByTime(250);

			expect(listener).not.toHaveBeenCalled();
		});

		it("does not notify after dispose, even with a change already pending", () => {
			const { app, tracker } = setup();
			const listener = vi.fn();
			tracker.subscribe(listener);

			app.workspace.emit("layout-change");
			tracker.dispose();
			vi.advanceTimersByTime(250);

			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe("watching for renames and deletes", () => {
		it("reports a rename with the old and the new path", () => {
			const { app, tracker } = setup();
			const renamed = vi.fn();
			tracker.onRenamed(renamed);

			const file = app.vault.getFileByPath("Inbox/note.md");
			app.vault.emit("rename", file, "Inbox/old.md");

			// A queued action follows the file rather than dropping it.
			expect(renamed).toHaveBeenCalledWith("Inbox/old.md", "Inbox/note.md");
		});

		it("reports a delete with its path", () => {
			const { app, tracker } = setup();
			const deleted = vi.fn();
			tracker.onDeleted(deleted);

			app.vault.emit("delete", { path: "Inbox/note.md" });

			expect(deleted).toHaveBeenCalledWith("Inbox/note.md");
		});

		it("stops reporting after the subscription is released", () => {
			const { app, tracker } = setup();
			const deleted = vi.fn();
			tracker.onDeleted(deleted)();

			app.vault.emit("delete", { path: "Inbox/note.md" });

			expect(deleted).not.toHaveBeenCalled();
		});

		it("stops reporting after dispose", () => {
			const { app, tracker } = setup();
			const deleted = vi.fn();
			tracker.onDeleted(deleted);

			tracker.dispose();
			app.vault.emit("delete", { path: "Inbox/note.md" });

			expect(deleted).not.toHaveBeenCalled();
		});
	});
});
