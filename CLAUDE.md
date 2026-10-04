# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## What this is

**Auto Remove** — an Obsidian community plugin that expires vault files by a time-to-live and then
trashes or moves them. `README.md` documents the user-facing behaviour; `docs/ARCHITECTURE.md`
documents the design and the reasoning behind each decision. Read the latter before changing
anything structural.

## Commands

```bash
pnpm run dev          # esbuild watch → main.js (what you leave running while developing)
pnpm run build        # clean → build:style → esbuild production bundle → tsc
pnpm test             # vitest run
pnpm run test:watch   # vitest in watch mode
pnpm run lint         # biome check --write (format + lint)
```

Run a single test file or a single case:

```bash
pnpx vitest run tests/domain/validation.test.ts
pnpx vitest run -t "lets an explicit opt-out veto the folder rule covering it"
```

Note that `pnpm run build` type-checks _and_ bundles; `pnpx tsc --noEmit --skipLibCheck` alone is
the faster loop when you only want types.

To try the plugin in a real vault, symlink or copy `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/auto-remove/`. `main.js` is gitignored — it is a build artifact attached
to releases, never committed.

## The one invariant that matters

`src/domain`, `src/services`, `src/settings` and `src/infrastructure` **must not import from
`obsidian`.**

This is what makes the logic testable: there is no way to construct a `TFile` outside a running
vault, so anything that touches the Obsidian API is untestable by definition. The boundary is
enforced two ways — `tests/architecture.test.ts`, which reads the source files and fails if an
import slips through, and the fact that the suite runs in a Node environment with no DOM.

If you find yourself wanting an Obsidian type in those directories, add a port to
`src/services/ports.ts` instead and implement it in `src/adapters`.

Layering, each depending only inward:

```
    ui/   triggers/   adapters/    ← the only code that imports `obsidian`
                       app/         ← the composition root, and only this
              ↓
          services/                 ← orchestration, over ports
              ↓
  domain/       infrastructure/     ← rules, decisions, clock, logging
              ↓
           settings/                ← persistence and validation
```

`src/app/runtime.ts` is the composition root and nothing else. `src/main.ts` is a shell that hands
it Obsidian's `App` and gets back a wired object graph. There is no DI container, no event bus and
no generic repository.

## The design in one idea

Rules are **state**, not deadlines:

```text
file state + current time + rules = desired action
```

A rule is a comparison — `now >= mtime + TTL`. Nothing records a moment at which a file _should_
have been removed, so there is no schedule to miss, no "last run" to catch up on, and no class of
scheduler-recovery bug. A timer only decides how long the plugin takes to _notice_ a file that is
already eligible.

`ReconciliationService` (`src/services/reconciliation-service.ts`) is the single authoritative path,
fed by startup, a five-minute interval, debounced vault events and the Run now command. Triggers
decide _when_; the service decides _what_. **Never add business logic to a trigger or a command.**

## Non-obvious design points

**An unusable rule claims nothing, and says so.** `src/domain/validation.ts` is the single authority
on whether a rule can be carried out; the resolver and the settings page both consult it. A `move`
with no destination is invalid — it is never reinterpreted, and in particular **never turned into a
delete**. A destination inside the rule's own folder is also invalid, because only Markdown files
carry the frontmatter that is stripped after a move; an attachment would be re-filed indefinitely.

**`FileRule.scope` is `"md"` by default.** Anything other than an explicit `"all"` reads as
Markdown-only, so a rule written by hand or by an older version gets the safe reading. Attachments
are opt-in because they have nothing to strip.

**A policy source has three verdicts, not two.** `expire` / `exempt` / `abstain`
(`src/domain/policy/policy-source.ts`). Collapsing `exempt` and `abstain` is natural and wrong: a
note marked `auto-remove: false` would then be claimed by whatever folder rule it sits under. Note
that `PolicyResolver.resolve` _does_ collapse them, deliberately — deciding needs one answer. When
you need to tell them apart (for diagnostics), ask `resolver.sources` directly, as
`ExpirationScanner` does.

**Priority order lives in one array.** `buildPolicyResolver`
(`src/domain/policy/resolver-factory.ts`) builds the ordered `PolicySource[]`. That order _is_ the
spec: frontmatter, then folder rules. Ignore patterns are evaluated inside `FolderRulePolicySource`,
which is why an explicit `auto-remove: true` beats a folder's ignores.

**The resolver is rebuilt per run from a settings snapshot.** Ignore matchers compile once, at
construction. There is deliberately no cache to invalidate — a run sees one consistent configuration
and edits take effect on the next run.

**Time and timers are injected, not read.** `Clock` is a function; `systemClock` is the only place
`Date.now` appears. `ManualClock` and `ManualScheduler` are how the suite tests
23-hour/24-hour/25-hour boundaries and the debounce window in microseconds. Do not add fake timers
to business logic.

**Evaluate produces decisions, not removals.** `ExpirationScanner.evaluate` returns a `FileDecision`
for every file a rule had an opinion about, **including the ones left alone and why**.
`domain/plan.ts`'s `buildPlan` turns the eligible subset into `PlannedRemoval`s, and only the
executor touches the filesystem. The preview dialog, the dry run and the "explain this file" command
all read the same plan, which is why they cannot disagree.

**Three outcomes, never two.** `ActionExecutor` reports removed, warned and failed separately. A
`move` that succeeded but could not rewrite the note's frontmatter is a _warning_: reporting it as a
failure was the audit's clearest bug, and retrying would rename the file twice.

**Pending actions store paths, not decisions** (`src/services/pending-actions.ts`). When a file
leaves the open set it is re-scanned against the current clock. "Edit to cancel, close to confirm"
falls out of that single re-check; do not add separate edit tracking. The queue is in-memory only,
so nothing survives a reload.

**Preview is a `PreviewGate` function** the cleanup service awaits, not a hard-wired step. Returning
`null` cancels. Automatic runs ask once per distinct set of files (`OncePerPlanPromptPolicy`) so a
five-minute interval does not re-raise the same dialog; a manual run always asks.

## Test doubles must match production

`FakeVault` and the real `VaultFileActions` are held together by `tests/adapters/agreement.test.ts`,
which runs the same scenarios through both and requires them to agree. This exists because they once
did not — the fake did not strip frontmatter, so service tests passed while production was broken.
If you change one, that test will tell you about the other.

`tests/support/obsidian-mock.ts` stands in for the `obsidian` module, and it is wired up by
`resolve.alias` in `vitest.config.ts` — **do not add `vi.mock("obsidian", …)` to a test.** The
`obsidian` package is types-only (`"main": ""`), so the bare specifier has no resolvable entry;
aliasing fixes resolution itself, whereas `vi.mock` only works if it happens to be applied before
the resolver runs, which changed between Vitest/Vite versions. Tests get the mock by importing
`installObsidianMock` normally:

```ts
import { installObsidianMock } from "../support/obsidian-mock";
```

Only execution is redirected. `tsconfig.json` has no path mapping, so TypeScript still checks every
`obsidian` import against the real `obsidian.d.ts`, and `esbuild.config.mjs` still marks `obsidian`
as `external` so the production bundle is untouched.

It models the awkward semantics on purpose: the Vault API returning `null` inside hidden folders,
`createFolder` throwing when a folder exists, `renameFile` mutating the `TFile` in place,
`processFrontMatter` throwing on malformed YAML, and `onLayoutReady` firing immediately when the
layout is already ready.

## Obsidian API constraints

These were established by reading the API docs and the bundled `obsidian.d.ts`; getting them wrong
is silent rather than loud.

- **`manifest.json` sets `minAppVersion: 1.6.6`**, which is the true floor of the APIs used
  (`FileManager.trashFile`, `AbstractInputSuggest.selectSuggestion`). Using anything newer requires
  bumping it and adding a `versions.json` entry.
- **Never read `leaf.view.file` to find open files.** Since Obsidian 1.7.2 a background tab holds a
  `DeferredView`, so the view object is absent for exactly the tabs that matter. Use
  `leaf.getViewState().state.file` (see `src/adapters/workspace-open-files.ts`).
- **Deletion always goes through `FileManager.trashFile`**, which honours the user's own "Deleted
  files" preference. The plugin must never implement its own trash.
- **Moves use `FileManager.renameFile`**, not `Vault.rename`, so inbound links are updated per user
  preference. `renameFile` mutates the `TFile` in place, so the same reference stays valid
  afterwards.
- **`processFrontMatter` _adds_ a frontmatter block to a file that has none.** That is why
  `releaseFromAutoRemove` checks the metadata cache first and does nothing when there is nothing of
  ours to remove — otherwise every archived plain note would gain `---\n---`.
- **Frontmatter is read from `MetadataCache`, never by parsing files.** A full scan therefore does
  zero disk I/O, which is what keeps startup scans imperceptible.

## Deliberate deviations

`src/ui/settings-tab.ts` uses the imperative `display()` API rather than the declarative
`getSettingDefinitions()` added in Obsidian 1.13.0. The declarative API binds one control to one
settings key and cannot express a user-editable list of folder rules; adopting it would also raise
`minAppVersion` to 1.13.0. `biome.json` turns `noConsole` off for `logging.ts` and
`dry-run-report.ts` only, because the `console.*` calls *are* those two files' output; everywhere else
in `src/` it stays an error, so a stray `console.log` cannot slip in. A config-scoped `overrides`
entry is used rather than a `biome-ignore` comment at the call site, to keep the two exemptions
visible in one place.

## Where to add things

| To add                               | Touch                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| A new way to claim (or exempt) files | One `PolicySource` in `src/domain/policy/`, one entry in `resolver-factory.ts`                         |
| A new automatic trigger              | One `CleanupTrigger` in `src/triggers/`, one line in `src/app/runtime.ts`                              |
| A new action                         | The `RemovalAction` union, `removal-action.ts`, `action-executor.ts`, `adapters/vault-file-actions.ts` |
| A new setting                        | `domain/types.ts`, `settings/defaults.ts`, `settings/settings-schema.ts`, `ui/settings-tab.ts`         |
| A new _kind of decision_             | `domain/plan.ts` and the `describe*` functions beside it — nothing else needs to change                |
| Preview or report appearance         | `ui/preview-modal.ts`, `ui/dry-run-report.ts`, `ui/tree-view.ts`; the shape is `domain/plan.ts`        |

## Conventions

- Tests live in `tests/`, mirroring the production layout in `src/`, and never inside `src/` itself.
  esbuild only follows imports from `src/main.ts`, so they cannot be bundled at all — the production
  bundle is byte-identical whether the suite is present or not.
- Source files are kept under roughly 200 lines. Split by responsibility when one grows past that.
- UI strings use sentence case (Obsidian's convention, lint-enforced). Only failures, warnings and
  opt-in diagnostics go to the console.
- Styling uses Obsidian CSS variables in `src/styles/` so the plugin follows the user's theme; no
  hardcoded colours or inline styles.
