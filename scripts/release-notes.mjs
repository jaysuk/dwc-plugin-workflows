#!/usr/bin/env node
/**
 * Assemble the full GitHub Release body for the plugin repo in the working directory.
 *
 *   node release-notes.mjs --version v1.3.0 > release-notes.md
 *
 * With a CHANGELOG.md section for the version (written by hand or drafted by draft-release-notes.mjs):
 *
 *   <the section>            <- what readers see first, and all the in-app update checker shows
 *   <install footer>         <- `---` + "### 📦 Install" ... + the dwc-plugin-update marker
 *   <details> All changes    <- the generated Conventional-Commit list, collapsed
 *
 * The in-app update checker (dwc-plugin-runtime cleanReleaseNotes) cuts everything from the `---` before
 * "### 📦 Install" to the end, so the footer AND the collapsed list stay out of the in-plugin notes. The
 * <details> block would not render there (the checker HTML-escapes), which is why it goes after the cut.
 *
 * Without a section it falls back to the generated list followed by the footer, as before.
 *
 * The footer reads DWC_VERSION / DWC_SHA / DWC_REF / DWC36_* from the environment (see release-footer.mjs).
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSection } from "./changelog-section.mjs";
import { renderFooter } from "./release-footer.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export function assembleNotes({ section = "", generated, footer }) {
	if (section.trim()) {
		return [
			section.trim(),
			"",
			footer.trim(),
			"",
			"<details>",
			"<summary>All changes</summary>",
			"",
			generated.trim(),
			"",
			"</details>",
			"",
		].join("\n");
	}
	return `${generated.trim()}\n\n${footer.trim()}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const args = process.argv.slice(2);
	const i = args.indexOf("--version");
	const tag = i >= 0 ? args[i + 1] : "";
	if (!tag) {
		console.error("Usage: node release-notes.mjs --version vX.Y.Z");
		process.exit(2);
	}
	const dir = process.cwd();
	const generated = execFileSync(process.execPath, [join(here, "changelog.mjs"), "--version", tag], {
		cwd: dir,
		encoding: "utf8",
	});
	const section = readSection(dir, tag);
	if (section) console.error(`Using the CHANGELOG.md section for ${tag}.`);
	else console.error(`No CHANGELOG.md section for ${tag} - using the generated Conventional-Commit changelog.`);
	process.stdout.write(assembleNotes({ section, generated, footer: renderFooter(dir) }));
}
