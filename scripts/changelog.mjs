#!/usr/bin/env node
/**
 * Shared release-notes generator for the Duet plugin family (FL, OmBrowser, duet-tool-align,
 * duet-webcam-bridge, dwc-plugin-test-kit and this runtime itself).
 *
 * THIS IS THE SINGLE SOURCE OF TRUTH for how releases are summarised. Each project's release workflow
 * fetches this exact file from the dwc-plugin-runtime repo (pinned to a ref) and runs it, so the
 * "what's a feature vs a fix" formatting only has to be maintained here. To change the format for
 * everyone, edit this file; to roll it out, move the pinned `RUNTIME_REF` in each project's
 * release.yml.
 *
 * What it does: reads `git log <prev-tag>..HEAD`, buckets each Conventional-Commit by type into
 * clearly-titled sections (Features / Bug Fixes / …), links every commit (and a "Full changelog"
 * compare range) to GitHub, and prints Markdown to stdout. The release workflow captures this as the
 * GitHub Release body, usually followed by a project-specific footer (install steps, assets, etc.).
 *
 * Commit format (see each repo's CONTRIBUTING.md): `type(scope): description`, e.g.
 * `feat(files): show thumbnails` or `fix: stop drag bumping neighbours`. A `!` after the type/scope
 * (`feat(api)!: …`) or a `BREAKING CHANGE:` body line flags a breaking change.
 *
 * Repo/owner for links is taken from `$GITHUB_REPOSITORY` (set in GitHub Actions) or, failing that,
 * the local `origin` remote — so it also works when run by hand (`node scripts/changelog.mjs`).
 * The released version is taken from `$GITHUB_REF_NAME` (the tag) or `--version <v>`.
 */
import { execFileSync } from "node:child_process";

// execFileSync (no shell) so git args pass through verbatim - avoids the shell mangling `^`, `%` and
// `..` (cmd.exe on Windows treats `^`/`%` specially; this keeps the script cross-platform).
function git(args) {
	try {
		return execFileSync("git", args, { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
}

const argv = process.argv.slice(2);
function flag(name) {
	const i = argv.indexOf(name);
	return i >= 0 ? (argv[i + 1] ?? "") : "";
}

// --- Resolve owner/repo + server for GitHub links -------------------------------------------------
const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
function resolveRepo() {
	if (process.env.GITHUB_REPOSITORY) {
		return process.env.GITHUB_REPOSITORY; // "owner/repo" in Actions
	}
	// Local fallback: parse the origin remote (handles git@github.com:o/r.git and https URLs).
	const url = git(["config", "--get", "remote.origin.url"]);
	const m = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
	return m ? m[1] : "";
}
const repo = flag("--repo") || resolveRepo();
const repoUrl = repo ? `${serverUrl}/${repo}` : "";
const commitLink = (hash) => (repoUrl ? `([\`${hash}\`](${repoUrl}/commit/${hash}))` : `(\`${hash}\`)`);

// --- Commit range: previous tag → HEAD ------------------------------------------------------------
// When the workflow checks out a tag, HEAD is that tag's commit, so HEAD^ resolves the *previous*
// release tag. No previous tag → whole history.
const prevTag = git(["describe", "--tags", "--abbrev=0", "HEAD^"]);
const range = prevTag ? `${prevTag}..HEAD` : "HEAD";
const thisTag = flag("--version") || process.env.GITHUB_REF_NAME || "";

// %h = short hash, %s = subject, %b = body. Fields/records separated by unit/record separators so
// bodies that span lines (BREAKING CHANGE) don't break parsing.
const RS = "\x1e";
const FS = "\x1f";
const log = git(["log", range, "--no-merges", "--pretty=format:%h%x1f%s%x1f%b%x1e"]);

const SECTIONS = [
	{ key: "breaking", title: "⚠️ Breaking changes" },
	{ key: "feat", title: "✨ Features" },
	{ key: "fix", title: "🐛 Bug Fixes" },
	{ key: "perf", title: "⚡ Performance" },
	{ key: "refactor", title: "♻️ Refactoring" },
	{ key: "docs", title: "📄 Documentation" },
	{ key: "test", title: "🧪 Tests" },
	{ key: "chore", title: "🧹 Chores & CI" },
	{ key: "other", title: "📦 Other changes" },
];
const TYPE_TO_SECTION = {
	feat: "feat", feature: "feat", fix: "fix", bugfix: "fix", perf: "perf", refactor: "refactor",
	docs: "docs", doc: "docs", test: "test", tests: "test",
	chore: "chore", ci: "chore", build: "chore", style: "chore",
};

const buckets = Object.fromEntries(SECTIONS.map((s) => [s.key, []]));

for (const record of log.split(RS).map((r) => r.trim()).filter(Boolean)) {
	const [hash, subject = "", body = ""] = record.split(FS);
	// Skip release/version-bump commits - they're noise in the notes.
	if (/^chore\(release\)/i.test(subject) || /^v?\d+\.\d+\.\d+\b/.test(subject)) {
		continue;
	}
	const m = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
	const breaking = !!(m && m[3]) || /(^|\n)BREAKING CHANGE:/.test(body);
	if (m) {
		const [, type, scope, , desc] = m;
		const section = breaking ? "breaking" : (TYPE_TO_SECTION[type.toLowerCase()] ?? "other");
		const text = scope ? `**${scope}:** ${desc}` : desc;
		buckets[section].push(`- ${text} ${commitLink(hash)}`);
	} else {
		buckets[breaking ? "breaking" : "other"].push(`- ${subject} ${commitLink(hash)}`);
	}
}

// --- Assemble Markdown ----------------------------------------------------------------------------
const out = [];

// Header: date + a "Full changelog" compare range (when both ends are known), so readers can see
// exactly which commits shipped — mirrors the conventional-changelog style.
const date = new Date().toISOString().slice(0, 10);
if (repoUrl && prevTag && thisTag) {
	out.push(`📅 ${date} · [Full changelog](${repoUrl}/compare/${prevTag}...${thisTag})`, "");
} else {
	out.push(`📅 ${date}`, "");
}

let hasNotes = false;
for (const s of SECTIONS) {
	if (buckets[s.key].length) {
		hasNotes = true;
		out.push(`### ${s.title}`, ...buckets[s.key], "");
	}
}
if (!hasNotes) {
	out.push("_No notable changes._");
}

process.stdout.write(out.join("\n").trimEnd() + "\n");
