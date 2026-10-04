import type { ExpirationPolicy, FileSnapshot } from "../types";

/**
 * What a {@link PolicySource} concluded about a file.
 *
 * Three answers, not two. "No opinion" and "explicitly leave this alone" look
 * the same from a single source but mean opposite things to the chain: the
 * first lets the next source speak, the second ends the conversation. Without
 * that distinction a note saying `auto-remove: false` would still be claimed by
 * whatever folder rule it happens to sit under, which makes the property
 * useless exactly when someone reaches for it.
 */
export type PolicyVerdict =
	| { readonly kind: "expire"; readonly policy: ExpirationPolicy }
	| { readonly kind: "exempt" }
	| { readonly kind: "abstain" };

/** "I have no opinion" — the next source decides. */
export const ABSTAIN: PolicyVerdict = { kind: "abstain" };

/** "Leave this file alone" — no later source may claim it. */
export const EXEMPT: PolicyVerdict = { kind: "exempt" };

/** "This file expires under these terms." */
export function expire(policy: ExpirationPolicy): PolicyVerdict {
	return { kind: "expire", policy };
}

/**
 * One way of deciding what should happen to a file.
 *
 * Sources are consulted in priority order by {@link ./policy-resolver}. Adding
 * a new way to claim — or protect — files means writing one of these and
 * registering it; nothing else changes.
 */
export interface PolicySource {
	/** A short identifier, useful in tests and diagnostics. */
	readonly id: string;
	resolve(file: FileSnapshot): PolicyVerdict;
}
