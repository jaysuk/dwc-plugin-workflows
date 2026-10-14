# dwc-plugin-workflows

One release workflow for every DuetWebControl (Vue 3) plugin. Change it here and each plugin picks the
change up on its next release - no per-repo edits.

## Using it in a plugin

`.github/workflows/release.yml` in the plugin repo:

```yaml
name: Release

on:
  push:
    tags: ["v*"]
  workflow_dispatch:
    inputs:
      dwc-ref:
        description: DuetWebControl branch/tag/sha to build against
        default: v3.7-dev

permissions:
  contents: write # the shared workflow creates the Release and uploads the asset

jobs:
  release:
    uses: jaysuk/dwc-plugin-workflows/.github/workflows/release.yml@v1
    with:
      dwc-ref: ${{ inputs.dwc-ref }}
```

Releasing is then `npm run release -- 1.2.0 --push` (bump + commit + tag + push), exactly as before.

### What it does

- **Tag push (`v*`)**: checks the tag equals `plugin.json` *and* `package.json`'s version, type-checks and
  builds the plugin against a fresh DuetWebControl checkout, and publishes a GitHub Release containing the
  ZIP, with
  - a pun title from the plugin's `scripts/release-titles.txt`,
  - notes: the `CHANGELOG.md` section for the version if there is one (see "Writing release notes"),
    otherwise a Conventional-Commit changelog,
  - an install footer ending in the `dwc-plugin-update` marker the in-app update checker reads.
- **Manual run**: the same build, but the ZIP is uploaded as a workflow artifact and the title and notes are
  printed to the run summary. Nothing is published, so this is the dry run to use after changing anything.

## Writing release notes

Commit subjects make poor release notes, so draft proper ones before you release. From the plugin repo:

```
node ../dwc-plugin-workflows/scripts/draft-release-notes.mjs 1.3.0
```

This sends the commit subjects *and bodies* since the previous tag, a diff stat, and the previous release's
notes (for tone) to the Claude Code CLI - text only, no tools - and writes the result into `CHANGELOG.md` as
`## [1.3.0] - <date>`. Then:

1. Read it and edit it. It is a draft: check the claims against what you know shipped.
2. Commit `CHANGELOG.md` (the release script refuses a dirty tree), then `npm run release -- 1.3.0 --push`.

Options: `--print` (show the draft, write nothing), `--force` (replace an existing section), `--since <tag>`,
`--model <id>`, `--prompt-only` (show what would be sent). It warns if the draft uses formatting the in-app
update notes cannot render (links, tables, HTML, nested bullets, `---`).

The CLI is found via `CLAUDE_BIN`, then `PATH`, then the copy bundled in the Claude Code VS Code extension.

**What the release page looks like** - with a `CHANGELOG.md` section:

```
<your section>                      <- also all the in-app update checker shows
---
### 📦 Install ... + the dwc-plugin-update marker
<details> All changes </details>    <- the generated commit list, collapsed
```

The in-app update checker cuts everything from the `---` before "Install" to the end, so the footer and the
collapsed commit list never show in the plugin. Without a section you get the generated commit list followed by
the footer, as before - releasing never depends on the draft step.

### What a plugin provides

| | |
|---|---|
| `plugin.json` | `id`, `version`, `name`, `dwcVersion`. The ZIP name, assets and footer are all derived from these. |
| `package.json` | `typecheck` and `verify-build` scripts. |
| `scripts/release-titles.txt` | The puns, one per line. The workflow warns when five or fewer are unused. |
| `.github/release-footer.md` *(optional)* | Extra lines appended to the footer: where to find the plugin, hardware requirements, companion plugins. |
| `release:prepare` npm script *(optional)* | Runs before packaging, for release-only asset fetches (e.g. OpenCV.js). |
| `CHANGELOG.md` *(optional)* | A `## [x.y.z]` section is used as the notes, with the generated list collapsed underneath. |

### Inputs

| Input | Default | |
|---|---|---|
| `dwc-ref` | `v3.7-dev` | DuetWebControl ref for the 3.7 build. Pass `${{ inputs.dwc-ref }}`; empty means the default. |
| `dwc36` | `false` | Also build a DWC 3.6 package, attached to the same release as `<id>-<version>-dwc36.zip`. Needs `scripts/stage-dwc36.mjs`, and is skipped while `src/ui36` does not exist. |
| `dwc36-ref` | `v3.6-dev` | DuetWebControl ref for the 3.6 build. |
| `node-version` | `26` | Node major for the build. |
| `workflows-ref` | `v1` | Ref this repo's scripts are taken from. Keep equal to the ref in `uses:`. |

When `dwc36` produces a package the footer automatically lists both downloads and carries a marker for each.

## How an update reaches every plugin

Plugins reference `@v1`, a floating tag. To change the workflow for everyone:

1. Merge to `main`, then `git tag v1.1.0 && git push origin v1.1.0`.
2. `promote.yml` runs the tests, publishes a release, and moves `v1` to that commit.

The next release of each plugin uses the new version. A breaking change is a new major (`v2`); plugins opt in
by changing `@v1` to `@v2` (Dependabot's `github-actions` ecosystem can open those PRs).

**Testing a change before rolling it out**: point one plugin at the branch (`...release.yml@my-branch` and
`workflows-ref: my-branch`) and use its manual dry run. When the plugin was last released, compare the notes
with what the run summary shows.

`workflows-ref` exists because a reusable workflow cannot see which ref it was loaded from; it fetches the
shared scripts (`scripts/`) itself.

## Layout

- `.github/workflows/release.yml` - the reusable workflow (`workflow_call`).
- `scripts/changelog.mjs` - Conventional-Commit changelog. Also still published from `dwc-plugin-runtime`,
  which older plugin workflows fetch by SHA; this copy is the one to edit going forward.
- `scripts/release-notes.mjs` - assembles the release body; `changelog-section.mjs`, `release-title.mjs`,
  `release-footer.mjs` are its parts. All run with the plugin as the working directory.
- `scripts/draft-release-notes.mjs` - drafts a `CHANGELOG.md` section with Claude (run by you, locally).
- `test/` - `npm test`.
