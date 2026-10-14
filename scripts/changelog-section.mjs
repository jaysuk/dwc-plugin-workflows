#!/usr/bin/env node
/**
 * Print one version's section of the plugin's CHANGELOG.md (the text under `## [x.y.z]` up to the next
 * `## `) for use as the GitHub Release body. Prints nothing and exits 1 when there is no CHANGELOG.md or
 * no such section, so callers can fall back to the generated Conventional-Commit changelog.
 *
 * Run with the plugin repo as the working directory:
 *
 *   node changelog-section.mjs 1.3.0
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches the heading line of a version's section: `## [1.3.0] - date`, `## 1.3.0`, `## v1.3.0`. */
export function sectionHeading(version) {
	return new RegExp(`^##\\s+\\[?v?${escapeRe(version.replace(/^v/, ""))}\\]?(\\s|$)`);
}

/** Return the body of a version's section (trimmed), or "" when there is none or it is empty. */
export function extractSection(changelog, version) {
	const lines = changelog.split(/\r?\n/);
	const heading = sectionHeading(version);
	const start = lines.findIndex((l) => heading.test(l));
	if (start < 0) return "";
	let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
	if (end < 0) end = lines.length;
	return lines.slice(start + 1, end).join("\n").trim();
}

/** Read the plugin's CHANGELOG.md section for a version; "" when there is no file or section. */
export function readSection(dir, version) {
	const file = join(dir, "CHANGELOG.md");
	return existsSync(file) ? extractSection(readFileSync(file, "utf8"), version) : "";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const version = (process.argv[2] ?? "").replace(/^v/, "");
	if (!version) {
		console.error("Usage: node changelog-section.mjs <version>");
		process.exit(2);
	}
	const body = readSection(process.cwd(), version);
	if (!body) process.exit(1);
	process.stdout.write(body + "\n");
}
