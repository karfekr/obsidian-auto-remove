import type { Logger, LogContext } from "../services/ports";

/**
 * Diagnostics that make a background plugin explainable.
 *
 * The question this exists to answer is "the rule should have moved this file
 * yesterday — why didn't it?", and it has to be answerable from the developer
 * console without attaching a debugger. That means logging *decisions*, not just
 * errors: the audit found that the reason a file was skipped was computed and
 * then discarded one line before it would have been useful.
 *
 * Two rules keep this usable rather than noisy:
 *
 * - `debug` is opt-in. Reconciliation also runs on vault events, so an
 *   unconditional trail would drown everything else.
 * - Only paths, rule identities, ages and outcomes are logged. File contents are
 *   never touched, so there is nothing here to leak.
 */

/** Prefixed so Auto Remove's output is greppable in a busy console. */
const PREFIX = "Auto Remove";

export class ConsoleLogger implements Logger {
  constructor(private debugEnabled: () => boolean) {}

  debug(message: string, context?: LogContext): void {
    if (!this.debugEnabled()) return;
    console.info(`${PREFIX}: ${message}`, context ?? "");
  }

  warn(message: string, context?: LogContext): void {
    console.warn(`${PREFIX}: ${message}`, context ?? "");
  }

  error(message: string, context?: LogContext): void {
    console.error(`${PREFIX}: ${message}`, context ?? "");
  }
}
