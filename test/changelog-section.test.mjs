import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/changelog-section.mjs", import.meta.url));
const run = (dir, version) => spawnSync(process.execPath, [script, version], { cwd: dir, encoding: "utf8" });

const dir = mkdtempSync(join(tmpdir(), "chlog-"));
writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## [1.3.0] - 2026-09-29\n- Added a thing\n\n## [1.2.1]\n- Fixed it\n");

test("prints the requested version's section", () => {
	const r = run(dir, "v1.3.0");
	assert.equal(r.status, 0);
	assert.equal(r.stdout, "- Added a thing\n");
});

test("exits 1 (so the workflow falls back) for an unknown version or a missing file", () => {
	assert.equal(run(dir, "9.9.9").status, 1);
	assert.equal(run(mkdtempSync(join(tmpdir(), "empty-")), "1.3.0").status, 1);
});
