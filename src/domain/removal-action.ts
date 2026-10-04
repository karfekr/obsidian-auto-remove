import type { RemovalAction, RemovalActionKind } from "./types";
import { normalizeFolder } from "./vault-path";

/**
 * Bridges the flat shape settings persist (`action` + `moveDestination`) and
 * the union the rules work with.
 *
 * A `move` without a destination cannot be carried out, so it resolves to
 * `null` — better an unconfigured rule that does nothing than one that quietly
 * moves files to the vault root.
 */
export function toRemovalAction(
	kind: RemovalActionKind,
	destination: string,
): RemovalAction | null {
	if (kind === "trash") return { kind: "trash" };
	const folder = normalizeFolder(destination);
	return folder.length === 0 ? null : { kind: "move", destination: folder };
}

/** A short label for the action, for use in the preview dialog. */
export function describeAction(action: RemovalAction): string {
	return action.kind === "trash" ? "Trash" : `Move to ${action.destination}`;
}
