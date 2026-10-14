import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cmp, pickTitle } from "../scripts/release-title.mjs";

function plugin(titles, version = "1.2.0") {
	const dir = mkdtempSync(join(tmpdir(), "titles-"));
	mkdirSync(join(dir, "scripts"));
	writeFileSync(join(dir, "plugin.json"), JSON.stringify({ version }));
	if (titles) writeFileSync(join(dir, "scripts", "release-titles.txt"), titles);
	return dir;
}

test("index is the version's position among semver-sorted tags", () => {
	const dir = plugin("# comment\n\nOne\nTwo\nThree\nFour\n");
	const tags = ["v1.0.0", "v1.10.0", "v1.2.0"];
	assert.equal(pickTitle("1.0.0", { dir, tags }).title, "One");
	assert.equal(pickTitle("1.2.0", { dir, tags }).title, "Two");
	assert.equal(pickTitle("1.10.0", { dir, tags }).title, "Three"); // 1.10 sorts after 1.2, not before
});

test("defaults to plugin.json's version and counts itself even when untagged", () => {
	const dir = plugin("A\nB\nC\n", "2.0.0");
	const r = pickTitle(undefined, { dir, tags: ["v1.0.0"] });
	assert.equal(r.version, "2.0.0");
	assert.equal(r.title, "B");
	assert.equal(r.label, 'v2.0.0 — "B"');
	assert.equal(r.remaining, 1);
});

test("wraps around when the list runs out", () => {
	const dir = plugin("A\nB\n");
	assert.equal(pickTitle("1.0.2", { dir, tags: ["v1.0.0", "v1.0.1"] }).title, "A");
});

test("no titles file falls back to the bare tag", () => {
	const dir = plugin(null);
	const r = pickTitle("1.0.0", { dir, tags: [] });
	assert.equal(r.label, "v1.0.0");
	assert.equal(r.total, 0);
});

test("a release sorts after its prerelease", () => {
	assert.ok(cmp("1.0.0", "1.0.0-rc.1") > 0);
	assert.ok(cmp("1.0.0-rc.1", "1.0.0-rc.2") < 0);
});
