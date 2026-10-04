<div dir="ltr" align=center>

[**فارسی**](README_FA.md) / [**English**](README.md)

</div>

# Auto Remove

An Obsidian plugin that gives files an expiry date. Notes declare how long they should live, or a
folder decides for them; once the time is up, Auto Remove shows you exactly what it found and
removes only what you confirm.

Vaults accumulate transient notes — inbox captures, daily scratch, half-finished drafts — that
nobody ever gets round to clearing out. Auto Remove clears them out, without ever surprising you.

Cleanup never runs silently. Whenever expired files are found, a dialog lists them as a folder tree
with every file selected.

## When it runs

Auto Remove keeps checking:

- **when Obsidian starts**, once the workspace is ready;
- **every five minutes**, in the background;
- **when you edit, create or move files**, with changes coalesced so a burst is one pass;
- **when you change a rule**, so shortening a time to live takes effect straight away;
- **when you ask**, with `Auto Remove: Run now`.

It does not need to be running at the moment a file expires. A file that expired while Obsidian was
closed is found at the next launch; one that expired while the laptop was asleep is found when it
wakes up. There is no schedule to miss and no "last run" to catch up on — Auto Remove asks a simple
question every time it looks: _is this file past its time to live, right now?_

You are asked once about any given set of files. If you dismiss the dialog, Auto Remove will not
keep asking about the same unchanged set — use `Auto Remove: Run now` to review it whenever you
like.

## How a file expires

The clock runs from a file's **modified time**. Editing a file restarts its time to live.

### 1. Notes that opt in

A note participates when its frontmatter says so:

```yaml
---
auto-remove: true
ttl: 3
---
```

| Frontmatter                       | Result                                                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto-remove: true` with `ttl: 3` | Expires 3 days after it was last modified                                                                                                          |
| `auto-remove: true` with no `ttl` | Expires after the default time to live (7 days)                                                                                                    |
| `ttl: 3` with no `auto-remove`    | The `ttl` is ignored. The note has not opted in — but it has not opted out either, so a folder rule may still claim it, using the folder's own TTL |
| `auto-remove: false`              | Never removed, by anything                                                                                                                         |

Opted-in notes use the **default action** and **default destination** from settings. Folder rules
never apply to them: an explicit opt-in is treated as the note's own instruction and outranks
everything else.

`auto-remove: false` is the mirror image — an explicit refusal that no folder rule can override. It
is how you exempt a single note from a rule covering its folder.

### 2. Folder rules

A folder rule applies a time to live to every note inside a folder, at any depth. Each rule sets its
own TTL, action, destination, ignore patterns and file scope.

When rules nest, **the most specific folder wins** — a rule on `Inbox/drafts` overrides one on
`Inbox`.

### 3. Anything else

A file no note and no rule claims is left alone. Auto Remove never acts on a file it was not
explicitly told about.

### In short

| Priority                    | Wins over                               |
| --------------------------- | --------------------------------------- |
| `auto-remove: false`        | Everything                              |
| `auto-remove: true`         | Folder rules, and their ignore patterns |
| Folder rule (deepest first) | Shallower folder rules                  |
| Ignore patterns             | Any rule above it                       |

## What a rule covers

Each folder rule has an **Applies to** setting:

- **Notes only** (the default) — only Markdown files are eligible.
- **Notes and attachments** — PDFs, canvases and other files are eligible too.

Attachments are opt-in because they carry no properties. When Auto Remove moves a note it strips the
`auto-remove` and `ttl` properties so the note cannot expire again from its new home — but an
attachment has nothing to strip. If its destination is itself covered by a rule, an attachment moved
there would be filed again on the next pass, and again after that.

## Ignore patterns

Each folder rule takes gitignore-style patterns, one per line, resolved relative to that rule's
folder:

```gitignore
Templates/**
*.canvas
*.pdf
!Templates/keep.md
```

## Actions

**Trash** hands the file to Obsidian, which honours your own _Settings → Files and links → Deleted
files_ preference — system trash, the vault's `.trash` folder, or permanent deletion. Auto Remove
has no opinion of its own.

**Move** relocates the file to a destination folder, creating it if needed and renaming rather than
overwriting if something is already there. Afterwards the `auto-remove` and `ttl` properties are
stripped, so an archived note does not simply expire again from its new home.

## Settings that are not doing anything

If a rule cannot be carried out, Auto Remove says so on the settings page and **does nothing with
it**. A `Move` with no destination folder never falls back to trashing anything.

A rule is inactive when:

- it is set to **Move** with no destination folder;
- its destination is inside the folder it covers — files would expire again from their new home;
- its destination is a hidden or relative folder, which Obsidian's vault API cannot resolve.

## Finding out why

Two commands answer "why was this file not removed?":

| Command                                               | What it does                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Auto Remove: Dry run — report what would be removed` | Evaluates everything and prints what a pass would do, and why, without changing anything |
| `Auto Remove: Explain the active file`                | The same explanation for the note you are looking at                                     |

The settings page also has a **Preview** button, and a **Developer logging** switch that writes
every decision to the developer console:

```text
Auto Remove: Kept Inbox/note.md — Under Rule: Inbox with a 30 day time to live; expires in 12 days.
Auto Remove: Would remove Inbox/old.md — Last modified 40 days ago, past its 30 days time to live under Rule: Inbox; will be sent to the trash.
```

File contents are never logged — only paths, rule names, ages and outcomes.

## Known limitations

- A file's **modified time** is the only clock. Files restored from a backup, or imported from an
  export, keep their old timestamps and may be eligible the moment they arrive.
- A file modified in the future — by clock skew, or by a sync tool — will not expire until the clock
  catches up.
- Deferred files (open in an editor when their turn came) are re-examined when the tab closes. If
  you edit the file first, the action is dropped, because editing restarts its time to live.
- Auto Remove does not delete folders, only files.

## <a name="collaboration"></a> Collaboration and Project Participation

This plugin has been developed with love, for non-commercial purposes, and under
[this license](LICENSE).

You can support our continued efforts in the following ways:

- Contribute to the development of this plugin
- Report bugs or suggest a feature for development via the Issues section on this GitHub page
- Recommend installing and using this plugin to your friends
- Follow our website and Telegram channel

<div align=center>

[![Website](https://img.shields.io/badge/Website-karfekr.ir-orange)](https://karfekr.ir)
[![Telegram Channel](https://img.shields.io/endpoint?color=neon&label=Karfekr&style=flat-square&url=https%3A%2F%2Ftg.sumanjay.workers.dev%2Fkarfekr)](https://t.me/karfekr)
[![Telegram Group](https://img.shields.io/endpoint?label=ObsidianFarsi&style=flat-square&url=https%3A%2F%2Ftg.sumanjay.workers.dev%2FObsidianFarsi&color=blue)](https://t.me/ObsidianFarsi)

</div>
