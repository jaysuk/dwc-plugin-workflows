#!/usr/bin/env node
/**
 * Cut a plugin release: draft the release notes, bump plugin.json + package.json, commit, and create the
 * annotated version tag. The tag push is what triggers the shared release workflow.
 *
 * Run it from a plugin repo (normally through the plugin's tiny scripts/release.mjs launcher):
 *
 *   npm run release -- 1.3.0            # draft notes, pause for review, bump + commit + tag (push yourself)
 *   npm run release -- 1.3.0 --push     # ...and push the commit and tag, which publishes the release
 *
 * Options:
 *   --no-notes   skip the notes step (the release then uses the generated commit list)
 *   --yes        do not pause for review after drafting (for scripts)
 *   --model <m>  model for the notes draft
 *   --no-notify  do not tell the Duet3D PluginRepository about the release (see below)
 *   --notify <m> how to notify it: auto (default), form or api - see notify-plugin-repository.mjs
 *   --accept-terms  with --notify api: tick the repository's terms checkbox without asking
 *
 * Notes: unless the version already has a CHANGELOG.md section, one is drafted with Claude from the commits
 * since the previous tag (see draft-release-notes.mjs). You then get a chance to read and edit CHANGELOG.md
 * before anything is committed; it is committed together with the version bump.
 *
 * Notify: with --push, once the release workflow has published, a plugin that is listed in
 * github.com/Duet3D/PluginRepository gets its "Plugin Updating" request prepared (the prefilled form opens
 * in your browser). A plugin that is not listed, or whose listing is not yours, is skipped quietly. It can
 * never fail the release. Run it later, or retry, with:  npm run release -- notify [version]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { readSection } from "./changelog-section.mjs";
import { DraftError, draftForVersion, insertSection } from "./draft-release-notes.mjs";
import { notifyRelease, parseCliArgs, reportResult } from "./notify-plugin-repository.mjs";
import { LOW_TITLES_THRESHOLD, pickTitle } from "./release-title.mjs";

export const VERSION_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

/** Set "version" in a JSON manifest, keeping its indentation (tabs or spaces) and a trailing newline. */
export function bumpManifest(text, version) {
	const indent = /^\t/m.test(text) ? "\t" : /^( +)"/m.exec(text)?.[1].length ?? 2;
	const json = JSON.parse(text);
	json.version = version;
	return JSON.stringify(json, null, indent) + "\n";
}

/** Files that may already be modified when a release starts: the ones the release itself writes. */
export const RELEASE_FILES = ["plugin.json", "package.json", "CHANGELOG.md"];

export function unexpectedChanges(porcelain) {
	return porcelain
		.split("\n")
		.map((l) => l.slice(3))
		.filter((f) => f && !RELEASE_FILES.includes(f));
}

function parseArgs(argv) {
	const out = { push: false, notes: true, yes: false, model: undefined, version: undefined, notify: "auto", acceptTerms: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--push") out.push = true;
		else if (a === "--no-notes") out.notes = false;
		else if (a === "--yes") out.yes = true;
		else if (a === "--model") out.model = argv[++i];
		else if (a === "--no-notify") out.notify = "off";
		else if (a === "--notify") out.notify = argv[++i];
		else if (a === "--accept-terms") out.acceptTerms = true;
		else if (!a.startsWith("-")) out.version ??= a;
		else {
			console.error(`Unknown option ${a}`);
			process.exit(1);
		}
	}
	return out;
}

async function main() {
	const dir = process.cwd();
	if (process.argv[2] === "notify") return notifyCommand(dir, process.argv.slice(3));
	const git = (args, stdio = "inherit") => execFileSync("git", args, { cwd: dir, stdio, encoding: "utf8" });
	const args = parseArgs(process.argv.slice(2));

	if (!args.version || !VERSION_RE.test(args.version)) {
		console.error("Usage: npm run release -- <version> [--push] [--no-notes] [--yes]   e.g. 1.3.0");
		process.exit(1);
	}
	const { version } = args;
	const tag = `v${version}`;
	const manifest = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"));

	if (git(["tag", "-l", tag], "pipe").trim()) {
		console.error(`Tag ${tag} already exists.`);
		process.exit(1);
	}
	const dirty = unexpectedChanges(git(["status", "--porcelain"], "pipe"));
	if (dirty.length) {
		console.error(`Working tree has uncommitted changes; commit or stash them first:\n  ${dirty.join("\n  ")}`);
		process.exit(1);
	}

	// --- Release notes ------------------------------------------------------------------------------
	const changelogFile = join(dir, "CHANGELOG.md");
	if (args.notes) {
		if (readSection(dir, version)) {
			console.log(`Using the existing CHANGELOG.md section for ${tag}.`);
		} else {
			try {
				const r = draftForVersion(dir, version, { model: args.model, onStatus: (m) => console.log(m) });
				const existing = existsSync(changelogFile) ? readFileSync(changelogFile, "utf8") : "";
				const date = new Date().toISOString().slice(0, 10);
				writeFileSync(changelogFile, insertSection(existing, version, date, r.body));
				console.log(`\n${r.body}\n`);
				for (const w of r.warnings) console.warn(`⚠️  ${w}`);
				console.log(`Drafted the ${tag} section in CHANGELOG.md.`);
			} catch (e) {
				if (!(e instanceof DraftError)) throw e;
				console.error(`\nCould not draft release notes: ${e.message}\nFix that, or release with --no-notes to use the generated commit list.`);
				process.exit(1);
			}
		}
		if (!args.yes && process.stdin.isTTY) {
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			await rl.question("Read and edit CHANGELOG.md now if you want to, then press Enter to release (Ctrl+C to stop): ");
			rl.close();
			if (!readSection(dir, version)) {
				console.error(`CHANGELOG.md no longer has a section for ${tag}; stopping.`);
				process.exit(1);
			}
		}
	}

	// --- Bump, commit, tag --------------------------------------------------------------------------
	// Bump only what differs: a repo cutting the first release of the version it was scaffolded at already
	// has both files at that version, and then there may be nothing to commit - just tag the current commit.
	const bumped = ["plugin.json", "package.json"].filter((f) => {
		if (!existsSync(join(dir, f))) return false;
		const text = readFileSync(join(dir, f), "utf8");
		if (JSON.parse(text).version === version) return false;
		writeFileSync(join(dir, f), bumpManifest(text, version));
		return true;
	});
	if (bumped.length) console.log(`Bumped ${bumped.join(" + ")} -> ${version}`);
	else console.log(`plugin.json${existsSync(join(dir, "package.json")) ? " + package.json are" : " is"} already at ${version}.`);

	git(["add", ...bumped, ...(existsSync(changelogFile) ? ["CHANGELOG.md"] : [])]);
	let staged = true;
	try {
		git(["diff", "--cached", "--quiet"], "pipe");
		staged = false; // exit 0: nothing staged
	} catch {
		/* exit 1: there are staged changes */
	}
	if (staged) git(["commit", "-m", `chore(release): ${tag}`]);
	git(["tag", "-a", tag, "-m", `${manifest.name || manifest.id} ${tag}`]);
	console.log(`${staged ? "Committed and tagged" : "Tagged the current commit as"} ${tag}`);

	const t = pickTitle(version, { dir });
	console.log(`Release title: ${t.label}`);
	if (t.total === 0) {
		console.warn("\n⚠️  No scripts/release-titles.txt - the release will use the bare tag as its title.");
	} else if (t.remaining <= LOW_TITLES_THRESHOLD) {
		console.warn(`\n⚠️  Only ${t.remaining} unused release title(s) left - add more to scripts/release-titles.txt before the next few releases.`);
	}

	if (args.push) {
		git(["push"]);
		git(["push", "origin", tag]);
		console.log("Pushed. CI will build the ZIP and publish the GitHub Release.");
		if (args.notify !== "off") {
			console.log("\nPluginRepository: checking whether this release should be announced ...");
			try {
				reportResult(await notifyRelease({ dir, tag, mode: args.notify, acceptTerms: args.acceptTerms }));
			} catch (e) {
				// Never fail a release that has already been pushed. The command to retry is in the message.
				console.warn(`⚠️  Could not prepare the PluginRepository update: ${e.message}\n   Retry later with:  npm run release -- notify ${version}`);
			}
		}
	} else {
		console.log(`Not pushed. When ready:  git push && git push origin ${tag}`);
		console.log("After the release is published:  npm run release -- notify   (announces it to the Duet3D PluginRepository if the plugin is listed)");
	}
}

/** `npm run release -- notify [version] [options]`: the notification step on its own (to retry or run later). */
async function notifyCommand(dir, argv) {
	const args = parseCliArgs(argv);
	const version = args.version ?? JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")).version;
	try {
		reportResult(await notifyRelease({ dir, tag: `v${version}`, ...args }));
	} catch (e) {
		console.error(e.message);
		process.exit(1);
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((e) => {
		console.error(e.message);
		process.exit(1);
	});
}
