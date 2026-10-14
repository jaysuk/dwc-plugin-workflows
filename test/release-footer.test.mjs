import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFooter, resolveDwcRequirement } from "../scripts/release-footer.mjs";

const manifest = { id: "DuetToolAlign", name: "Duet Tool Align", version: "1.2.0", dwcVersion: "auto-major" };
const env = { DWC_VERSION: "3.7.0-beta.1", DWC_SHA: "abc1234", DWC_REF: "v3.7-dev" };
const markers = (s) => [...s.matchAll(/<!-- dwc-plugin-update (\{.*\}) -->/g)].map((m) => JSON.parse(m[1]));

test("single package: one asset, one marker, major.minor requirement", () => {
	const out = buildFooter({ manifest, env });
	assert.match(out, /1\. Download `DuetToolAlign-1\.2\.0\.zip` from the \*\*Assets\*\* below\./);
	assert.match(out, /Built against \*\*DuetWebControl 3\.7\.0-beta\.1\*\* \(`abc1234`, ref `v3\.7-dev`\)/);
	assert.deepEqual(markers(out), [{ version: "1.2.0", dwcVersion: "3.7", asset: "DuetToolAlign-1.2.0.zip" }]);
});

test("dual package: both assets, major-only requirement, second marker for 3.6", () => {
	const out = buildFooter({
		manifest,
		env: { ...env, DWC36_VERSION: "3.6.2", DWC36_SHA: "def5678", DWC36_REF: "v3.6-dev" },
		has36: true,
	});
	assert.match(out, /DuetToolAlign-1\.2\.0\.zip/);
	assert.match(out, /DuetToolAlign-1\.2\.0-dwc36\.zip/);
	assert.match(out, /the 3\.6 package against \*\*DuetWebControl 3\.6\.2\*\* \(`def5678`, ref `v3\.6-dev`\)/);
	assert.deepEqual(markers(out), [
		{ version: "1.2.0", dwcVersion: "3", asset: "DuetToolAlign-1.2.0.zip" },
		{ version: "1.2.0", dwcVersion: "3.6", asset: "DuetToolAlign-1.2.0-dwc36.zip" },
	]);
});

test("falls back sensibly when DWC details are missing (local run)", () => {
	const out = buildFooter({ manifest });
	assert.match(out, /Built against DuetWebControl \(ref `v3\.7-dev`\)/);
	assert.equal(markers(out)[0].dwcVersion, "");
});

test("extra notes are appended before the marker, trimmed", () => {
	const out = buildFooter({ manifest, env, extra: "\n> 📷 Needs the webcam bridge.\n\n" });
	assert.ok(out.indexOf("Needs the webcam bridge") > out.indexOf("Built against"));
	assert.ok(out.indexOf("Needs the webcam bridge") < out.indexOf("<!-- dwc-plugin-update"));
});

test("extra notes that are not quote lines start their own block", () => {
	const out = buildFooter({ manifest, env, extra: "### 🤸 Share it\nSome text." });
	assert.match(out, /version\.\n\n### 🤸 Share it\nSome text\.\n\n<!-- dwc-plugin-update/);
});

test("the footer keeps the shape the update checker strips: --- then ### 📦 Install", () => {
	const out = buildFooter({ manifest, env });
	assert.match(out, /^---\n\n### 📦 Install\n/);
});

test("dwcVersion resolution", () => {
	assert.equal(resolveDwcRequirement("auto", "3.7.0-beta.1", false), "3.7.0-beta.1");
	assert.equal(resolveDwcRequirement("auto-minor", "3.7.0-beta.1", false), "3.7.0");
	assert.equal(resolveDwcRequirement("^3.6", "3.7.0", false), "^3.6");
});
