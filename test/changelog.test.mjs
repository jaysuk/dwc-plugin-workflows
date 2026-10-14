import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/changelog.mjs", import.meta.url));

function repo() {
	const dir = mkdtempSync(join(tmpdir(), "chg-"));
	const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
	const git = (...a) => execFileSync("git", a, { cwd: dir, env, encoding: "utf8" });
	const commit = (msg) => {
		writeFileSync(join(dir, "f.txt"), msg);
		git("add", "-A");
		git("commit", "-q", "-m", msg);
	};
	git("init", "-q", "-b", "main");
	git("remote", "add", "origin", "https://github.com/o/r.git");
	return { dir, env, git, commit };
}
const run = (r, version) => execFileSync(process.execPath, [script, "--version", version], { cwd: r.dir, env: r.env, encoding: "utf8" });

test("the previous release is the previous v-tag, not a nearer non-release tag like rrf-<x>", () => {
	const r = repo();
	r.commit("feat: first");
	r.git("tag", "-a", "v1.0.0", "-m", "v1.0.0");
	r.commit("fix: second");
	r.git("tag", "-a", "rrf-3.7.0", "-m", "rrf marker"); // parity marker between releases
	r.commit("feat: third");
	r.git("tag", "-a", "v1.1.0", "-m", "v1.1.0");
	const out = run(r, "v1.1.0");
	assert.match(out, /compare\/v1\.0\.0\.\.\.v1\.1\.0/); // not .../rrf-3.7.0...
	assert.match(out, /second/); // commit made before the rrf tag is still part of this release
	assert.match(out, /third/);
	assert.doesNotMatch(out, /first/);
});

test("with no earlier v-tag the whole history is listed", () => {
	const r = repo();
	r.commit("feat: first");
	r.commit("feat: second");
	r.git("tag", "-a", "v1.0.0", "-m", "v1.0.0");
	const out = run(r, "v1.0.0");
	assert.match(out, /first/);
	assert.match(out, /second/);
});
