import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
  {
    ignores: ["main.js", "node_modules/**", "scripts/**", "esbuild.config.mjs"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...obsidianmd.configs.recommended,
  {
    // Typed rules need type information, so they apply to TypeScript only —
    // eslint-plugin-obsidianmd also lints manifest.json and package.json.
    files: ["**/*.ts"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // The domain and service layers must stay free of Obsidian so they remain
    // unit-testable without a vault. See docs/ARCHITECTURE.md.
    files: [
      "src/domain/**/*.ts",
      "src/services/**/*.ts",
      "src/settings/**/*.ts",
      "src/infrastructure/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "obsidian",
              message:
                "The domain, service and settings layers must not depend on the Obsidian API.",
            },
          ],
        },
      ],
    },
  },
  {
    // Tests and their support code live in `tests/`, outside the production tree.
    // They run in Node and are never bundled into main.js, so the mobile-safety
    // rules about Node built-ins do not apply to them. `unbound-method` goes with
    // them: `expect(service.run)` is the standard way to assert on a spy. The mock
    // of the Obsidian API uses `globalThis` because it is loaded under both Node
    // and the browser, and `window` does not exist under Node.
    files: ["tests/**/*.ts"],
    rules: {
      "obsidianmd/no-nodejs-modules": "off",
      "obsidianmd/hardcoded-config-path": "off",
      "obsidianmd/no-tfile-tfolder-cast": "off",
      "obsidianmd/rule-custom-message": "off",
      "obsidianmd/no-global-this": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
  {
    // `infrastructure/logging.ts` *is* the console abstraction — the whole point of
    // the module is to be the one place `console` is touched, so that noise can be
    // gated in one place. `ui/dry-run-report.ts` logs because a dry run's output is
    // the deliverable: the user asked what would happen, and the answer is a list of
    // files and reasons. Both are opt-in, deliberate diagnostics, not debug noise.
    files: ["src/infrastructure/logging.ts", "src/ui/dry-run-report.ts"],
    rules: {
      "obsidianmd/rule-custom-message": "off",
    },
  },
  {
    // The settings page deliberately uses the imperative `display()` API rather
    // than the declarative `getSettingDefinitions()` added in Obsidian 1.13.0.
    // The declarative API binds one control to one settings key, which cannot
    // express a list of folder rules the user adds to and removes from; using
    // it would also raise minAppVersion from 1.6.6 to 1.13.0. See the class
    // doc comment in src/ui/settings-tab.ts.
    files: ["src/ui/settings-tab.ts"],
    rules: {
      "@typescript-eslint/no-deprecated": "off",
      "obsidianmd/settings-tab/prefer-setting-definitions": "off",
    },
  },
);
