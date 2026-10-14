#!/usr/bin/env node
/**
 * Tell the Duet3D PluginRepository (github.com/Duet3D/PluginRepository) that a listed plugin has a new
 * release, by filing the "Plugin Updating" issue its automation expects. Run from a plugin repo, normally
 * through `npm run release` (after the push) or `npm run release -- notify [version]` to do it later.
 *
 * What it does, in order:
 *   1. Works out whether this plugin should be notified at all, and skips quietly if not: it must already be
 *      listed, the listing must be this repo's own (author + repo name) and submitted by the signed-in `gh`
 *      user (the repository rejects updates from anyone else), the version must not be a pre-release, and
 *      the listing must not already show it.
 *   2. Checks the live issue template still looks the way this script expects, and refuses to file anything
 *      if it has drifted (a malformed issue would just be rejected, and cannot be fixed without triage rights).
 *   3. Waits for this repo's Release workflow on the tag to finish: the repository's automation reads the
 *      newest GitHub release and its ZIP, so the issue has to come after they exist.
 *   4. Files the issue. The automation only runs when the `plugin-update` label is on the issue as it opens,
 *      and GitHub only applies labels from an issue form, or to users with triage access. So:
 *        form (default) - open the prefilled update form in your browser; you tick the terms and submit.
 *        api            - used automatically only if your account has triage/push access there: creates the
 *                         issue directly, with the label. Ticks the terms for you, so it asks first
 *                         (or pass --accept-terms).
 *
 * Options: [version] (default: plugin.json's)  --mode auto|form|api  --accept-terms  --no-open  --no-wait
 *          --dry-run (print what would happen and change nothing)
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

export const REPO = "Duet3D/PluginRepository";
export const TEMPLATE_FILE = "PluginUpdate.yml";
const RAW = `https://raw.githubusercontent.com/${REPO}/master`;

/** What the automation's parser is known to accept (see .github/workflows/update_plugin.yml there). */
export const EXPECTED = {
	title: "[PluginUpdate]: ",
	label: "plugin-update",
	ids: ["PluginAbstract", "PluginID", "AgreeTerms"],
};

// ---------------------------------------------------------------------------------------------------
// Parsing

/** Scalar `key: value` lines of a listing's front matter. */
export function parseFrontMatter(md) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md ?? "");
	const out = {};
	if (!m) return out;
	for (const line of m[1].split(/\r?\n/)) {
		const kv = /^([A-Za-z_]\w*):\s*(.*)$/.exec(line);
		if (kv) out[kv[1]] = kv[2].trim();
	}
	return out;
}

/** The parts of a GitHub issue-form template this script needs: title prefix, labels and the fields in order. */
export function parseTemplate(text) {
	const t = text.replace(/\r\n/g, "\n");
	const title = /^title:\s*"?(.*?)"?\s*$/m.exec(t)?.[1] ?? "";
	const labelList = /^labels:\s*\[(.*)\]\s*$/m.exec(t)?.[1] ?? "";
	const labels = labelList.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
	const fields = [];
	for (const block of t.split(/^- type:\s*/m).slice(1)) {
		const type = block.split("\n")[0].trim();
		if (type === "markdown") continue;
		fields.push({
			type,
			id: /^\s+id:\s*(\S+)/m.exec(block)?.[1] ?? "",
			label: /^\s+label:\s*(.+)$/m.exec(block)?.[1].trim() ?? "",
			required: /required:\s*true/.test(block),
			options: type === "checkboxes" ? [...block.matchAll(/^\s+- label:\s*(.+)$/gm)].map((m) => m[1].trim()) : [],
		});
	}
	return { title, labels, fields };
}

/** Problems that mean the template is no longer what this script was written for. Empty when it is fine. */
export function checkContract(tpl) {
	const problems = [];
	if (tpl.title !== EXPECTED.title) problems.push(`title prefix is now "${tpl.title}" (expected "${EXPECTED.title}")`);
	if (!tpl.labels.includes(EXPECTED.label)) problems.push(`it no longer applies the "${EXPECTED.label}" label`);
	const ids = tpl.fields.map((f) => f.id);
	for (const id of ids) if (!EXPECTED.ids.includes(id)) problems.push(`unknown field "${id}"`);
	for (const id of EXPECTED.ids) if (!ids.includes(id)) problems.push(`missing field "${id}"`);
	for (const f of tpl.fields) if (!f.label) problems.push(`field "${f.id}" has no label`);
	return problems;
}

/** The issue body GitHub would generate from the form: `### <label>` then the value, terms ticked. */
export function buildBody(tpl, values) {
	return (
		tpl.fields
			.map((f) => {
				if (f.type === "checkboxes") return `### ${f.label}\n\n${f.options.map((o) => `- [x] ${o}`).join("\n")}`;
				const v = values[f.id];
				if (!v) throw new Error(`no value for "${f.id}"`);
				return `### ${f.label}\n\n${v}`;
			})
			.join("\n\n") + "\n"
	);
}

/** A link to the update form with title and text fields prefilled (checkboxes cannot be, by design). */
export function buildFormUrl(tpl, title, values) {
	const q = [`template=${TEMPLATE_FILE}`, `title=${encodeURIComponent(title)}`];
	for (const f of tpl.fields) if (f.type !== "checkboxes" && values[f.id]) q.push(`${f.id}=${encodeURIComponent(values[f.id])}`);
	return `https://github.com/${REPO}/issues/new?${q.join("&")}`;
}

// ---------------------------------------------------------------------------------------------------
// Should this release be notified?

export function checkEligibility({ listing, owner, repo, user, tag }) {
	const no = (reason) => ({ ok: false, reason });
	if (!listing || !listing.repo) return no(`${repo} is not listed in ${REPO}`);
	if (listing.repo.toLowerCase() !== repo.toLowerCase() || (listing.author ?? "").toLowerCase() !== owner.toLowerCase()) {
		return no(`the "${repo}" listing belongs to ${listing.author}/${listing.repo}, not ${owner}/${repo}`);
	}
	if ((listing.plugin_submitted_by ?? "").toLowerCase() !== user.toLowerCase()) {
		return no(`the listing was submitted by ${listing.plugin_submitted_by}; the repository only accepts update requests from them (you are ${user})`);
	}
	if (tag.replace(/^v/, "").includes("-")) return no(`${tag} is a pre-release`);
	if (listing.latest_version === tag) return no(`the listing already shows ${tag}`);
	return { ok: true };
}

// ---------------------------------------------------------------------------------------------------
// Waiting for the release

/**
 * Wait for this repo's "Release" workflow run on the tag to succeed and the release to carry a plugin ZIP.
 * `gh(args)` returns stdout; `sleep(ms)` waits. Throws with a reason if it fails or never appears.
 */
export async function waitForRelease({ slug, tag, gh, sleep, log = () => {}, pollMs = 15_000, maxPolls = 100, maxPollsNoRun = 12 }) {
	let seen = false;
	for (let i = 0; i < maxPolls; i++) {
		const runs = JSON.parse(gh(["run", "list", "-R", slug, "--branch", tag, "-e", "push", "--json", "databaseId,status,conclusion,workflowName", "-L", "20"]) || "[]")
			.filter((r) => r.workflowName === "Release");
		if (runs.length) {
			seen = true;
			const done = runs.find((r) => r.status === "completed");
			if (done) {
				if (done.conclusion !== "success") throw new Error(`the Release workflow for ${tag} finished with "${done.conclusion}"`);
				break;
			}
			if (i === 0 || i % 4 === 0) log(`Waiting for the Release workflow for ${tag} ...`);
		} else if (i >= maxPollsNoRun) {
			throw new Error(`no Release workflow run found for ${tag}`);
		}
		await sleep(pollMs);
		if (i === maxPolls - 1) throw new Error(`timed out waiting for the Release workflow for ${tag}`);
	}
	if (!seen) throw new Error(`no Release workflow run found for ${tag}`);

	const rel = JSON.parse(gh(["release", "view", tag, "-R", slug, "--json", "assets,isDraft,isPrerelease"]));
	const zip = (rel.assets ?? []).find((a) => /\.zip$/i.test(a.name) && !/-srcmap\.zip$/i.test(a.name));
	if (rel.isDraft || !zip) throw new Error(`release ${tag} has no published plugin ZIP`);
}

// ---------------------------------------------------------------------------------------------------
// Orchestration

export function defaultDeps() {
	return {
		fetchText: async (url) => {
			const r = await fetch(url);
			return r.ok ? await r.text() : null;
		},
		gh: (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(),
		open: (url) => {
			const [cmd, ...a] =
				process.platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler", url] : process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
			spawn(cmd, a, { stdio: "ignore", detached: true }).unref();
		},
		confirm: async (question) => {
			if (!process.stdin.isTTY) return false;
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			const answer = await rl.question(`${question} [y/N] `);
			rl.close();
			return /^y(es)?$/i.test(answer.trim());
		},
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
	};
}

function slugFromRemote(dir) {
	const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: dir, encoding: "utf8" }).trim();
	const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
	if (!m) throw new Error(`cannot read the GitHub repository from remote "${url}"`);
	return m[1];
}

/**
 * Notify the PluginRepository about `tag`. Resolves to { status, reason?, url?, mode? } with status one of
 * "skipped" | "opened" | "created" | "dry-run". Throws on real problems (template drift, failed release, ...).
 */
export async function notifyRelease({ dir, tag, mode = "auto", acceptTerms = false, open = true, wait = true, dryRun = false, slug, deps = defaultDeps(), log = console.log }) {
	const manifest = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"));
	slug ??= slugFromRemote(dir);
	const [owner, repo] = slug.split("/");

	const user = deps.gh(["api", "user", "--jq", ".login"]);
	const listing = parseFrontMatter(await deps.fetchText(`${RAW}/src/plugins/${repo}.md`));
	const eligible = checkEligibility({ listing, owner, repo, user, tag });
	if (!eligible.ok) return { status: "skipped", reason: eligible.reason };

	const title = `[PluginUpdate]: ${manifest.name} ${tag}`;
	const existing = JSON.parse(deps.gh(["issue", "list", "-R", REPO, "--author", user, "--state", "open", "--search", `${tag} in:title`, "--json", "number,title", "-L", "20"]) || "[]")
		.find((i) => i.title.includes(manifest.name) && i.title.includes(tag));
	if (existing) return { status: "skipped", reason: `issue #${existing.number} for ${tag} is already open` };

	const templateText = await deps.fetchText(`${RAW}/.github/ISSUE_TEMPLATE/${TEMPLATE_FILE}`);
	if (!templateText) throw new Error(`could not read ${TEMPLATE_FILE} from ${REPO}`);
	const tpl = parseTemplate(templateText);
	const problems = checkContract(tpl);
	if (problems.length) throw new Error(`the ${REPO} update form has changed, so no issue was filed: ${problems.join("; ")}. Update notify-plugin-repository.mjs.`);

	const values = { PluginAbstract: listing.abstract, PluginID: repo };
	if (!values.PluginAbstract) throw new Error(`the listing for ${repo} has no abstract to re-send (the update overwrites it)`);
	const body = buildBody(tpl, values);
	const formUrl = buildFormUrl(tpl, title, values);

	const perms = JSON.parse(deps.gh(["api", `repos/${REPO}`, "--jq", ".permissions"]) || "{}");
	const canLabel = !!(perms.triage || perms.push || perms.maintain || perms.admin);
	const chosen = mode === "auto" ? (canLabel ? "api" : "form") : mode;
	if (chosen === "api" && !canLabel) throw new Error(`--mode api needs triage or push access to ${REPO}, which this account does not have; use the form`);

	if (dryRun) {
		log(`Would file on ${REPO} as ${user} (${chosen} mode): ${title}\n\n${body}\nForm link: ${formUrl}`);
		return { status: "dry-run", mode: chosen, url: formUrl };
	}

	if (wait) await waitForRelease({ slug, tag, gh: deps.gh, sleep: deps.sleep, log });

	if (chosen === "api") {
		const terms = tpl.fields.find((f) => f.type === "checkboxes")?.options.join(" / ") ?? "";
		if (acceptTerms || (await deps.confirm(`File the update issue now? This ticks the terms for you: "${terms}"`))) {
			const url = deps.gh(["issue", "create", "-R", REPO, "--title", title, "--body", body, "--label", EXPECTED.label]);
			log(`Filed ${url}`);
			return { status: "created", mode: "api", url };
		}
		log("Not filed from here; use the form instead.");
	}

	log(`Open the prefilled update form, tick the terms and submit:\n  ${formUrl}`);
	if (open) deps.open(formUrl);
	return { status: "opened", mode: "form", url: formUrl };
}

// ---------------------------------------------------------------------------------------------------
// CLI

export function parseCliArgs(argv) {
	const out = { mode: "auto", acceptTerms: false, open: true, wait: true, dryRun: false, version: undefined };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--mode") out.mode = argv[++i];
		else if (a === "--accept-terms") out.acceptTerms = true;
		else if (a === "--no-open") out.open = false;
		else if (a === "--no-wait") out.wait = false;
		else if (a === "--dry-run") out.dryRun = true;
		else if (!a.startsWith("-")) out.version ??= a.replace(/^v/, "");
		else throw new Error(`Unknown option ${a}`);
	}
	if (!["auto", "form", "api"].includes(out.mode)) throw new Error(`--mode must be auto, form or api`);
	return out;
}

/** Print the outcome of notifyRelease() the way both entry points show it. */
export function reportResult(r, log = console.log) {
	if (r.status === "skipped") log(`PluginRepository: not notifying - ${r.reason}.`);
}

async function main() {
	const args = parseCliArgs(process.argv.slice(2));
	const dir = process.cwd();
	const version = args.version ?? JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")).version;
	try {
		reportResult(await notifyRelease({ dir, tag: `v${version}`, ...args }));
	} catch (e) {
		console.error(e.message);
		process.exit(1);
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
