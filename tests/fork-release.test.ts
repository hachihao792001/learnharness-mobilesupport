// Fork: scripts/fork/fork-release.mjs — the Windows release helper.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { FORK_OWNER, FORK_REPO, installerName, releaseNotes, stampBuilderConfig, verifyOutput, versionFromTag } from "../scripts/fork/fork-release.mjs";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const builderConfig = yaml.load(readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8"));
const upstreamVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;

describe("fork release versions", () => {
	it("takes the version from a v<upstream>-mobile.<n> tag", () => {
		assert.equal(versionFromTag(`v${upstreamVersion}-mobile.1`, upstreamVersion), `${upstreamVersion}-mobile.1`);
		assert.equal(versionFromTag(`v${upstreamVersion}-mobile.12`, upstreamVersion), `${upstreamVersion}-mobile.12`);
	});

	it("refuses tags that would confuse users or updates", () => {
		for (const tag of [`v${upstreamVersion}`, `${upstreamVersion}-mobile.1`, `v${upstreamVersion}-beta.1`, `v${upstreamVersion}-mobile`, `v${upstreamVersion}-mobile.0`, "v9.9.9-mobile.1", undefined]) {
			assert.throws(() => versionFromTag(tag as string, upstreamVersion), String(tag));
		}
	});
});

describe("stamping the CI checkout", () => {
	it("leaves package.json at plain x.y.z: the plugin system accepts nothing else", () => {
		assert.match(upstreamVersion, /^\d+\.\d+\.\d+$/);
	});

	it("points the real electron-builder.yml update feed at the fork and changes nothing else", () => {
		const stamped = stampBuilderConfig(builderConfig);
		assert.deepEqual(stamped.publish, [{ ...builderConfig.publish[0], owner: FORK_OWNER, repo: FORK_REPO }]);
		assert.deepEqual({ ...stamped, publish: null }, { ...builderConfig, publish: null });
		assert.equal(builderConfig.publish[0].owner, "amosblomqvist", "the file in git stays upstream's");
		// Survives the yaml round trip the script does.
		assert.deepEqual(yaml.load(yaml.dump(stamped, { lineWidth: -1 })), stamped);
	});

	it("refuses an unexpected publish setup instead of guessing", () => {
		assert.throws(() => stampBuilderConfig({ publish: [{ provider: "s3" }] }));
		assert.throws(() => stampBuilderConfig({ publish: [{ provider: "github" }, { provider: "github" }] }));
		assert.throws(() => stampBuilderConfig({}));
	});
});

describe("checking the built output", () => {
	const version = "0.7.0-mobile.1";
	function fakeDist({ owner = FORK_OWNER, feedVersion = version, small = false } = {}) {
		const dist = mkdtempSync(path.join(tmpdir(), "lh-fork-release-"));
		writeFileSync(path.join(dist, installerName(version)), Buffer.alloc(small ? 10 : 10_000_001));
		writeFileSync(path.join(dist, `${installerName(version)}.blockmap`), "x");
		writeFileSync(path.join(dist, "latest.yml"), yaml.dump({ version: feedVersion, path: installerName(version), sha512: "abc" }));
		mkdirSync(path.join(dist, "win-unpacked", "resources"), { recursive: true });
		writeFileSync(path.join(dist, "win-unpacked", "resources", "app-update.yml"), yaml.dump({ provider: "github", owner, repo: FORK_REPO }));
		return dist;
	}

	it("accepts a complete build that updates from the fork", () => {
		const dist = fakeDist();
		try { assert.deepEqual(verifyOutput(dist, version), []); } finally { rmSync(dist, { recursive: true, force: true }); }
	});

	it("catches an app that would update from upstream, a wrong feed version and a tiny installer", () => {
		for (const [options, expected] of [
			[{ owner: "amosblomqvist" }, /update from amosblomqvist/],
			[{ feedVersion: "0.7.0" }, /latest.yml version is 0.7.0/],
			[{ small: true }, /missing or too small installer/],
		] as const) {
			const dist = fakeDist(options);
			try { assert.match(verifyOutput(dist, version).join("\n"), expected); } finally { rmSync(dist, { recursive: true, force: true }); }
		}
		const empty = mkdtempSync(path.join(tmpdir(), "lh-fork-release-"));
		try { assert.equal(verifyOutput(empty, version).length, 4); } finally { rmSync(empty, { recursive: true, force: true }); }
	});
});

describe("release notes", () => {
	it("warn first, explain the unsigned installer and replacing official LearnHarness", () => {
		const notes = releaseNotes("0.7.0-mobile.1");
		assert(notes.startsWith("> [!WARNING]"));
		assert.match(notes, /Use at your own risk/);
		assert.match(notes, /More info → Run anyway/);
		assert.match(notes, /replaces it, and keeps your sessions/);
		assert.match(notes, /LearnHarness-0\.7\.0-mobile\.1-x64-setup\.exe/);
		assert.match(notes, /blob\/v0\.7\.0-mobile\.1\/docs\/MOBILE_PWA\.md/);
		assert.match(notes, /Settings → General shows \*\*0\.7\.0\*\*/);
	});
});
