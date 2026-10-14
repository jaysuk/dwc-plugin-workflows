import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyPlaceholders, buildPackageFooter } from "../scripts/package-release-notes.mjs";

const pkg = { name: "dwc-gcode-core", version: "1.39.0", rrf: { baseline: "3.7.0-rc.1" }, obj: { a: 1 } };

test("placeholders: name, version and package.json paths; unknown ones are left visible", () => {
	assert.equal(applyPlaceholders("{{name}}@{{version}}", pkg), "dwc-gcode-core@1.39.0");
	assert.equal(applyPlaceholders("RRF `{{pkg.rrf.baseline}}`", pkg), "RRF `3.7.0-rc.1`");
	assert.equal(applyPlaceholders("{{ pkg.rrf.baseline }}", pkg), "3.7.0-rc.1");
	assert.equal(applyPlaceholders("{{pkg.nope.x}}", pkg), "{{pkg.nope.x}}"); // typo shows up in the release, not silently blank
	assert.equal(applyPlaceholders("{{pkg.obj}}", pkg), "{{pkg.obj}}"); // objects are not stringified
	assert.equal(applyPlaceholders("{{other}}", pkg), "{{other}}");
});

test("footer: install command first, then the package's own notes", () => {
	const f = buildPackageFooter({ pkg, extra: "> RRF baseline: `{{pkg.rrf.baseline}}`\n" });
	assert.equal(f, "---\n\n> 📦 `npm install dwc-gcode-core@1.39.0`\n> RRF baseline: `3.7.0-rc.1`\n");
	assert.equal(buildPackageFooter({ pkg }), "---\n\n> 📦 `npm install dwc-gcode-core@1.39.0`\n");
});

test("end to end in a temp repo: CHANGELOG section wins and the commit list is collapsed under the footer", () => {
	const dir = mkdtempSync(join(tmpdir(), "pkgnotes-"));
	const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
	const git = (...a) => execFileSync("git", a, { cwd: dir, env, encoding: "utf8" });
	git("init", "-q", "-b", "main");
	git("remote", "add", "origin", "https://github.com/jaysuk/dwc-gcode-core.git");
	writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
	writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## [1.39.0] - 2026-10-14\n\nHand-written headline.\n");
	mkdirSync(join(dir, ".github"));
	writeFileSync(join(dir, ".github", "release-footer.md"), "> RRF baseline: `{{pkg.rrf.baseline}}`\n");
	git("add", "-A");
	git("commit", "-q", "-m", "feat: something");
	const script = fileURLToPath(new URL("../scripts/package-release-notes.mjs", import.meta.url));
	const out = execFileSync(process.execPath, [script, "--version", "v1.39.0"], { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	assert.ok(out.startsWith("Hand-written headline."));
	assert.ok(out.indexOf("npm install dwc-gcode-core@1.39.0") < out.indexOf("<details>"));
	assert.match(out, /RRF baseline: `3\.7\.0-rc\.1`/);
	assert.match(out, /<summary>All changes<\/summary>[\s\S]*something/);
});
