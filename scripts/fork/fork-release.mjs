#!/usr/bin/env node
// Fork: Windows release helper for .github/workflows/fork-release.yml
// (docs/FORK_RELEASE.md).
//
// Two versions on purpose: the app and its server are built with upstream's
// plain x.y.z from package.json (the plugin system accepts nothing else, and
// Settings shows it with a link to upstream's notes for that base). Only
// packaging gets the fork release version (electron-builder
// -c.extraMetadata.version): installer name, update feed, and the version
// the updater compares. package.json is never edited; electron-builder.yml
// is edited only in the CI checkout (the update feed), never in git.
//
//   node scripts/fork/fork-release.mjs version <tag>      → prints the version (v0.7.0-mobile.1 → 0.7.0-mobile.1)
//   node scripts/fork/fork-release.mjs rehearsal          → prints <package.json version>-mobile.0
//   node scripts/fork/fork-release.mjs stamp              → points the update feed at the fork (this checkout only)
//   node scripts/fork/fork-release.mjs verify <version>   → checks dist/ (installer, latest.yml, app-update.yml)
//   node scripts/fork/fork-release.mjs notes <version>    → prints the release notes (Markdown)
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

export const FORK_OWNER = "hachihao792001";
export const FORK_REPO = "learnharness-mobilesupport";
export const FORK_URL = `https://github.com/${FORK_OWNER}/${FORK_REPO}`;
const TAG_PATTERN = /^v(\d+\.\d+\.\d+)-mobile\.(\d+)$/;

/** v0.7.0-mobile.1 → 0.7.0-mobile.1. The base must be the upstream version in package.json. */
export function versionFromTag(tag, upstreamVersion) {
	const match = TAG_PATTERN.exec(tag ?? "");
	if (!match) throw new Error(`Tag "${tag}" is not like v${upstreamVersion}-mobile.1`);
	if (match[1] !== upstreamVersion) throw new Error(`Tag "${tag}" is based on ${match[1]}, but package.json is ${upstreamVersion}. Use v${upstreamVersion}-mobile.<n>.`);
	if (Number(match[2]) < 1) throw new Error("The fork counter starts at 1 (-mobile.1); -mobile.0 is only for rehearsals.");
	return tag.slice(1);
}

/** The electron-builder.yml change: updates come from the fork's releases, never upstream's. */
export function stampBuilderConfig(config) {
	const publish = (Array.isArray(config.publish) ? config.publish : [config.publish]).filter(Boolean);
	if (publish.length !== 1 || publish[0].provider !== "github") throw new Error("expected exactly one GitHub publish entry in electron-builder.yml");
	return { ...config, publish: [{ ...publish[0], owner: FORK_OWNER, repo: FORK_REPO }] };
}

export function installerName(version) {
	return `LearnHarness-${version}-x64-setup.exe`;
}

/** Checks the built output. Returns a list of problems (empty = good). */
export function verifyOutput(dist, version) {
	const problems = [];
	const installer = path.join(dist, installerName(version));
	if (!existsSync(installer) || statSync(installer).size < 10_000_000) problems.push(`missing or too small installer ${installerName(version)}`);
	if (!existsSync(`${installer}.blockmap`)) problems.push(`missing ${installerName(version)}.blockmap`);
	const feedFile = path.join(dist, "latest.yml");
	if (!existsSync(feedFile)) problems.push("missing latest.yml");
	else {
		const feed = yaml.load(readFileSync(feedFile, "utf8"));
		if (feed.version !== version) problems.push(`latest.yml version is ${feed.version}, expected ${version}`);
		if (feed.path !== installerName(version)) problems.push(`latest.yml points at ${feed.path}`);
		if (!feed.sha512) problems.push("latest.yml has no sha512");
	}
	const updateConfigFile = path.join(dist, "win-unpacked", "resources", "app-update.yml");
	if (!existsSync(updateConfigFile)) problems.push("missing win-unpacked/resources/app-update.yml");
	else {
		const updateConfig = yaml.load(readFileSync(updateConfigFile, "utf8"));
		if (updateConfig.owner !== FORK_OWNER || updateConfig.repo !== FORK_REPO) problems.push(`the app would update from ${updateConfig.owner}/${updateConfig.repo}, not the fork`);
	}
	return problems;
}

export function releaseNotes(version) {
	const upstreamVersion = version.split("-")[0];
	return `> [!WARNING]
> **Unofficial fork. Use at your own risk.** The phone-access features were written with an AI coding assistant and have not been reviewed by a web or security expert. This is not official [LearnHarness](https://github.com/amosblomqvist/learnharness) and its authors do not support it.

LearnHarness ${upstreamVersion} plus this fork's phone access: Remote Access over Tailscale, a phone layout and an installable phone app. See [docs/MOBILE_PWA.md](${FORK_URL}/blob/v${version}/docs/MOBILE_PWA.md).

## Install (Windows 10/11, 64-bit)
1. Download **${installerName(version)}** below and run it.
2. Windows shows "Windows protected your PC" because the installer is not code-signed. Click **More info → Run anyway**.
3. It installs for your user only and starts LearnHarness.

**If you already have official LearnHarness:** this replaces it, and keeps your sessions, graph and API keys (same data folder, \`%APPDATA%\\LearnHarness\`). From then on the app updates only from this fork's releases. To go back, install official LearnHarness again from learnharness.ai.

## Use it from your phone
Settings → Remote Access → turn on, then follow [the steps](${FORK_URL}/blob/v${version}/docs/MOBILE_PWA.md#installing). Needs Tailscale on the computer and the phone, signed in to the same account.

Settings → General shows **${upstreamVersion}**, the LearnHarness version this release is built on; the Windows app list shows the full fork version, **${version}**.

Only Windows is built for this fork.
`;
}

function readJSON(file) {
	return JSON.parse(readFileSync(file, "utf8"));
}

function main(argv) {
	const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
	const [command, value] = argv;
	const packageFile = path.join(repo, "package.json");
	switch (command) {
		case "version":
			console.log(versionFromTag(value, readJSON(packageFile).version));
			return;
		case "rehearsal":
			console.log(`${readJSON(packageFile).version}-mobile.0`);
			return;
		case "stamp": {
			const builderFile = path.join(repo, "electron-builder.yml");
			writeFileSync(builderFile, yaml.dump(stampBuilderConfig(yaml.load(readFileSync(builderFile, "utf8"))), { lineWidth: -1 }));
			console.log(`stamped update feed → ${FORK_OWNER}/${FORK_REPO} (this checkout only)`);
			return;
		}
		case "verify": {
			const problems = verifyOutput(path.join(repo, "dist"), value);
			if (problems.length) throw new Error(`release output problems:\n- ${problems.join("\n- ")}`);
			console.log(`verified ${installerName(value)}, latest.yml and app-update.yml (updates from ${FORK_OWNER}/${FORK_REPO})`);
			return;
		}
		case "notes":
			process.stdout.write(releaseNotes(value));
			return;
		default:
			throw new Error("usage: fork-release.mjs version <tag> | rehearsal | stamp | verify <version> | notes <version>");
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { main(process.argv.slice(2)); }
	catch (error) { console.error(`fork-release: ${error.message}`); process.exit(1); }
}
