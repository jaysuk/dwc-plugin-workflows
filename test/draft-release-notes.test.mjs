import assert from "node:assert/strict";
import { delimiter } from "node:path";
import { test } from "node:test";
import {
	buildPrompt,
	claudeArgs,
	cleanDraft,
	findClaude,
	insertSection,
	lintNotes,
	parseLog,
	previousTag,
} from "../scripts/draft-release-notes.mjs";

const RS = "\x1e";
const FS = "\x1f";

test("parseLog keeps bodies, drops trailers and release/version-bump commits", () => {
	const raw = [
		`aaa111${FS}fix: stop the hold dithering${FS}It flutters at P=340.\n\nCo-Authored-By: Claude <x@y>${RS}`,
		`bbb222${FS}chore(release): v1.2.0${FS}${RS}`,
		`ccc333${FS}1.2.0${FS}${RS}`,
		`ddd444${FS}feat: new panel${FS}${RS}`,
	].join("\n");
	const commits = parseLog(raw);
	assert.deepEqual(commits.map((c) => c.hash), ["aaa111", "ddd444"]);
	assert.equal(commits[0].body, "It flutters at P=340.");
	assert.equal(commits[1].body, "");
});

test("previousTag is the newest tag strictly below the version", () => {
	const tags = ["v1.0.0", "v1.10.0", "v1.2.0", "v1.3.0"];
	assert.equal(previousTag(tags, "1.3.0"), "v1.2.0"); // re-drafting after tagging still picks the base
	assert.equal(previousTag(tags, "1.11.0"), "v1.10.0"); // numeric, not lexical
	assert.equal(previousTag(tags, "1.0.0"), "");
});

test("buildPrompt includes commits, bodies, stat and previous notes; truncates long bodies", () => {
	const p = buildPrompt({
		name: "Closed Loop Tuning",
		version: "v2.7.0",
		previousVersion: "v2.6.4",
		commits: [{ hash: "abc", subject: "fix: thing", body: "x".repeat(5000) }],
		diffStat: " src/a.ts | 2 +-",
		previousNotes: "Last time we fixed stuff.",
	});
	assert.match(p, /Plugin: Closed Loop Tuning/);
	assert.match(p, /previous release: v2\.6\.4/);
	assert.match(p, /### abc fix: thing/);
	assert.match(p, /\[\.\.\.truncated\]/);
	assert.match(p, /src\/a\.ts/);
	assert.match(p, /Last time we fixed stuff\./);
});

test("buildPrompt reports commits dropped to stay within the size cap", () => {
	const commits = Array.from({ length: 40 }, (_, i) => ({ hash: `h${i}`, subject: "fix: x", body: "y".repeat(2400) }));
	const p = buildPrompt({ name: "P", version: "v1.0.0", previousVersion: "", commits });
	assert.match(p, /further commit\(s\) omitted for length/);
});

test("cleanDraft strips a wrapping fence and a version heading", () => {
	assert.equal(cleanDraft("```markdown\n### ✨ New\n- **A** thing\n```"), "### ✨ New\n- **A** thing");
	assert.equal(cleanDraft("## [1.2.0] - 2026-10-14\n\nHeadline.\n"), "Headline.");
	assert.equal(cleanDraft("  Headline.\n"), "Headline.");
});

test("lintNotes flags what the in-app renderer cannot show, and passes clean notes", () => {
	const clean = "A **headline**.\n\n### ✨ New\n- **Thing** that `M123` does.\n> a quote";
	assert.deepEqual(lintNotes(clean), []);
	const has = (text, re) => lintNotes(text).some((w) => re.test(w));
	assert.ok(has("see [docs](http://x)", /link/));
	assert.ok(has("a <b>b</b>", /HTML/));
	assert.ok(has("| a | b |", /table/));
	assert.ok(has("- a\n  - nested", /nested/));
	assert.ok(has("* star", /\* /));
	assert.ok(has("para\n---\npara", /---/));
	assert.ok(has("#### deep", /heading/));
	assert.ok(has("", /empty/));
});

test("insertSection creates a changelog, puts new versions first, and guards duplicates", () => {
	const created = insertSection("", "1.3.0", "2026-10-14", "Headline.");
	assert.match(created, /^# Changelog\n/);
	assert.match(created, /## \[1\.3\.0\] - 2026-10-14\n\nHeadline\.\n$/);

	const next = insertSection(created, "1.4.0", "2026-11-01", "Newer.");
	assert.ok(next.indexOf("## [1.4.0]") < next.indexOf("## [1.3.0]"));
	assert.match(next, /Headline\./);

	assert.throws(() => insertSection(next, "1.3.0", "2026-12-01", "Again."), /already has a section for 1\.3\.0/);
	const replaced = insertSection(next, "1.3.0", "2026-12-01", "Replaced.", { force: true });
	assert.match(replaced, /## \[1\.3\.0\] - 2026-12-01\n\nReplaced\.\n/);
	assert.doesNotMatch(replaced, /\nHeadline\./);
	assert.match(replaced, /## \[1\.4\.0\]/); // neighbours untouched
});

test("insertSection keeps hand-written intro text and appends when there are no sections yet", () => {
	const intro = "# Changelog\n\nNotes.\n";
	const out = insertSection(intro, "1.0.0", "2026-10-14", "First.");
	assert.match(out, /^# Changelog\n\nNotes\.\n\n## \[1\.0\.0\]/);
});

test("findClaude: CLAUDE_BIN wins, then PATH, then the newest VS Code extension copy", () => {
	assert.equal(findClaude({ env: { CLAUDE_BIN: "/x/claude" } }), "/x/claude");

	const onPath = findClaude({
		env: { PATH: ["/a", "/b"].join(delimiter) },
		platform: "linux",
		exists: (p) => p.replaceAll("\\", "/") === "/b/claude",
	});
	assert.equal(onPath.replaceAll("\\", "/"), "/b/claude");

	const exts = ["anthropic.claude-code-2.1.9-win32-x64", "anthropic.claude-code-2.1.296-win32-x64", "other.thing-1.0.0"];
	const fromExt = findClaude({
		env: { PATH: "" },
		home: "/home/u",
		platform: "win32",
		list: () => exts,
		exists: (p) => p.includes("2.1.296") && p.endsWith("claude.exe"),
	});
	assert.match(fromExt.replaceAll("\\", "/"), /anthropic\.claude-code-2\.1\.296-win32-x64\/resources\/native-binary\/claude\.exe$/);

	assert.equal(findClaude({ env: { PATH: "" }, home: "/nope", list: () => { throw new Error("ENOENT"); }, exists: () => false }), null);
});

test("claudeArgs runs text-only with no tools and the system prompt from a file", () => {
	const a = claudeArgs({ systemPromptFile: "/tmp/s.md", model: "m" });
	assert.deepEqual(a.slice(0, 5), ["-p", "--output-format", "text", "--tools", ""]);
	assert.ok(a.includes("--no-session-persistence"));
	assert.equal(a[a.indexOf("--system-prompt-file") + 1], "/tmp/s.md");
	assert.equal(a[a.indexOf("--model") + 1], "m");
});
