import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	buildBody,
	buildFormUrl,
	checkContract,
	checkEligibility,
	notifyRelease,
	parseCliArgs,
	parseFrontMatter,
	parseTemplate,
	waitForRelease,
} from "../scripts/notify-plugin-repository.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const TEMPLATE = fixture("PluginUpdate.yml");
const OURS = fixture("listing-duet-tool-align.md");
const DUET3D_CLT = fixture("listing-closedlooptuning.md");

// --- parsing the real files --------------------------------------------------------------------------

test("front matter of a real listing", () => {
	const l = parseFrontMatter(OURS);
	assert.equal(l.repo, "duet-tool-align");
	assert.equal(l.author, "jaysuk");
	assert.equal(l.plugin_submitted_by, "jaysuk");
	assert.equal(l.abstract, "Use your camera to align tools");
	assert.deepEqual(parseFrontMatter("no front matter"), {});
});

test("the real update template parses to the fields the automation expects", () => {
	const tpl = parseTemplate(TEMPLATE);
	assert.equal(tpl.title, "[PluginUpdate]: ");
	assert.deepEqual(tpl.labels, ["plugin-update"]);
	assert.deepEqual(tpl.fields.map((f) => [f.type, f.id, f.label]), [
		["input", "PluginAbstract", "Summary"],
		["input", "PluginID", "Plugin ID"],
		["checkboxes", "AgreeTerms", "Terms and Conditions"],
	]);
	assert.equal(tpl.fields[2].options.length, 1);
	assert.match(tpl.fields[2].options[0], /no malicious code/);
	assert.deepEqual(checkContract(tpl), []);
});

test("template drift is detected rather than papered over", () => {
	const drifted = TEMPLATE.replace("[PluginUpdate]: ", "[Update]: ").replace("labels: [plugin-update]", "labels: [update]") +
		"\n- type: input\n  id: PluginVersion\n  attributes:\n    label: Version\n  validations:\n    required: true\n";
	const problems = checkContract(parseTemplate(drifted)).join(" | ");
	assert.match(problems, /title prefix/);
	assert.match(problems, /plugin-update/);
	assert.match(problems, /unknown field "PluginVersion"/);
	assert.match(checkContract(parseTemplate(TEMPLATE.replace("id: PluginID", "id: Renamed"))).join(" | "), /missing field "PluginID"/);
});

// --- the issue we would file -------------------------------------------------------------------------

test("body is laid out exactly as GitHub renders an issue form (headings, values, ticked terms)", () => {
	const tpl = parseTemplate(TEMPLATE);
	const body = buildBody(tpl, { PluginAbstract: "Use your camera to align tools", PluginID: "duet-tool-align" });
	assert.equal(
		body,
		"### Summary\n\nUse your camera to align tools\n\n### Plugin ID\n\nduet-tool-align\n\n### Terms and Conditions\n\n- [x] I confirm that this plugin contains no malicious code and/nor ads.\n",
	);
	assert.throws(() => buildBody(tpl, { PluginID: "x" }), /no value for "PluginAbstract"/);
});

test("form link targets the update template and prefills title and text fields, not the checkbox", () => {
	const tpl = parseTemplate(TEMPLATE);
	const url = buildFormUrl(tpl, "[PluginUpdate]: Duet Tool Align v1.2.1", { PluginAbstract: "Use your camera & align", PluginID: "duet-tool-align" });
	assert.ok(url.startsWith("https://github.com/Duet3D/PluginRepository/issues/new?template=PluginUpdate.yml&"));
	assert.match(url, /title=%5BPluginUpdate%5D%3A%20Duet%20Tool%20Align%20v1\.2\.1/);
	assert.match(url, /PluginAbstract=Use%20your%20camera%20%26%20align/);
	assert.match(url, /PluginID=duet-tool-align/);
	assert.doesNotMatch(url, /AgreeTerms/);
});

// --- who gets notified -------------------------------------------------------------------------------

test("eligibility: ours is notified; everything the repository would reject is skipped with a reason", () => {
	const base = { owner: "jaysuk", repo: "duet-tool-align", user: "jaysuk", tag: "v1.2.1" };
	assert.deepEqual(checkEligibility({ ...base, listing: parseFrontMatter(OURS) }), { ok: true });

	const why = (over) => checkEligibility({ ...base, listing: parseFrontMatter(OURS), ...over }).reason ?? "";
	assert.match(checkEligibility({ ...base, listing: null }).reason, /not listed/);
	assert.match(why({ tag: "v1.2.0" }), /already shows v1\.2\.0/);
	assert.match(why({ tag: "v1.3.0-rc.1" }), /pre-release/);
	assert.match(why({ user: "someoneelse" }), /submitted by jaysuk.*you are someoneelse/);
});

test("ClosedLoopTuning: the listing is Duet3D's own, so it is never notified from jaysuk's fork", () => {
	const r = checkEligibility({ listing: parseFrontMatter(DUET3D_CLT), owner: "jaysuk", repo: "ClosedLoopTuningPlugin", user: "jaysuk", tag: "v2.8.0" });
	assert.equal(r.ok, false);
	assert.match(r.reason, /belongs to Duet3D\/ClosedLoopTuningPlugin, not jaysuk\/ClosedLoopTuningPlugin/);
});

// --- waiting for the release -------------------------------------------------------------------------

const ghFrom = (script) => {
	const calls = [];
	const queue = [...script];
	const gh = (args) => {
		calls.push(args);
		return typeof queue[0] === "function" ? queue.shift()(args) : (queue.length > 1 ? queue.shift() : queue[0]);
	};
	gh.calls = calls;
	return gh;
};
const run = (status, conclusion = "") => JSON.stringify([{ databaseId: 1, status, conclusion, workflowName: "Release" }]);
const RELEASE_OK = JSON.stringify({ isDraft: false, isPrerelease: false, assets: [{ name: "P-1.0.0-srcmap.zip" }, { name: "P-1.0.0.zip" }] });
const sleep = async () => {};

test("waitForRelease polls until the Release run succeeds, then checks the release has a plugin ZIP", async () => {
	const gh = ghFrom([ "[]", run("in_progress"), run("completed", "success"), RELEASE_OK ]);
	await waitForRelease({ slug: "o/r", tag: "v1.0.0", gh, sleep });
	assert.equal(gh.calls.filter((c) => c[0] === "run").length, 3);
	assert.deepEqual(gh.calls.at(-1).slice(0, 3), ["release", "view", "v1.0.0"]);
});

test("waitForRelease fails clearly: failed run, no run ever, ZIP-less release", async () => {
	await assert.rejects(waitForRelease({ slug: "o/r", tag: "v1", gh: ghFrom([run("completed", "failure")]), sleep }), /finished with "failure"/);
	await assert.rejects(waitForRelease({ slug: "o/r", tag: "v1", gh: ghFrom(["[]"]), sleep, maxPollsNoRun: 2 }), /no Release workflow run found/);
	const srcmapOnly = JSON.stringify({ isDraft: false, assets: [{ name: "P-1-srcmap.zip" }] });
	await assert.rejects(waitForRelease({ slug: "o/r", tag: "v1", gh: ghFrom([run("completed", "success"), srcmapOnly]), sleep }), /no published plugin ZIP/);
});

// --- the whole flow with fakes ----------------------------------------------------------------------

function world({ listing = OURS, perms = { pull: true }, openIssues = [], release = "ok" } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "notify-"));
	writeFileSync(join(dir, "plugin.json"), JSON.stringify({ id: "DuetToolAlign", name: "Duet Tool Align", version: "1.2.1" }));
	const events = { opened: [], created: [], confirmed: [] };
	const deps = {
		fetchText: async (url) => (url.includes("/src/plugins/") ? listing : url.endsWith("PluginUpdate.yml") ? TEMPLATE : null),
		gh: (args) => {
			const a = args.join(" ");
			if (a.startsWith("api user")) return "jaysuk";
			if (a.startsWith("issue list")) return JSON.stringify(openIssues);
			if (a.startsWith("api repos/Duet3D/PluginRepository")) return JSON.stringify(perms);
			if (a.startsWith("run list")) return release === "ok" ? run("completed", "success") : run("completed", "failure");
			if (a.startsWith("release view")) return RELEASE_OK;
			if (a.startsWith("issue create")) {
				events.created.push(args);
				return "https://github.com/Duet3D/PluginRepository/issues/2000";
			}
			throw new Error(`unexpected gh ${a}`);
		},
		open: (url) => events.opened.push(url),
		confirm: async (q) => (events.confirmed.push(q), false),
		sleep,
	};
	return { dir, deps, events, log: () => {}, slug: "jaysuk/duet-tool-align" };
}

test("default (no triage rights): waits for the release, then opens the prefilled form once", async () => {
	const w = world();
	const r = await notifyRelease({ ...w, tag: "v1.2.1" });
	assert.equal(r.status, "opened");
	assert.equal(w.events.opened.length, 1);
	assert.match(w.events.opened[0], /title=%5BPluginUpdate%5D%3A%20Duet%20Tool%20Align%20v1\.2\.1/);
	assert.match(w.events.opened[0], /PluginID=duet-tool-align/);
	assert.equal(w.events.created.length, 0);
});

test("--no-open still returns the link and does not launch a browser", async () => {
	const w = world();
	const r = await notifyRelease({ ...w, tag: "v1.2.1", open: false });
	assert.equal(r.status, "opened");
	assert.equal(w.events.opened.length, 0);
	assert.ok(r.url.includes("template=PluginUpdate.yml"));
});

test("with triage access it creates the issue itself with the plugin-update label, after the terms are accepted", async () => {
	const w = world({ perms: { triage: true } });
	const r = await notifyRelease({ ...w, tag: "v1.2.1", acceptTerms: true });
	assert.equal(r.status, "created");
	const args = w.events.created[0];
	assert.equal(args[args.indexOf("--label") + 1], "plugin-update");
	assert.equal(args[args.indexOf("--title") + 1], "[PluginUpdate]: Duet Tool Align v1.2.1");
	assert.match(args[args.indexOf("--body") + 1], /### Plugin ID\n\nduet-tool-align\n/);
	assert.equal(w.events.opened.length, 0);
});

test("with triage access but terms not accepted, it falls back to the form instead of ticking them", async () => {
	const w = world({ perms: { triage: true } });
	const r = await notifyRelease({ ...w, tag: "v1.2.1" });
	assert.equal(r.status, "opened");
	assert.equal(w.events.confirmed.length, 1);
	assert.match(w.events.confirmed[0], /no malicious code/);
	assert.equal(w.events.created.length, 0);
});

test("--mode api without triage access is refused rather than creating a label-less issue", async () => {
	await assert.rejects(notifyRelease({ ...world(), tag: "v1.2.1", mode: "api" }), /needs triage or push access/);
});

test("skips without touching anything when not eligible, already open, or already listed", async () => {
	for (const [w, tag, re] of [
		[world({ listing: DUET3D_CLT }), "v2.8.0", /belongs to/],
		[world({ listing: "" }), "v1.2.1", /not listed/],
		[world({ openIssues: [{ number: 1990, title: "[PluginUpdate]: Duet Tool Align v1.2.1" }] }), "v1.2.1", /#1990.*already open/],
		[world(), "v1.2.0", /already shows/],
	]) {
		const r = await notifyRelease({ ...w, tag });
		assert.equal(r.status, "skipped");
		assert.match(r.reason, re);
		assert.equal(w.events.opened.length + w.events.created.length, 0);
	}
});

test("stops with an explanation if the form changed, or the release failed", async () => {
	const drifted = world();
	const real = drifted.deps.fetchText;
	drifted.deps.fetchText = async (u) => (u.endsWith("PluginUpdate.yml") ? (await real(u)).replace("labels: [plugin-update]", "labels: []") : real(u));
	await assert.rejects(notifyRelease({ ...drifted, tag: "v1.2.1" }), /form has changed, so no issue was filed/);
	assert.equal(drifted.events.opened.length, 0);

	const failed = world({ release: "failed" });
	await assert.rejects(notifyRelease({ ...failed, tag: "v1.2.1" }), /finished with "failure"/);
	assert.equal(failed.events.opened.length, 0);
});

test("--dry-run shows the issue and changes nothing (and does not wait for the release)", async () => {
	const w = world({ release: "failed" });
	const lines = [];
	const r = await notifyRelease({ ...w, tag: "v1.2.1", dryRun: true, log: (m) => lines.push(m) });
	assert.equal(r.status, "dry-run");
	assert.match(lines.join("\n"), /\[PluginUpdate\]: Duet Tool Align v1\.2\.1[\s\S]*### Summary/);
	assert.equal(w.events.opened.length + w.events.created.length, 0);
});

test("CLI options", () => {
	assert.deepEqual(parseCliArgs(["v1.2.1", "--dry-run", "--no-open"]), { mode: "auto", acceptTerms: false, open: false, wait: true, dryRun: true, version: "1.2.1" });
	assert.equal(parseCliArgs(["--mode", "form"]).mode, "form");
	assert.throws(() => parseCliArgs(["--mode", "bogus"]), /--mode must be/);
	assert.throws(() => parseCliArgs(["--wat"]), /Unknown option/);
});
