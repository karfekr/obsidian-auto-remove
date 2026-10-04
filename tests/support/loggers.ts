import type { Logger, LogContext } from "../../src/services/ports";

/**
 * Test loggers.
 *
 * `src/infrastructure/logging.ts` keeps the `Logger` port and the one implementation
 * production uses. These two have no production caller, so they live here rather
 * than being shipped in the bundle: a test double that cannot be reached from
 * `main.ts` does not belong in `src/`.
 */

/** Discards everything, so a test asserts on behaviour and nothing else. */
export class NullLogger implements Logger {
  debug(_message: string, _context?: LogContext): void {}
  warn(_message: string, _context?: LogContext): void {}
  error(_message: string, _context?: LogContext): void {}
}

/** A logger that keeps what it was told, for asserting on diagnostics. */
export class RecordingLogger implements Logger {
  readonly entries: Array<{
    level: "debug" | "warn" | "error";
    message: string;
    context: LogContext | undefined;
  }> = [];

  constructor(private readonly debugEnabled = false) {}

  debug(message: string, context?: LogContext): void {
    if (!this.debugEnabled) return;
    this.entries.push({ level: "debug", message, context });
  }

  warn(message: string, context?: LogContext): void {
    this.entries.push({ level: "warn", message, context });
  }

  error(message: string, context?: LogContext): void {
    this.entries.push({ level: "error", message, context });
  }

  /** Messages containing `text`, at any level. For `expect(...).toContain`. */
  messagesMatching(text: string): string[] {
    return this.entries
      .filter((entry) => entry.message.includes(text))
      .map((entry) => entry.message);
  }

  clear(): void {
    this.entries.length = 0;
  }
}
