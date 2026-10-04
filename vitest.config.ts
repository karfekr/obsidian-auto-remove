import { join } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Where `import ... from "obsidian"` goes when Vitest runs a test.
 *
 * The `obsidian` package is types-only: it ships `obsidian.d.ts` and declares
 * `"main": ""`, because Obsidian provides the runtime at app start and nothing
 * can execute it outside the app. So the bare specifier has no resolvable entry,
 * and a Vite/Vitest resolver that walks the module graph will fail with
 * "Failed to resolve entry for package 'obsidian'" before any per-test mock gets
 * a chance to apply.
 *
 * Aliasing the specifier at the config layer fixes resolution itself, rather than
 * relying on `vi.mock` to out-race the resolver. That ordering is an implementation
 * detail of whichever Vitest and Vite versions happen to be installed, which is
 * why depending on it broke on a clean install.
 *
 * Deliberately configured here and nowhere else:
 *
 * - `esbuild.config.mjs` still lists `obsidian` as `external`, so the production
 *   bundle is unaffected and still imports it from the host at runtime.
 * - `tsconfig.json` has no path mapping, so TypeScript keeps type-checking every
 *   `obsidian` import against the real `obsidian.d.ts`. Only execution is redirected.
 *
 * There is exactly one mock implementation: `tests/support/obsidian-mock.ts`.
 */
const obsidianMock = join(import.meta.dirname, "tests", "support", "obsidian-mock.ts");

export default defineConfig({
	resolve: {
		alias: [
			// Anchored, so it matches the bare specifier and nothing else — a prefix
			// match would also capture an unrelated package called `obsidian-something`.
			{ find: /^obsidian$/, replacement: obsidianMock },
		],
	},
	test: {
		// Tests live in `tests/`, mirroring the production layout in `src/`. They are
		// deliberately outside `src/` so nothing that ships can reach them, and so the
		// production tree contains no `*.test.ts` to be bundled by accident.
		include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
		environment: "node",
	},
});
