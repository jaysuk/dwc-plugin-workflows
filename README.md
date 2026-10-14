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

### Releasing

Copy [templates/release.mjs](templates/release.mjs) to `scripts/release.mjs` (it is identical in every plugin
and never changes) and have `package.json` say `"release": "node scripts/release.mjs"`. Then:

```
npm run release -- 1.2.0 --push
```

drafts the release notes (see below), pauses so you can read and edit `CHANGELOG.md`, bumps `plugin.json` and
`package.json`, commits (notes included), tags `v1.2.0` and pushes - which publishes the release. Without
`--push` it stops after tagging. `--no-notes` skips the draft (the release then uses the generated commit
list); `--yes` skips the pause. After the push, for a plugin listed in the Duet3D PluginRepository, it also
prepares that repository's update request once the release is published (see
[Announcing a release](#announcing-a-release-to-the-duet3d-pluginrepository); `--no-notify` skips it). The launcher keeps a cached copy of this repo at `v1` in
`~/.cache/dwc-plugin-workflows`, refreshed on every run, so changes to the release flow reach every plugin
without editing it. Set `DWC_PLUGIN_WORKFLOWS_DIR` to run a local checkout of this repo instead.

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

## CI

`ci.yml` is the shared CI: unit and mount tests, then a build and type-check against a real DuetWebControl
checkout. In a plugin repo, `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    uses: jaysuk/dwc-plugin-workflows/.github/workflows/ci.yml@v1
    with:
      dwc-ref: v3.7-dev
```

Needs `npm test` plus `typecheck` and `verify-build` scripts (`test:coverage` is used instead of `npm test` when
it exists). Inputs: `dwc-ref` (default `v3.7-dev`), `dwc-repo`, `node-version` (default `26`).

Nothing is pinned per plugin: the plugin's own dependencies, including `dwc-plugin-test-kit` and the
`typecheck` / `verify-build` commands it provides, come from its `package.json`. Bumping the kit is an ordinary
dependency update, and a change to the CI itself is a new tag here.

This replaces `dwc-plugin-test-kit`'s `dwc-plugin-ci.yml`, which needed the kit's version written twice in every
plugin (`@vX` and `kit-ref`) and edited by hand in each repo for every change.

## Writing release notes

Commit subjects make poor release notes, so draft proper ones before you release. From the plugin repo:

```
node ../dwc-plugin-workflows/scripts/draft-release-notes.mjs 1.3.0
```

This sends the commit subjects *and bodies* since the previous tag, a diff stat, and the previous release's
notes (for tone) to the Claude Code CLI - text only, no tools - and writes the result into `CHANGELOG.md` as
`## [1.3.0] - <date>`. Then:

1. Read it and edit it. It is a draft: check the claims against what you know shipped.
2. Release as usual: `npm run release` reuses the section and commits it with the version bump.

`npm run release` does the drafting for you when the version has no section yet; run this script by hand only
to draft ahead of time or to redo a draft (`--force`).

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
| `scripts/release.mjs` | The launcher from `templates/release.mjs`, behind `npm run release`. |
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

## Announcing a release to the Duet3D PluginRepository

Plugins listed in [Duet3D/PluginRepository](https://github.com/Duet3D/PluginRepository) only pick up a new
release when someone files its **Plugin Updating** issue. `npm run release -- X.Y.Z --push` does that step
for you: once the release workflow has published, it prepares the issue and opens the **prefilled update form**
in your browser. You tick the terms and press Submit, and the repository's own automation takes it from there
(it opens a PR, merges it and redeploys).

```
npm run release -- notify [version] [--dry-run] [--no-open] [--mode auto|form|api] [--accept-terms]
```

re-runs just that step (to retry, or when you released with `--no-notify`). `--dry-run` prints the issue it
would file and changes nothing.

It only acts when the issue would actually be accepted, and otherwise says why and moves on:

- the plugin is **listed** in the repository, and the listing is **this repo's own** (same author and repository
  name) and was **submitted by the signed-in `gh` user**: the repository rejects update requests from anyone
  else. (So a fork that shares a name with someone else's listing is never notified.)
- the version is **not a pre-release**, and the listing does not already show it, and there is no open issue for it;
- the live update form still has the title, label and fields this script knows. If it has changed, nothing is
  filed and the script says so.

How the issue is made, and why it is a form rather than an API call: the repository's automation only runs if the
`plugin-update` label is on the issue as it opens, and GitHub only applies labels from an issue form (or to people
with triage access). An issue created through the API by an ordinary account silently loses its label and never
triggers anything, so by default you get the prefilled form. If your account has triage or push access there, the
script creates the issue directly, with the label; since that ticks the terms for you it asks first
(or pass `--accept-terms`).

Other things worth knowing:

- The **Summary** field overwrites the listed abstract on every update, so the script re-sends the listing's
  current abstract. Change it by editing the form before submitting.
- The repository reads the **newest GitHub release** and its primary ZIP (the shortest-named non-`-srcmap` ZIP, so
  `<id>-<v>.zip` is chosen over `<id>-<v>-dwc36.zip`), which is why the script waits for the release workflow first.
- **Plugin ID** is the repository name, not the `plugin.json` id.
- It never fails a release: any problem is printed with the command to retry.

## npm packages (the core libraries)

`npm-release.yml` releases the family's npm packages (`dwc-gcode-core`, `dwc-gcode-editor`,
`dwc-config-backup-core`, `dwc-plugin-runtime`, `dwc-plugin-test-kit`): **pushing a version tag tests the
package, publishes it to npm and creates the GitHub Release**. In a package repo, `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags: ["v*"]
  workflow_dispatch:

permissions:
  contents: write
  id-token: write # npm trusted publishing; must be granted here as well as in the shared workflow

jobs:
  release:
    uses: jaysuk/dwc-plugin-workflows/.github/workflows/npm-release.yml@v1
```

Then a release is: bump `version` in `package.json`, commit, `git tag vX.Y.Z && git push origin vX.Y.Z`. The
workflow verifies the tag matches `package.json`, runs whichever of `typecheck`, `build` and `test` the package
defines, publishes (a pre-release such as `1.2.0-rc.1` goes under the `next` dist-tag, not `latest`) and creates
the GitHub Release (the version's `CHANGELOG.md` section if there is one, else the generated commit list, plus
`npm install <name>@<version>` and the optional `.github/release-footer.md`; that file can use `{{name}}`,
`{{version}}` and `{{pkg.some.path}}`). **Do not `npm publish` by hand any more.** If you do, CI sees the version is
already on npm and skips its own publish.

A manual run (Actions -> Release -> Run workflow) is a dry run: it tests and builds, lists what
the npm tarball would contain and the notes it would use, and publishes nothing. Re-running a tag whose publish worked
but whose GitHub Release failed is safe; the already-published version is skipped.

### One-time npm setup per package

Publishing uses npm [trusted publishing](https://docs.npmjs.com/trusted-publishers): no npm token is stored in
GitHub. npm trusts one specific workflow in one repo, and attaches a provenance statement to every release.
Needs your npm 2FA, so it cannot be done from CI:

```
npm trust github dwc-gcode-core          --file release.yml --repo jaysuk/dwc-gcode-core          --allow-publish
npm trust github dwc-gcode-editor        --file release.yml --repo jaysuk/dwc-gcode-editor        --allow-publish
npm trust github dwc-config-backup-core  --file release.yml --repo jaysuk/dwc-config-backup-core  --allow-publish
npm trust github dwc-plugin-runtime      --file release.yml --repo jaysuk/dwc-plugin-runtime      --allow-publish
npm trust github dwc-plugin-test-kit     --file release.yml --repo jaysuk/dwc-plugin-test-kit     --allow-publish
```

- `--file` is the **caller's** `release.yml` in the package repo, not `npm-release.yml` here.
- npm does not validate the setting when it is saved; a mistake only shows as a failed publish.
- **A new trust setting must be used for a successful publish within 2 days, or it expires.** Run `npm trust` when
  you are about to tag a release, not weeks before. (`npm trust list <package>` shows what is set;
  `npm trust revoke` removes one.)
- Requirements: a public repo on GitHub-hosted runners, npm 11.5.1+ (the workflow checks and upgrades), and a
  `repository` field in `package.json` pointing at the repo (the workflow checks this too; provenance cannot be
  verified without it).
- Once it has worked, consider *Settings -> Publishing access -> Require two-factor authentication and disallow
  tokens* on each package (trusted publishers keep working; stored tokens stop), and revoke any old automation tokens.

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

- `.github/workflows/release.yml` - the reusable release workflow (`workflow_call`).
- `.github/workflows/ci.yml` - the reusable CI workflow.
- `.github/workflows/npm-release.yml` - the reusable release workflow for the npm packages (test, publish, GitHub Release).
- `scripts/changelog.mjs` - Conventional-Commit changelog. Also still published from `dwc-plugin-runtime`,
  which older plugin workflows fetch by SHA; this copy is the one to edit going forward.
- `scripts/release-notes.mjs` - assembles the release body; `changelog-section.mjs`, `release-title.mjs`,
  `release-footer.mjs` are its parts. All run with the plugin as the working directory.
- `scripts/package-release-notes.mjs` - the release body for an npm package (used by `npm-release.yml`).
- `scripts/notify-plugin-repository.mjs` - announces a release to the Duet3D PluginRepository (run by `release.mjs`).
- `scripts/draft-release-notes.mjs` - drafts a `CHANGELOG.md` section with Claude (run by you, locally).
- `scripts/release.mjs` - the release command: notes, bump, commit, tag, push. `templates/release.mjs` is the
  launcher each plugin carries.
- `test/` - `npm test`.
