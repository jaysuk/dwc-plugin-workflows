import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { VERSION_RE, bumpManifest, unexpectedChanges } from "../scripts/release.mjs";

const script = fileURLToPath(new URL("../scripts/release.mjs", import.meta.url));
const env = {
	...process.env,
	GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
	CLAUDE_BIN: join(tmpdir(), "definitely-not-a-claude-binary"), // makes the notes step fail deterministically
};

function repo({ changelog } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "rel-"));
	const git = (...a) => execFileSync("git", a, { cwd: dir, env, encoding: "utf8" });
	git("init", "-q", "-b", "main");
	writeFileSync(join(dir, "plugin.json"), JSON.stringify({ id: "P", name: "Plug", version: "1.0.0" }, null, "\t") + "\n");
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", version: "1.0.0" }, null, 2) + "\n");
	mkdirSync(join(dir, "scripts"));
	writeFileSync(join(dir, "scripts", "release-titles.txt"), "Alpha\nBeta\nGamma\n");
	if (changelog) writeFileSync(join(dir, "CHANGELOG.md"), changelog);
	git("add", "-A");
	git("commit", "-q", "-m", "feat: first");
	return { dir, git };
}
const run = (dir, ...args) => spawnSync(process.execPath, [script, ...args], { cwd: dir, env, encoding: "utf8" });

test("bumpManifest keeps tabs / space indentation and a trailing newline", () => {
	assert.equal(bumpManifest('{\n\t"version": "1.0.0"\n}\n', "1.0.1"), '{\n\t"version": "1.0.1"\n}\n');
	assert.equal(bumpManifest('{\n  "version": "1.0.0"\n}', "2.0.0"), '{\n  "version": "2.0.0"\n}\n');
	assert.equal(bumpManifest('{\n    "version": "1.0.0"\n}', "2.0.0"), '{\n    "version": "2.0.0"\n}\n');
});

test("version and dirty-tree rules", () => {
	assert.ok(VERSION_RE.test("1.2.3") && VERSION_RE.test("1.2.3-rc.1"));
	assert.ok(!VERSION_RE.test("1.2") && !VERSION_RE.test("v1.2.3"));
	assert.deepEqual(unexpectedChanges(" M plugin.json\n M CHANGELOG.md\n?? notes.txt\n"), ["notes.txt"]);
	assert.deepEqual(unexpectedChanges(""), []);
});

test("--no-notes: bumps both manifests, commits, creates an annotated tag, does not push", () => {
	const { dir, git } = repo();
	const r = run(dir, "1.0.1", "--no-notes");
	assert.equal(r.status, 0, r.stderr);
	assert.equal(JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")).version, "1.0.1");
	assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version, "1.0.1");
	assert.match(readFileSync(join(dir, "plugin.json"), "utf8"), /^\{\n\t"id"/); // tab indent preserved
	assert.equal(git("log", "-1", "--pretty=%s").trim(), "chore(release): v1.0.1");
	assert.equal(git("tag", "-l", "v1.0.1").trim(), "v1.0.1");
	assert.equal(git("cat-file", "-t", "v1.0.1").trim(), "tag"); // annotated
	assert.match(r.stdout, /Release title: v1\.0\.1 — "Alpha"/);
	assert.match(r.stdout, /Not pushed/);
});

test("an existing CHANGELOG.md section is used and committed with the release", () => {
	const { dir, git } = repo({ changelog: "# Changelog\n\n## [1.0.1] - 2026-10-14\n\nHand-written.\n" });
	const r = run(dir, "1.0.1", "--yes");
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /Using the existing CHANGELOG\.md section/);
	assert.match(git("show", "--stat", "--pretty=", "HEAD"), /CHANGELOG\.md|plugin\.json/);
});

test("a freshly edited, uncommitted CHANGELOG.md is allowed and lands in the release commit", () => {
	const { dir, git } = repo({ changelog: "# Changelog\n" });
	writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## [1.0.1] - 2026-10-14\n\nEdited.\n");
	const r = run(dir, "1.0.1", "--yes");
	assert.equal(r.status, 0, r.stderr);
	assert.match(git("show", "--stat", "--pretty=", "HEAD"), /CHANGELOG\.md/);
});

test("refuses: bad version, existing tag, unrelated uncommitted changes", () => {
	const { dir } = repo();
	assert.equal(run(dir, "1.0").status, 1);
	assert.equal(run(dir, "1.0.1", "--no-notes").status, 0);
	const again = run(dir, "1.0.1", "--no-notes");
	assert.equal(again.status, 1);
	assert.match(again.stderr, /already exists/);

	const { dir: dirty } = repo();
	writeFileSync(join(dirty, "stray.txt"), "x");
	const r = run(dirty, "1.0.1", "--no-notes");
	assert.equal(r.status, 1);
	assert.match(r.stderr, /uncommitted changes[\s\S]*stray\.txt/);
});

test("when notes cannot be drafted it stops before changing anything and points at --no-notes", () => {
	const { dir, git } = repo();
	git("commit", "-q", "--allow-empty", "-m", "feat: something new");
	const r = run(dir, "1.0.1", "--yes");
	assert.equal(r.status, 1);
	assert.match(r.stderr, /--no-notes/);
	assert.equal(JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")).version, "1.0.0"); // untouched
	assert.equal(git("tag", "-l").trim(), "");
});

test("already at the version (first release of a scaffolded version): tags the current commit, no empty commit", () => {
	const { dir, git } = repo();
	const before = git("rev-parse", "HEAD").trim();
	const r = run(dir, "1.0.0", "--no-notes");
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /already at 1\.0\.0/);
	assert.match(r.stdout, /Tagged the current commit as v1\.0\.0/);
	assert.equal(git("rev-parse", "HEAD").trim(), before); // no new commit
	assert.equal(git("rev-list", "-n", "1", "v1.0.0").trim(), before);
	assert.equal(git("cat-file", "-t", "v1.0.0").trim(), "tag");
});

test("already at the version but with a new CHANGELOG.md section: commits just the notes", () => {
	const { dir, git } = repo({ changelog: "# Changelog\n" });
	writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## [1.0.0] - 2026-10-14\n\nFirst.\n");
	const r = run(dir, "1.0.0", "--yes");
	assert.equal(r.status, 0, r.stderr);
	assert.equal(git("log", "-1", "--pretty=%s").trim(), "chore(release): v1.0.0");
	assert.equal(git("show", "--name-only", "--pretty=", "HEAD").trim(), "CHANGELOG.md");
});
