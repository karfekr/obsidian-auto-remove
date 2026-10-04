import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests live in `tests/`, mirroring the production layout in `src/`. They are
    // deliberately outside `src/` so nothing that ships can reach them, and so the
    // production tree contains no `*.test.ts` to be bundled by accident.
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
  },
});
