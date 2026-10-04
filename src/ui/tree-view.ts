import { setIcon } from "obsidian";
import type { FolderNode, TreeNode } from "../domain/file-tree";
import { describeAction } from "../domain/removal-action";
import { describeOrigin, formatAge, formatTtl } from "./format";
import type { TreeSelection } from "./tree-selection";

export interface TreeViewOptions {
	readonly selection: TreeSelection;
	/** Paths that are open in an editor and will therefore be acted on later. */
	readonly openPaths: ReadonlySet<string>;
	readonly onChange: () => void;
}

/**
 * Renders the expired files as a folder hierarchy with tri-state checkboxes.
 *
 * A tree is used rather than a list because the dialog is asking permission to
 * delete things, and *where* a file lives is most of what tells the user
 * whether they meant to keep it.
 *
 * Checkbox state is derived from the selection on every render rather than
 * mutated in place, so the tree and the selection cannot drift apart. The trees
 * involved are the size of one cleanup run, so redrawing is imperceptible and
 * far easier to reason about than incremental updates.
 */
export class TreeView {
	private readonly checkboxes = new Map<TreeNode, HTMLInputElement>();

	constructor(
		private readonly container: HTMLElement,
		private readonly options: TreeViewOptions,
	) {}

	render(root: FolderNode): void {
		this.container.empty();
		this.checkboxes.clear();
		this.renderChildren(root, this.container);
	}

	/** Re-reads the selection and updates every checkbox in place. */
	refresh(): void {
		for (const [node, checkbox] of this.checkboxes) {
			const state = this.options.selection.stateOf(node);
			checkbox.checked = state === "checked";
			checkbox.indeterminate = state === "partial";
		}
	}

	private renderChildren(parent: FolderNode, host: HTMLElement): void {
		const list = host.createDiv({ cls: "auto-remove-tree__children" });
		for (const child of parent.children) this.renderNode(child, list);
	}

	private renderNode(node: TreeNode, host: HTMLElement): void {
		const wrapper = host.createDiv({ cls: `auto-remove-tree__node mod-${node.kind}` });
		const row = wrapper.createDiv({ cls: "auto-remove-tree__row" });

		const checkbox = this.renderCheckbox(node, row);
		const label = row.createEl("label", { cls: "auto-remove-tree__label" });
		label.htmlFor = checkbox.id;

		setIcon(label.createSpan({ cls: "auto-remove-tree__icon" }), iconFor(node));
		label.createSpan({ cls: "auto-remove-tree__name", text: node.name });

		if (node.kind === "file") this.renderFileDetails(node, row);
		else this.renderChildren(node, wrapper);
	}

	private renderCheckbox(node: TreeNode, row: HTMLElement): HTMLInputElement {
		const checkbox = row.createEl("input", {
			cls: "auto-remove-tree__checkbox",
			type: "checkbox",
			attr: { id: checkboxId(node) },
		});

		const state = this.options.selection.stateOf(node);
		checkbox.checked = state === "checked";
		checkbox.indeterminate = state === "partial";
		checkbox.addEventListener("change", () => this.toggle(node, checkbox.checked));

		this.checkboxes.set(node, checkbox);
		return checkbox;
	}

	private toggle(node: TreeNode, checked: boolean): void {
		if (node.kind === "file") this.options.selection.setFile(node.path, checked);
		else this.options.selection.setSubtree(node, checked);

		this.refresh();
		this.options.onChange();
	}

	private renderFileDetails(node: Extract<TreeNode, { kind: "file" }>, row: HTMLElement): void {
		const details = row.createDiv({ cls: "auto-remove-tree__details" });
		const { policy, ageMs } = node.item;

		details.createSpan({ cls: "auto-remove-tree__detail", text: formatAge(ageMs) });
		details.createSpan({
			cls: "auto-remove-tree__detail",
			text: `TTL ${formatTtl(policy.ttlDays)}`,
		});
		details.createSpan({
			cls: "auto-remove-tree__detail mod-action",
			text: describeAction(policy.action),
		});
		details.createSpan({
			cls: "auto-remove-tree__detail mod-origin",
			text: describeOrigin(policy.origin),
		});

		// Being explicit about deferral is kinder than letting the user confirm a
		// deletion and then wonder why the file is still there.
		if (this.options.openPaths.has(node.path)) {
			details.createSpan({
				cls: "auto-remove-tree__detail mod-deferred",
				text: "Open — runs after closing",
			});
		}
	}
}

function iconFor(node: TreeNode): string {
	return node.kind === "folder" ? "folder" : "file-text";
}

let sequence = 0;

/** Checkbox ids only need to be unique within the document, not meaningful. */
function checkboxId(node: TreeNode): string {
	sequence += 1;
	return `auto-remove-${node.kind}-${sequence}`;
}
