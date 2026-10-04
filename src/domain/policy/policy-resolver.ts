import type { ExpirationPolicy, FileSnapshot } from "../types";
import type { PolicySource } from "./policy-source";

/**
 * Applies policy sources in priority order and returns the first verdict.
 *
 * The ordering *is* the specification: frontmatter outranks folder rules, and a
 * file nothing claims is left alone. Keeping that as an ordered list rather than
 * a chain of conditionals means the priority is stated once, in one place.
 *
 * A source may also veto, which stops the search — so an explicit opt-out is
 * never overridden by a lower-priority rule that would have claimed the file.
 */
export class PolicyResolver {
  /**
   * The chain, in priority order.
   *
   * Public because diagnostics need it: `resolve` deliberately collapses
   * "exempt" and "abstain" to the same `null`, so explaining *why* a file was
   * left alone means asking the sources directly.
   */
  readonly sources: readonly PolicySource[];

  constructor(sources: readonly PolicySource[]) {
    this.sources = sources;
  }

  resolve(file: FileSnapshot): ExpirationPolicy | null {
    for (const source of this.sources) {
      const verdict = source.resolve(file);
      if (verdict.kind === "exempt") return null;
      if (verdict.kind === "expire") return verdict.policy;
    }
    return null;
  }
}
