# Architecture

This document explains how Auto Remove is put together and, more usefully, why. It is aimed at
someone picking the codebase up cold and wanting to change something without breaking a rule they
did not know existed.

## The shape: a pure core behind a thin Obsidian shell

Five layers, each depending only inward:

```
     ui/    triggers/    adapters/     ← the only code that imports `obsidian`
                         app/          ← the composition root, and only this
                   ↓
               services/                ← orchestration, over ports
                   ↓
       domain/    infrastructure/       ← rules, types, clock, logging
                   ↓
              settings/                 ← persistence and validation
```

`src/domain`, `src/services`, `src/settings` and `src/infrastructure` contain no reference to the
Obsidian API at all. That is enforced three ways: a `no-restricted-imports` rule in
`eslint.config.mjs`, `tests/architecture.test.ts`, which reads the source files and fails if an
import slips through, and the fact that the test suite runs without a DOM.

### Why

Almost every tricky rule in this plugin is pure logic: TTL arithmetic, the
frontmatter-over-folder-rule priority order, gitignore semantics, tree building, and deciding
whether a file the user just closed is still expired. None of it involves I/O, but all of it lives
inside an app you cannot instantiate in a test runner — there is no way to construct a `TFile`
without a vault.

Pushing that logic out of Obsidian's reach is what makes it testable at all. The unit tests run in
about a second with no Obsidian, no vault and no DOM.

### What is deliberately _not_ abstracted

No dependency injection container, no event bus, no generic repository, no plugin lifecycle
framework. `src/app/runtime.ts` is a composition root that wires everything by hand, and that is the
whole of the wiring story.

## The central idea: rules are state, the schedule only decides when you look

This is the single most important thing to understand about the design.

```text
file state + current time + rules = desired action
```

A rule is a **comparison**, not a deadline. `isExpired` (`domain/expiration.ts`) asks
`now >= mtime + TTL`. Nothing anywhere in the plugin records a moment at which a file _should_ have
been removed, and nothing schedules one.

The consequence is that a timer cannot make a rule correct. It can only decide how long the plugin
takes to **notice** a file that is already eligible. Every awkward situation the audit worried about
therefore resolves to the same answer — the next reconciliation will find it:

| Situation                             | Behaviour                                                           |
| ------------------------------------- | ------------------------------------------------------------------- |
| Obsidian closed when a file expired   | The startup reconciliation finds it                                 |
| Laptop asleep past the TTL            | The interval fires on wake; the state on disk never changed         |
| Obsidian crashed mid-run              | Partial work; the next pass reconciles the remainder                |
| Plugin reloaded                       | Every timer was registered for teardown, so none survives           |
| A run was missed                      | There is no schedule to miss                                        |
| The system clock moved                | The rules are comparisons, so a new `now` simply changes the answer |
| Enabled weeks after something expired | Nothing to catch up — it is simply eligible now                     |

**There is deliberately no catch-up bookkeeping**, because there is no persisted "last ran at" to
reconcile against. That is the payoff of making the rules state-based: the entire class of
scheduler-recovery bugs cannot exist.

### Reconciliation

`ReconciliationService` (`services/reconciliation-service.ts`) is the one authoritative path from
"something changed" to "files acted on". Four things feed it, and none of them contains business
logic:

```text
   startup ─┐
   interval ─┤
 vault events ─┼──► Reconciliation ──► discover ──► evaluate ──► plan ──► execute
  Run now ───┘        (single-flight)                                          │
                                                                          the only
                                                                          step that
                                                                          touches disk
```

Triggers decide _when_; the service decides _what_. A new trigger is one object implementing
`CleanupTrigger` plus one line in `runtime.ts`.

**Never overlapping.** A request arriving mid-run sets a flag and the run repeats exactly once, so
two passes can never race over the same file. Many requests inside the debounce window coalesce into
one run, because a single save emits several vault events and a sync client emits hundreds.

**Asking once per distinct set.** Reconciliation runs on a timer as well as on events, so without
`OncePerPlanPromptPolicy` an unchanged set of expired files would raise the same dialog every five
minutes — which is how a background plugin becomes one users disable. A manual run always asks.

## Layers

### `src/domain` — rules and decisions

Pure functions and small classes with no I/O.

| Module              | Responsibility                                                            |
| ------------------- | ------------------------------------------------------------------------- |
| `types.ts`          | The vocabulary, plus `MARKDOWN_EXTENSION` and `MAX_TTL_DAYS`              |
| `vault-path.ts`     | Vault-relative path handling, in one place                                |
| `expiration.ts`     | All TTL arithmetic, and the parsing of a `ttl` frontmatter value          |
| `validation.ts`     | **The authority on "is this rule usable?"** See below                     |
| `removal-action.ts` | Bridges the flat settings shape and the `RemovalAction` union             |
| `ignore-matcher.ts` | Gitignore matching — the only module aware of the `ignore` package        |
| `file-tree.ts`      | Turns a flat list of expired files into the hierarchy the preview renders |
| `plan.ts`           | `FileDecision`, `ActionPlan`, and the reasons attached to them            |
| `policy/`           | The priority chain                                                        |

### `src/services` — orchestration

| Module                      | Responsibility                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `ports.ts`                  | The seams: `FileRepository`, `FileActions`, `OpenFileTracker`, `FileWatcher`, `Scheduler`, `Logger`, `PromptPolicy` |
| `expiration-scanner.ts`     | Vault → decisions, plus the single-file explanation                                                                 |
| `action-executor.ts`        | Runs a confirmed batch, deferring open files, isolating failures                                                    |
| `pending-actions.ts`        | Actions waiting for an editor tab to close                                                                          |
| `cleanup-service.ts`        | One run: evaluate → plan → gate → act                                                                               |
| `reconciliation-service.ts` | The single-flight, debounced entry point for every run                                                              |
| `test-doubles.ts`           | `FakeVault`, `FakeOpenFiles`, `ManualScheduler`                                                                     |

### `src/infrastructure` — the outside world's two answers

- `clock.ts` — `systemClock` and `ManualClock`. The only place the plugin reads the system time.
- `logging.ts` — `Logger`, `ConsoleLogger` (debug gated on a setting), `NullLogger`,
  `RecordingLogger`.

### `src/adapters` — the Obsidian implementations

`vault-file-repository.ts`, `vault-file-actions.ts`, `workspace-open-files.ts`,
`window-scheduler.ts`. One implementation each, no cleverness.

### `src/app`, `src/ui`, `src/triggers`, `src/settings`

The composition root; the preview modal, tree, settings page and dry-run report; the two triggers;
and settings persistence and validation.

## Key decisions

### 1. The policy chain is an ordered list, not a chain of conditionals

`PolicyResolver` (`domain/policy/policy-resolver.ts`) holds an array of `PolicySource`s and returns
the first decisive verdict. The array order _is_ the documented priority:

1. `FrontmatterPolicySource` — notes that opt in, or out, explicitly
2. `FolderRulePolicySource` — folder rules, narrowed by their scope and ignore patterns

### 2. A source has three answers, not two

```ts
type PolicyVerdict =
  | { kind: "expire"; policy: ExpirationPolicy }
  | { kind: "exempt" } // leave this alone — stop asking
  | { kind: "abstain" }; // no opinion — ask the next source
```

"No opinion" and "explicitly leave this alone" look identical from one source but mean opposite
things to the chain. Collapsing them into a single `null` is the natural first design, and it is
wrong: a note saying `auto-remove: false` would abstain, and then be claimed by whatever folder rule
it happened to sit under — making the property useless exactly when someone reaches for it.

The same collapse is _deliberate_ in `resolve`, because deciding needs one answer. Explaining does
not, which is why `ExpirationScanner` asks `resolver.sources` directly when it needs to tell an
exempt file from an unclaimed one.

### 3. Validation is a hard gate, and it lives in one place

`domain/validation.ts` decides whether a rule can be carried out. Two places consult it — the
resolver, which refuses to bind an invalid rule so it claims nothing, and the settings page, which
renders the message — and they cannot disagree because there is one implementation.

This is a correction. The check used to live only in the UI, as advisory text: a whole-vault rule
with a move destination was described as dangerous and was **fully live**, re-filing user
attachments indefinitely.

The rules, in short:

| Situation                          | Result                                                |
| ---------------------------------- | ----------------------------------------------------- |
| `move` with no destination         | Invalid. Claims nothing. Never becomes a delete       |
| Destination inside the rule folder | Invalid. Files would expire again from their new home |
| Hidden or relative destination     | Invalid. The Vault API cannot resolve them            |
| TTL outside `0…36500`              | Invalid, and rejected at parse time anyway            |

`Enabled` is deliberately not consulted: a paused rule with no destination is still misconfigured,
and its card is still on screen.

### 4. Markdown is the default scope; attachments are opt-in

`FolderRule.scope` is `"md"` or `"all"`, defaulting to `"md"`. Anything other than an explicit
`"all"` reads as Markdown-only, so a rule written by an older version or by hand gets the safe
reading.

The reason is not tidiness. Only Markdown files carry the frontmatter that is stripped after a move.
An attachment claimed by an `all` rule and moved into a folder another rule covers has nothing
stripped, so it is renamed again on every later run — `photo 1.png` to `photo 2.png` and onwards.
Making that opt-in puts the risk where the user can see it.

### 5. `buildPlan` is the only place a removal is assembled

```text
discover → evaluate → plan → execute
```

`evaluate` produces a `FileDecision` for every file a rule had an opinion about, **including the
ones left alone and why**. `buildPlan` turns the eligible subset into `PlannedRemoval`s. Only
`execute` touches the filesystem.

Three different needs want the same answer — the preview dialog, the dry run, and a user asking "why
wasn't my file removed?" — and all three read the plan. That is why they cannot disagree, and why
none of them re-implements rule evaluation.

Unclaimed files are omitted from a full scan: on a real vault that is nearly all of them and carries
no information. `ExpirationScanner.explain` answers for one named path, which is how the case that
motivates all of this is reachable — a note carrying `auto-remove: true` while the default action is
an unusable move.

### 6. Time is injected, never read

`Clock` is a function. `systemClock` is the only place `Date.now` appears, and it is called once, at
the composition root. `ManualClock` moves by milliseconds or days.

The difference between "23 hours old" and "25 hours old" is then two assertions rather than two days
of waiting. `ManualScheduler` does the same for the debounce and the interval, so no test waits and
no fake timer is installed globally. Fake timers appear exactly once, in
`tests/adapters/workspace-open-files.test.ts`, to test a debounce that has no seam to inject into.

### 7. Three outcomes, never two

`ActionExecutor` reports **removed**, **warned** and **failed** separately.

The distinction is not tidiness. `VaultFileActions.move` performs two mutations, and a note with
malformed YAML moved correctly and was then reported to the user as a failure. A completed move is
never retried — that would rename the file a second time — and never rolled back, which would be a
second, riskier mutation.

### 8. Delete stays Obsidian's decision

`trashFile` hands the file to whichever "Deleted files" behaviour the user configured: the system
trash, the vault's `.trash`, or permanent deletion. Auto Remove has no opinion and keeps no trash of
its own. A move whose frontmatter cannot be rewritten is reported as a warning, never escalated to a
delete.

### 9. Open files are detected from view state, not from the view

Since Obsidian 1.7.2, a background tab holds a `DeferredView`, so `leaf.view.file` is absent for
exactly the tabs that matter most here. `WorkspaceOpenFileTracker` reads
`leaf.getViewState().state.file` instead, and `iterateAllLeaves` covers the main area, both sidebars
and pop-out windows.

### 10. Pending actions are re-validated, never replayed

`PendingActions` stores paths. When a file leaves the open set the scanner re-reads it and
re-resolves its policy against the current clock: edited before closing → no longer expired →
dropped. That single re-check implements both halves of "edit to cancel, close to confirm". The
queue is in-memory; the next reconciliation rediscovers whatever is still expired.

### 11. Scanning does no I/O

`vault.getFiles()` is an in-memory list and `MetadataCache` already holds parsed frontmatter, so a
full scan touches the disk zero times. Only a move reads or writes, and only for the file being
moved.

### 12. Settings writes are serialised

The settings page calls `update` from `onChange`, once per keystroke. `SettingsStore` writes through
a single-slot queue: one write in flight, later snapshots coalescing into it, listeners notified
from memory immediately. Without that, concurrent writes landed out of order and the user's last
edit was lost on restart; a rejected write became an unhandled rejection; and trigger changes took
effect a disk round-trip late.

## Testing

Tests live in `tests/`, mirroring the layout of `src/`, and deliberately outside it. Nothing that
ships can reach them, and esbuild only follows imports from `src/main.ts` — so the production bundle
is byte-identical with or without the suite present.

- **Domain** — TTL boundaries, `ttl: 0`, `MAX_TTL_DAYS`, the full priority order, gitignore
  anchoring and negation, deepest-rule-wins, scope, validation, tree building.
- **Services** — the open-file lifecycle, the plan, dry runs, single-file explanations, and the
  reconciliation loop's interval, debounce, single-flight and teardown, all against `ManualClock`
  and `ManualScheduler`. No real waiting.
- **Adapters** — the real Obsidian calls: `trashFile`, `renameFile`, `createFolder`,
  `processFrontMatter`, collision resolution, the open-file tracker, and the repository's snapshot
  rules.
- **Agreement** — `tests/adapters/agreement.test.ts` runs the same scenarios through
  `VaultFileActions` and through `FakeVault` and requires them to agree. Without it the fake could
  drift and every service test using it could pass while production was broken — which is exactly
  what happened.
- **Composition root** — `tests/app/runtime.test.ts` builds the real object graph against a stand-in
  Obsidian and drives startup, the interval, vault events, Run now, dry runs and teardown.
- **Architecture** — `tests/architecture.test.ts` enforces the layering, and asserts it is actually
  reading files so a typo cannot make it pass vacuously.

Test support lives in `tests/support/`: `obsidian-mock.ts` (the `obsidian` module itself),
`test-doubles.ts` (`FakeVault`, `FakeOpenFiles`, `ManualScheduler`) and `loggers.ts` (`NullLogger`,
`RecordingLogger`). None of it has a production caller, so none of it ships.

`tests/support/obsidian-mock.ts` stands in for the `obsidian` module. It is hand-written rather than
generated, and it models the awkward semantics on purpose: the Vault API returning `null` inside
hidden folders, `createFolder` throwing when a folder exists, `renameFile` mutating the `TFile` in
place, `processFrontMatter` throwing on malformed YAML, and `onLayoutReady` firing immediately when
the layout is already ready.

## Where to add things

| To add                               | Touch                                                                                           |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| A new way to claim (or exempt) files | One `PolicySource` in `domain/policy/`, one entry in `resolver-factory.ts`                      |
| A new trigger                        | One `CleanupTrigger` in `triggers/`, one line in `app/runtime.ts`                               |
| A new action                         | `RemovalAction`, `removal-action.ts`, `action-executor.ts`, `adapters/vault-file-actions.ts`    |
| A new setting                        | `domain/types.ts`, `settings/defaults.ts`, `settings/settings-schema.ts`, `ui/settings-tab.ts`  |
| A new way of deciding                | `domain/plan.ts`, and the `reason` strings beside it — nothing else needs to change             |
| Preview or report appearance         | `ui/preview-modal.ts`, `ui/dry-run-report.ts`, `ui/tree-view.ts`; the shape is `domain/plan.ts` |
