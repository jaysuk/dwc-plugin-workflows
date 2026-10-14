#!/usr/bin/env node
/**
 * Draft user-facing release notes for the next version with Claude, and write them into the plugin's
 * CHANGELOG.md for you to review and edit BEFORE you release.
 *
 *   node draft-release-notes.mjs [version] [options]      # run from the plugin repo
 *
 *   version        defaults to plugin.json's version (bump it first, or pass the version you are about to release)
 *   --print        print the draft instead of writing CHANGELOG.md
 *   --force        replace the version's section if CHANGELOG.md already has one
 *   --since <tag>  start from this tag instead of the newest tag below the version
 *   --model <id>   model to use (default: the Claude Code CLI's default)
 *   --prompt-only  print the prompt that would be sent, and stop (nothing is called or written)
 *
 * Then edit CHANGELOG.md, commit it, and release as usual: the release workflow uses the section as the
 * release notes (see release-notes.mjs) and keeps the generated commit list collapsed underneath.
 *
 * It sends the commit subjects and bodies since the previous tag, a diff stat, and the previous release's
 * notes (for tone) to the Claude Code CLI in text-only mode (no tools). The CLI is found via $CLAUDE_BIN,
 * then PATH, then the copy bundled in the Claude Code VS Code extension.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractSection, sectionHeading } from "./changelog-section.mjs";
import { cmp } from "./release-title.mjs";

// ---------------------------------------------------------------------------------------------------
// Prompt

export const SYSTEM_PROMPT = `You write release notes for a plugin for DuetWebControl, the web interface of RepRapFirmware (3D printers, CNC and laser machines). Readers are makers who USE the plugin, not its developers. You are given the git commits and a diff stat for one release. Turn them into notes a user would actually want to read.

Rules:
- Open with one or two sentences saying what this release is about (the headline), with the key feature in **bold**. A small release gets a short headline and a few bullets; do not pad.
- Then group the changes under only those of these headings that apply: "### ✨ New", "### 🔧 Improved", "### 🐛 Fixed", "### ⚠️ Changed" (anything that alters behaviour users may rely on, or needs action).
- Each bullet: a **bold lead phrase**, then one or two sentences on what the user sees or can now do, and why it matters. Describe the symptom that was fixed in the user's terms (what went wrong on the machine or in the UI), not the code that caused it.
- Merge commits that belong together into one bullet. Leave out anything with no user-visible effect (tests, refactors, CI, build tooling, internal plans, docs) unless it changes what users get.
- Never mention commit hashes, plan or section references (like "PLAN-v2.7 §2"), file names, function or variable names. Use the names of menus, panels, settings, buttons, G-code and M-codes that a user would recognise, in \`code\` where they are literal.
- Use only what the commits and diff stat support. If a detail is unclear, describe it conservatively; do not invent behaviour, numbers or hardware claims.
- Match the tone and rough length of the previous release's notes if they are provided.

Formatting - the notes are shown in a small renderer, so use ONLY: ### headings, **bold**, \`code\`, single-level bullets starting with "- ", "> " quote lines, and plain paragraphs. No links, tables, HTML, nested bullets, italics, images, code fences or horizontal rules.

Output only the notes body: no title, no version heading, no preamble, no closing remarks, and do not wrap it in a code fence.`;

const MAX_BODY_CHARS = 2500;
const MAX_COMMIT_CHARS = 60_000;
const MAX_STAT_LINES = 80;

export function buildPrompt({ name, version, previousVersion, commits, diffStat = "", previousNotes = "" }) {
	const parts = [`Plugin: ${name}`, `Release: ${version}${previousVersion ? ` (previous release: ${previousVersion})` : " (first release)"}`, ""];

	let used = 0;
	const rendered = [];
	let omitted = 0;
	for (const c of commits) {
		const body = c.body.length > MAX_BODY_CHARS ? `${c.body.slice(0, MAX_BODY_CHARS)}\n[...truncated]` : c.body;
		const block = `### ${c.hash} ${c.subject}${body ? `\n${body}` : ""}`;
		if (used + block.length > MAX_COMMIT_CHARS) {
			omitted++;
			continue;
		}
		used += block.length;
		rendered.push(block);
	}
	parts.push(`Commits since ${previousVersion || "the start"} (${commits.length}):`, "", rendered.join("\n\n"));
	if (omitted) parts.push("", `[${omitted} further commit(s) omitted for length]`);

	const stat = diffStat.split("\n").slice(0, MAX_STAT_LINES).join("\n").trim();
	if (stat) parts.push("", "Diff stat:", "", stat);

	if (previousNotes.trim()) {
		parts.push("", `The previous release's notes, for tone and length only (do not repeat them):`, "", previousNotes.trim().slice(0, 3000));
	}
	parts.push("", "Write the release notes now.");
	return parts.join("\n");
}

// ---------------------------------------------------------------------------------------------------
// Commits

/** Parse `git log --pretty=format:%h%x1f%s%x1f%b%x1e` output into commits, dropping release/version-bump noise. */
export function parseLog(raw) {
	const commits = [];
	for (const record of raw.split("\x1e").map((r) => r.trim()).filter(Boolean)) {
		const [hash, subject = "", rawBody = ""] = record.split("\x1f");
		if (/^chore\(release\)/i.test(subject) || /^v?\d+\.\d+\.\d+\b/.test(subject)) continue;
		const body = rawBody
			.split(/\r?\n/)
			.filter((l) => !/^(co-authored-by|signed-off-by):/i.test(l.trim()))
			.join("\n")
			.trim();
		commits.push({ hash, subject: subject.trim(), body });
	}
	return commits;
}

/** The newest tag strictly below `version` (so re-drafting after tagging still diffs against the right base). */
export function previousTag(tags, version) {
	const below = tags.filter((t) => t && cmp(t, version) < 0);
	below.sort(cmp);
	return below.at(-1) ?? "";
}

function git(args, cwd) {
	try {
		return execFileSync("git", args, { encoding: "utf8", cwd, maxBuffer: 64 * 1024 * 1024 }).trim();
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------------------------------
// Draft clean-up and checks

/** Strip a wrapping code fence and any version heading the model added despite instructions. */
export function cleanDraft(text) {
	let s = text.trim();
	const fence = s.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
	if (fence) s = fence[1].trim();
	s = s.replace(/^#{1,2}\s+\[?v?\d+\.\d+\.\d+[^\n]*\n+/, "");
	return s.trim();
}

/**
 * Problems that would render badly in the in-app update checker (which supports ## / ### headings, **bold**,
 * `code`, "- " bullets, "> " quotes and "---") or break the footer cut. Returns human-readable warnings.
 */
export function lintNotes(text) {
	const warnings = [];
	const lines = text.split(/\r?\n/);
	const flag = (re, msg) => {
		const n = lines.findIndex((l) => re.test(l));
		if (n >= 0) warnings.push(`line ${n + 1}: ${msg}`);
	};
	if (!text.trim()) warnings.push("the draft is empty");
	flag(/\]\(/, "contains a link - the in-app notes show it as raw text");
	flag(/<\/?[a-z][^>]*>/i, "contains HTML - the in-app notes show it as escaped text");
	flag(/^\s*\|.*\|\s*$/, "looks like a table - tables are not rendered");
	flag(/^\s+[-*]\s/, "nested bullet - only single-level \"- \" bullets are rendered");
	flag(/^\*\s/, "uses \"* \" bullets - only \"- \" bullets are rendered");
	flag(/^```/, "contains a code fence");
	flag(/^#{4,}\s|^#\s/, "uses a heading level other than ## / ###");
	flag(/^---+\s*$/, "contains a --- line, which would cut the notes short in the in-app view");
	return warnings;
}

// ---------------------------------------------------------------------------------------------------
// CHANGELOG.md

const CHANGELOG_INTRO = `# Changelog

Release notes for each version. The GitHub Release body for a version is taken from its section here, so
write (or draft with \`draft-release-notes.mjs\`) the section before tagging. The generated commit list is
kept collapsed under it on the release page.
`;

/** Insert (or, with force, replace) a version's section, newest first. Throws if it exists and !force. */
export function insertSection(changelog, version, date, body, { force = false } = {}) {
	const text = (changelog ?? "").replace(/\r\n/g, "\n");
	const section = `## [${version}] - ${date}\n\n${body.trim()}\n`;

	if (!text.trim()) return `${CHANGELOG_INTRO}\n${section}`;

	const lines = text.split("\n");
	const heading = sectionHeading(version);
	const existing = lines.findIndex((l) => heading.test(l));
	if (existing >= 0) {
		if (!force) throw new Error(`CHANGELOG.md already has a section for ${version} (use --force to replace it)`);
		let end = lines.findIndex((l, i) => i > existing && /^##\s/.test(l));
		if (end < 0) end = lines.length;
		return [...lines.slice(0, existing), ...section.split("\n"), ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n");
	}

	const firstSection = lines.findIndex((l) => /^##\s/.test(l));
	if (firstSection < 0) return `${text.replace(/\n*$/, "\n")}\n${section}`;
	return [...lines.slice(0, firstSection), ...section.split("\n"), ...lines.slice(firstSection)].join("\n").replace(/\n{3,}/g, "\n\n");
}

// ---------------------------------------------------------------------------------------------------
// Claude Code CLI

/** Locate the Claude Code CLI: $CLAUDE_BIN, then PATH, then the copy bundled in the VS Code extension. */
export function findClaude({ env = process.env, home = homedir(), exists = existsSync, list = readdirSync, platform = process.platform } = {}) {
	if (env.CLAUDE_BIN) return env.CLAUDE_BIN;

	const names = platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
	for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
		for (const n of names) if (exists(join(dir, n))) return join(dir, n);
	}

	const extDir = join(home, ".vscode", "extensions");
	let entries = [];
	try {
		entries = list(extDir).filter((e) => e.startsWith("anthropic.claude-code-"));
	} catch {
		/* no VS Code extensions directory */
	}
	const versionOf = (e) => e.slice("anthropic.claude-code-".length).split("-")[0];
	entries.sort((a, b) => cmp(versionOf(b), versionOf(a))); // newest first
	for (const e of entries) {
		const bin = join(extDir, e, "resources", "native-binary", platform === "win32" ? "claude.exe" : "claude");
		if (exists(bin)) return bin;
	}
	return null;
}

export function claudeArgs({ systemPromptFile, model, shell = false } = {}) {
	const q = (v) => (shell ? `"${v}"` : v); // .cmd shims run through a shell, which needs quoting
	return [
		"-p",
		"--output-format", "text",
		"--tools", shell ? '""' : "", // text in, text out: no tools
		"--no-session-persistence",
		"--disable-slash-commands",
		"--system-prompt-file", q(systemPromptFile),
		...(model ? ["--model", model] : []),
	];
}

function runClaude(bin, prompt, model) {
	const dir = mkdtempSync(join(tmpdir(), "draft-notes-"));
	const systemPromptFile = join(dir, "system-prompt.md");
	writeFileSync(systemPromptFile, SYSTEM_PROMPT);
	const shell = /\.(cmd|bat)$/i.test(bin);
	try {
		// Run from the temp dir so the plugin's own CLAUDE.md / settings don't colour the notes.
		const r = spawnSync(shell ? `"${bin}"` : bin, claudeArgs({ systemPromptFile, model, shell }), {
			input: prompt,
			encoding: "utf8",
			cwd: dir,
			shell,
			maxBuffer: 16 * 1024 * 1024,
			timeout: 5 * 60 * 1000,
		});
		if (r.error) throw new Error(`could not run Claude (${bin}): ${r.error.message}`);
		if (r.status !== 0) throw new Error(`Claude exited with ${r.status}: ${(r.stderr || r.stdout || "").trim().slice(0, 500)}`);
		return r.stdout;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
	const out = { flags: new Set(), values: {}, positional: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--since" || a === "--model") out.values[a.slice(2)] = argv[++i];
		else if (a.startsWith("--")) out.flags.add(a.slice(2));
		else out.positional.push(a);
	}
	return out;
}

export class DraftError extends Error {}

/**
 * Draft release notes for `version` in the plugin repo `dir`. Returns the draft body (cleaned), lint warnings,
 * and what it was based on. Throws DraftError for expected problems (no commits, no CLI, CLI failure).
 * With `promptOnly` it returns the prompt instead of calling Claude.
 */
export function draftForVersion(dir, version, { since: sinceOverride, model, promptOnly = false, onStatus = () => {} } = {}) {
	const manifest = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"));

	const tags = git(["tag", "-l", "v*"], dir).split("\n");
	const since = sinceOverride || previousTag(tags, version);
	const range = since ? `${since}..HEAD` : "HEAD";
	const commits = parseLog(git(["log", range, "--no-merges", "--pretty=format:%h%x1f%s%x1f%b%x1e"], dir));
	if (!commits.length) throw new DraftError(`No release-worthy commits in ${range} - nothing to write notes about.`);
	const diffStat = since ? git(["diff", "--stat", `${since}..HEAD`], dir) : "";

	const changelogFile = join(dir, "CHANGELOG.md");
	const changelog = existsSync(changelogFile) ? readFileSync(changelogFile, "utf8") : "";
	// Previous release's notes for tone: the first section that isn't this version's.
	const firstOther = changelog.split(/\r?\n/).find((l) => /^##\s/.test(l) && !sectionHeading(version).test(l));
	const previousNotes = firstOther ? extractSection(changelog, firstOther.match(/\d+\.\d+\.\d+[^\]\s]*/)?.[0] ?? "") : "";

	const prompt = buildPrompt({
		name: manifest.name || manifest.id,
		version: `v${version}`,
		previousVersion: since,
		commits,
		diffStat,
		previousNotes,
	});
	if (promptOnly) return { prompt, since, commitCount: commits.length };

	const claude = findClaude();
	if (!claude) throw new DraftError("Could not find the Claude Code CLI. Put `claude` on PATH or set CLAUDE_BIN to its full path.");
	onStatus(`Drafting notes for v${version} from ${commits.length} commit(s) since ${since || "the start"} ...`);

	let body;
	try {
		body = cleanDraft(runClaude(claude, prompt, model));
	} catch (e) {
		throw new DraftError(e.message);
	}
	return { body, warnings: lintNotes(body), since, commitCount: commits.length };
}

function main() {
	const { flags, values, positional } = parseArgs(process.argv.slice(2));
	const dir = process.cwd();
	const manifest = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"));
	const version = (positional[0] || manifest.version).replace(/^v/, "");

	try {
		const r = draftForVersion(dir, version, {
			since: values.since,
			model: values.model,
			promptOnly: flags.has("prompt-only"),
			onStatus: (m) => console.error(m),
		});
		if (flags.has("prompt-only")) {
			process.stdout.write(`--- SYSTEM ---\n${SYSTEM_PROMPT}\n\n--- USER ---\n${r.prompt}\n`);
			return;
		}
		if (flags.has("print")) {
			process.stdout.write(r.body + "\n");
		} else {
			const changelogFile = join(dir, "CHANGELOG.md");
			const changelog = existsSync(changelogFile) ? readFileSync(changelogFile, "utf8") : "";
			const date = new Date().toISOString().slice(0, 10);
			writeFileSync(changelogFile, insertSection(changelog, version, date, r.body, { force: flags.has("force") }));
			console.error(`Wrote the v${version} section to CHANGELOG.md. Review and edit it, commit it, then release.`);
		}
		for (const w of r.warnings) console.error(`⚠️  ${w}`);
	} catch (e) {
		console.error(e.message);
		process.exit(1);
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
