/**
 * Something that asks for a reconciliation.
 *
 * Triggers are deliberately minimal: they decide *when*, never *what*. All of
 * them funnel into the same reconciliation path, so a new trigger cannot
 * accidentally introduce a second, subtly different cleanup path.
 *
 * The on-demand command is not a trigger — it is always available regardless of
 * configuration, and lives with the other commands.
 */
export interface CleanupTrigger {
	/** A short identifier, useful in tests and diagnostics. */
	readonly id: string;
	/** Begins listening. Returns a function that stops it again. */
	start(): () => void;
}

/** Asks for a reconciliation. Supplied to triggers so they never build one. */
export type RunCleanup = () => void;
