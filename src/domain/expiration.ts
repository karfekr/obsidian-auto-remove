import type { ExpirationPolicy, ExpiredFile, FileSnapshot } from "./types";
import { MAX_TTL_DAYS, MILLISECONDS_PER_DAY } from "./types";

/**
 * The whole of the TTL arithmetic.
 *
 * The clock starts at the file's modification time, so any edit that touches
 * `mtime` restarts it. Nothing here reads the current time on its own; callers
 * pass `now` in, which keeps the rules deterministic under test.
 */

/** The instant at which a file last modified at `mtime` becomes eligible. */
export function expiresAt(mtime: number, ttlDays: number): number {
	return mtime + ttlDays * MILLISECONDS_PER_DAY;
}

/**
 * Whether the file has outlived its TTL.
 *
 * The comparison is inclusive, so a TTL of zero expires a file the moment it is
 * scanned — a deliberate way to say "clear this out on the next run".
 */
export function isExpired(file: FileSnapshot, policy: ExpirationPolicy, now: number): boolean {
	return now >= expiresAt(file.mtime, policy.ttlDays);
}

/** Pairs a file with the policy that claimed it, once expiry is established. */
export function toExpiredFile(
	file: FileSnapshot,
	policy: ExpirationPolicy,
	now: number,
): ExpiredFile {
	return {
		file,
		policy,
		expiredAt: expiresAt(file.mtime, policy.ttlDays),
		ageMs: now - file.mtime,
	};
}

/**
 * Parses a `ttl` frontmatter value.
 *
 * Accepts numbers and numeric strings, since YAML quoting is easy to get wrong
 * by accident. Rejects anything negative, fractional, unparseable or beyond
 * {@link MAX_TTL_DAYS} so that a typo falls back to the configured default
 * rather than deleting a file early — or, at the far end, producing an expiry
 * so distant that the note silently never expires at all.
 */
export function parseTtlDays(value: unknown): number | null {
	const parsed = coerceToNumber(value);
	if (!Number.isInteger(parsed)) return null;
	if (parsed < 0 || parsed > MAX_TTL_DAYS) return null;
	return parsed;
}

function coerceToNumber(value: unknown): number {
	if (typeof value === "number") return value;
	if (typeof value !== "string") return NaN;
	const trimmed = value.trim();
	// `Number('')` is 0, which would silently mean "expire immediately".
	return trimmed.length === 0 ? NaN : Number(trimmed);
}
