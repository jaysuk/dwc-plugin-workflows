import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleNotes } from "../scripts/release-notes.mjs";
import { buildFooter } from "../scripts/release-footer.mjs";
import { extractSection } from "../scripts/changelog-section.mjs";

// The in-app update checker's cleanReleaseNotes() (dwc-plugin-runtime src/updates.ts), reproduced so this
// repo can check the contract without depending on the runtime: it cuts from the `---` before the Install
// heading to the end of the body.
const cleanInApp = (body) =>
	body
		.replace(/<!--\s*dwc-plugin-update\s*{[\s\S]*?}\s*-->/g, "")
		.replace(/\r?\n---\r?\n(?:[\s\S]*?(?:\r?\n|^))?### 📦 Install[\s\S]*/m, "")
		.replace(/\r?\n---\s*$/, "")
		.trim();

const manifest = { id: "P", name: "P", version: "1.0.0", dwcVersion: "auto-major" };
const footer = buildFooter({ manifest, env: { DWC_VERSION: "3.7.0" } });
const generated = "📅 2026-10-14 · [Full changelog](https://x)\n\n### ✨ Features\n- raw commit subject (`abc`)\n";

test("with a section: section, then footer, then the commit list collapsed", () => {
	const out = assembleNotes({ section: "Headline.\n\n### 🐛 Fixed\n- **A** fix.", generated, footer });
	assert.ok(out.startsWith("Headline."));
	assert.ok(out.indexOf("### 📦 Install") < out.indexOf("<details>"));
	assert.match(out, /<summary>All changes<\/summary>\n\n📅 2026-10-14/);
	assert.ok(out.trimEnd().endsWith("</details>"));
});

test("the in-app view shows only the section: footer, marker and collapsed list are all cut", () => {
	const section = "Headline.\n\n### 🐛 Fixed\n- **A** fix.";
	const out = assembleNotes({ section, generated, footer });
	assert.equal(cleanInApp(out), section);
});

test("the update-checker marker survives, so the DWC requirement is still readable", () => {
	const out = assembleNotes({ section: "Headline.", generated, footer });
	assert.match(out, /<!-- dwc-plugin-update \{"version":"1\.0\.0","dwcVersion":"3\.7","asset":"P-1\.0\.0\.zip"\} -->/);
});

test("without a section: generated list then footer, no <details>", () => {
	const out = assembleNotes({ section: "", generated, footer });
	assert.ok(out.startsWith("📅 2026-10-14"));
	assert.ok(!out.includes("<details>"));
	assert.ok(out.indexOf("raw commit subject") < out.indexOf("### 📦 Install"));
	assert.match(cleanInApp(out), /raw commit subject/);
});

test("extractSection finds the right version and stops at the next heading", () => {
	const cl = "# Changelog\n\n## [1.4.0] - 2026-11-01\nNewer.\n\n## [1.3.0] - 2026-10-14\nHeadline.\n\n- a\n\n## [1.2.0]\nOld.\n";
	assert.equal(extractSection(cl, "1.3.0"), "Headline.\n\n- a");
	assert.equal(extractSection(cl, "v1.4.0"), "Newer.");
	assert.equal(extractSection(cl, "1.3"), "");
	assert.equal(extractSection(cl, "9.9.9"), "");
});
