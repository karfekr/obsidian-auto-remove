import { expiresAt, isExpired } from "../domain/expiration";
import type { FileDecision } from "../domain/plan";
import { describeExempt, describeExpiry, describePending, describeUnclaimed } from "../domain/plan";
import type { PolicyResolver } from "../domain/policy/policy-resolver";
import type { PolicySource } from "../domain/policy/policy-source";
import type { ExpiredFile } from "../domain/types";
import type { Clock, FileRepository } from "./ports";

/**
 * Turns the vault into decisions, and nothing more.
 *
 * The scan is a single pass over an in-memory file list with no vault reads, so
 * it stays cheap even on large vaults; the resolver has already compiled its
 * ignore patterns by the time it gets here.
 *
 * Every method here is pure with respect to `now`, which arrives from an injected
 * clock. That is what makes "23 hours old", "24 hours old" and "25 hours old"
 * three assertions rather than three days of waiting.
 */
export class ExpirationScanner {
	constructor(
		private readonly repository: FileRepository,
		private readonly clock: Clock,
	) {}

	/**
	 * Evaluates every file and explains each outcome.
	 *
	 * Files no rule has an opinion about are omitted: on a real vault that is
	 * nearly all of them, and carrying them would turn a useful diagnostic into a
	 * memory cost. Use {@link explain} to ask about one specific path.
	 */
	evaluate(resolver: PolicyResolver): FileDecision[] {
		const now = this.clock();
		const decisions: FileDecision[] = [];

		for (const file of this.repository.listFiles()) {
			const source = claimingSource(resolver.sources, file);
			const policy = source === null ? null : resolver.resolve(file);

			// Only files some rule had an opinion about are worth reporting.
			if (policy === null && source === null) continue;

			if (policy === null) {
				decisions.push({
					file,
					outcome: "exempt",
					reason: describeExempt(file),
					policy: null,
					expiresAt: null,
					ageMs: now - file.mtime,
				});
				continue;
			}

			if (isExpired(file, policy, now)) {
				decisions.push({
					file,
					outcome: "expire",
					reason: describeExpiry(file, policy, now - file.mtime),
					policy,
					expiresAt: expiresAt(file.mtime, policy.ttlDays),
					ageMs: now - file.mtime,
				});
				continue;
			}

			const at = expiresAt(file.mtime, policy.ttlDays);
			decisions.push({
				file,
				outcome: "not-expired",
				reason: describePending(file, policy, at - now),
				policy,
				expiresAt: at,
				ageMs: now - file.mtime,
			});
		}

		return decisions.sort((a, b) => a.file.path.localeCompare(b.file.path));
	}

	/** The files that have outlived their TTL, in a stable path order. */
	scan(resolver: PolicyResolver): ExpiredFile[] {
		return this.evaluate(resolver).flatMap((decision) =>
			decision.outcome === "expire" && decision.policy !== null
				? [
						{
							file: decision.file,
							policy: decision.policy,
							expiredAt: decision.expiresAt ?? 0,
							ageMs: decision.ageMs,
						},
					]
				: [],
		);
	}

	/**
	 * Re-checks a single path against current configuration.
	 *
	 * Used when a queued action finally becomes possible: the file may have been
	 * edited, moved, or had its frontmatter changed in the meantime, and the
	 * answer we cached is no longer authoritative.
	 */
	rescan(path: string, resolver: PolicyResolver): ExpiredFile | null {
		const decision = this.explain(path, resolver);
		if (decision.outcome !== "expire" || decision.policy === null) return null;

		return {
			file: decision.file,
			policy: decision.policy,
			expiredAt: decision.expiresAt ?? 0,
			ageMs: decision.ageMs,
		};
	}

	/**
	 * Explains the decision for exactly one path, whether or not anything claimed
	 * it.
	 *
	 * This is the answer to "why was this file not removed?", including the case
	 * that motivates it: a note that carries `auto-remove: true` while the default
	 * action is an unusable move reports `unclaimed`, because that is precisely
	 * what the resolver did with it.
	 */
	explain(path: string, resolver: PolicyResolver): FileDecision {
		const now = this.clock();
		const file = this.repository.getFile(path);

		if (file === null) {
			return {
				file: { path, extension: "", mtime: 0, frontmatter: null },
				outcome: "unclaimed",
				reason: "No such file in the vault.",
				policy: null,
				expiresAt: null,
				ageMs: 0,
			};
		}

		const source = claimingSource(resolver.sources, file);
		const policy = resolver.resolve(file);

		if (policy === null) {
			return {
				file,
				outcome: source === null ? "unclaimed" : "exempt",
				reason: source === null ? describeUnclaimed(file) : describeExempt(file),
				policy: null,
				expiresAt: null,
				ageMs: now - file.mtime,
			};
		}

		const at = expiresAt(file.mtime, policy.ttlDays);
		if (isExpired(file, policy, now)) {
			return {
				file,
				outcome: "expire",
				reason: describeExpiry(file, policy, now - file.mtime),
				policy,
				expiresAt: at,
				ageMs: now - file.mtime,
			};
		}

		return {
			file,
			outcome: "not-expired",
			reason: describePending(file, policy, at - now),
			policy,
			expiresAt: at,
			ageMs: now - file.mtime,
		};
	}
}

/**
 * The first source with a non-abstaining opinion, or `null` if every source
 * abstained.
 *
 * `PolicyResolver.resolve` collapses "exempt" and "abstain" to `null`, which is
 * right for deciding and wrong for explaining: without this, a file protected by
 * `auto-remove: false` is indistinguishable from a file nothing claimed.
 */
function claimingSource(
	sources: readonly PolicySource[],
	file: FileDecision["file"],
): PolicySource | null {
	for (const source of sources) {
		if (source.resolve(file).kind !== "abstain") return source;
	}
	return null;
}
