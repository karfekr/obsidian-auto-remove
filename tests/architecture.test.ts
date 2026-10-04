import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the layering the whole design rests on.
 *
 * The rules and the workflows are testable precisely because they never touch
 * the Obsidian API. That property is easy to break with a single convenient
 * import, and impossible to notice by eye once the codebase grows — so it is
 * asserted here rather than left to discipline.
 */

const SOURCE_ROOT = join(__dirname, "..", "src");
const OBSIDIAN_FREE_LAYERS = ["domain", "services", "settings", "infrastructure"];

function sourceFilesIn(directory: string): string[] {
	const found: string[] = [];

	for (const entry of readdirSync(directory)) {
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) {
			found.push(...sourceFilesIn(path));
		} else if (entry.endsWith(".ts")) {
			found.push(path);
		}
	}

	return found;
}

function importsObsidian(path: string): boolean {
	return /from\s+['"]obsidian['"]/.test(readFileSync(path, "utf8"));
}

describe("layering", () => {
	it.each(OBSIDIAN_FREE_LAYERS)("src/%s does not depend on the Obsidian API", (layer) => {
		const offenders = sourceFilesIn(join(SOURCE_ROOT, layer))
			.filter(importsObsidian)
			.map((path) => path.slice(SOURCE_ROOT.length + 1));

		expect(offenders).toEqual([]);
	});

	it("finds the source files it claims to be checking", () => {
		// A typo in the directory list would make the check above pass vacuously.
		for (const layer of OBSIDIAN_FREE_LAYERS) {
			expect(sourceFilesIn(join(SOURCE_ROOT, layer)).length).toBeGreaterThan(0);
		}
	});
});
