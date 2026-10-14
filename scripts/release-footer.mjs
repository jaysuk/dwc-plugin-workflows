#!/usr/bin/env node
/**
 * Print the footer appended to every GitHub Release body: install instructions, the DuetWebControl
 * version(s) the ZIP(s) were built against, any plugin-specific notes, and the machine-readable
 * `dwc-plugin-update` marker that dwc-plugin-runtime's in-app update checker looks for.
 *
 * Run with the plugin repo as the working directory. Everything plugin-specific is derived:
 *   - id / name / version / dwcVersion  <- plugin.json
 *   - dual-package (DWC 3.7 + 3.6)      <- a `<id>-<version>-dwc36.zip` sitting in the repo root, which the
 *                                          release workflow's 3.6 build step leaves there
 *   - extra notes                       <- optional .github/release-footer.md, appended verbatim
 *                                          (hardware requirements, companion plugins, where to find it, ...)
 *
 * DWC details come from the release workflow's environment (DWC_VERSION / DWC_SHA / DWC_REF and the
 * DWC36_* equivalents); they fall back sensibly when run locally.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the manifest's dwcVersion the way DWC's build does ("auto" -> full DWC version, "auto-major"
// -> major.minor, "auto-minor" -> major.minor.patch), so the marker matches what DWC enforces at install.
// A dual-package release ships 3.6 and 3.7 builds under one tag; 3.6.x and 3.7.x differ in minor but are
// both DWC major 3, so "auto-major" narrows to the major only - the one thing true of BOTH packages. The
// real per-package gate is each ZIP's embedded plugin.json; this value is only the update checker's hint.
export function resolveDwcRequirement(value, reference, dual) {
	if (value === "auto") return reference;
	if (value === "auto-major") return dual ? reference.split(".")[0] : reference.split(".").slice(0, 2).join(".");
	if (value === "auto-minor") return reference.split(".").slice(0, 3).join(".").split("-")[0];
	return value || "";
}

function builtAgainst(label, version, sha, ref) {
	return version
		? `**${label} ${version}**${sha ? ` (\`${sha}\`, ref \`${ref}\`)` : ` (ref \`${ref}\`)`}`
		: `${label} (ref \`${ref}\`)`;
}

export function buildFooter({ manifest, env = {}, has36 = false, extra = "" }) {
	const { id, version } = manifest;
	const zip = `${id}-${version}.zip`;
	const zip36 = `${id}-${version}-dwc36.zip`;

	const dwcVersion = env.DWC_VERSION || "";
	const requiredDwc = resolveDwcRequirement(manifest.dwcVersion, dwcVersion, has36);
	const dwc = builtAgainst("DuetWebControl", dwcVersion, env.DWC_SHA, env.DWC_REF || "v3.7-dev");
	const dwc36 = builtAgainst("DuetWebControl", env.DWC36_VERSION, env.DWC36_SHA, env.DWC36_REF || "v3.6-dev");

	const download = has36
		? `1. Download the ZIP for **your** DuetWebControl from the **Assets** below - they are different builds, not alternatives:
   - DWC **3.7** and newer → \`${zip}\`
   - DWC **3.6** → \`${zip36}\``
		: `1. Download \`${zip}\` from the **Assets** below.`;

	const built = has36
		? `> 🔧 The 3.7 package is built against ${dwc}; the 3.6 package against ${dwc36}.
> DWC refuses a package whose \`dwcVersion\` doesn't match, so picking the wrong one is safe but won't install.`
		: `> 🔧 Built against ${dwc}. Use a DuetWebControl build at or near this version.`;

	const markers = [{ version, dwcVersion: requiredDwc, asset: zip }];
	if (has36) markers.push({ version, dwcVersion: "3.6", asset: zip36 });

	const lines = [
		"---",
		"",
		"### 📦 Install",
		download,
		"2. In DuetWebControl, go to **Settings → General → Plugins** and click **Install Plugin**.",
		"3. Select the downloaded ZIP and accept the third-party-plugin prompt.",
		"4. Reload DWC if asked.",
		"",
		built,
	];
	if (extra.trim()) lines.push(extra.trim());
	lines.push("", ...markers.map((m) => `<!-- dwc-plugin-update ${JSON.stringify(m)} -->`), "");
	return lines.join("\n");
}

/** Build the footer for the plugin repo in `dir` (plugin.json, the dual-package ZIP check, extra notes). */
export function renderFooter(dir = process.cwd(), env = process.env) {
	const manifest = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"));
	const has36 = existsSync(join(dir, `${manifest.id}-${manifest.version}-dwc36.zip`));
	const extraFile = join(dir, ".github", "release-footer.md");
	const extra = existsSync(extraFile) ? readFileSync(extraFile, "utf8") : "";
	return buildFooter({ manifest, env, has36, extra });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.stdout.write(renderFooter());
}
