#!/usr/bin/env node
/**
 * Assemble the GitHub Release body for an npm package (the "core"/library repos), the counterpart of
 * release-notes.mjs for plugins. Run with the package repo as the working directory:
 *
 *   node package-release-notes.mjs --version v1.39.0 > release-notes.md
 *
 * Body = the CHANGELOG.md section for the version if there is one, otherwise the generated Conventional-Commit
 * changelog; then a footer with the install command and the optional .github/release-footer.md (appended
 * verbatim). With a section, the generated list is kept collapsed underneath, as for plugins.
 *
 * release-footer.md may use {{name}}, {{version}} and {{pkg.some.path}} (a value from package.json), e.g.
 * "> RRF baseline: `{{pkg.rrf.baseline}}`".
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSection } from "./changelog-section.mjs";
import { assembleNotes } from "./release-notes.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** Replace {{name}}, {{version}} and {{pkg.a.b}} in `text`; an unknown path is left as-is so it shows up. */
export function applyPlaceholders(text, pkg) {
	return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, path) => {
		if (path === "name" || path === "version") return String(pkg[path]);
		if (!path.startsWith("pkg.")) return whole;
		const v = path.slice(4).split(".").reduce((o, k) => (o == null ? undefined : o[k]), pkg);
		return v == null || typeof v === "object" ? whole : String(v);
	});
}

export function buildPackageFooter({ pkg, extra = "" }) {
	const lines = ["---", "", `> 📦 \`npm install ${pkg.name}@${pkg.version}\``];
	const notes = applyPlaceholders(extra, pkg).trim();
	if (notes) lines.push(notes);
	lines.push("");
	return lines.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const args = process.argv.slice(2);
	const i = args.indexOf("--version");
	const tag = i >= 0 ? args[i + 1] : "";
	if (!tag) {
		console.error("Usage: node package-release-notes.mjs --version vX.Y.Z");
		process.exit(2);
	}
	const dir = process.cwd();
	const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	const extraFile = join(dir, ".github", "release-footer.md");
	const generated = execFileSync(process.execPath, [join(here, "changelog.mjs"), "--version", tag], { cwd: dir, encoding: "utf8" });
	const section = readSection(dir, tag);
	console.error(section ? `Using the CHANGELOG.md section for ${tag}.` : `No CHANGELOG.md section for ${tag} - using the generated Conventional-Commit changelog.`);
	process.stdout.write(
		assembleNotes({
			section,
			generated,
			footer: buildPackageFooter({ pkg, extra: existsSync(extraFile) ? readFileSync(extraFile, "utf8") : "" }),
		}),
	);
}
