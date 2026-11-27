// Fork: scripts/fork/upstream-audit.mjs against a scratch git repo where the
// fork and upstream both changed things. The audit must flag the conflict,
// the new API route, the dependency change and the tests to run, and must
// not change the repo.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/fork/upstream-audit.mjs", import.meta.url));
let repo: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const write = (file: string, text: string) => { mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); writeFileSync(path.join(repo, file), text); };
const commit = (message: string) => { git("add", "-A"); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message); };

before(() => {
	repo = mkdtempSync(path.join(tmpdir(), "lh-audit-"));
	git("init", "-q", "-b", "main");
	write("proxy.ts", "export function proxy() {}\n");
	write("app/api/chats/route.ts", "export function GET() {}\n");
	write("src/store/chats.ts", "export const chatStore = {};\n");
	write("package.json", JSON.stringify({ dependencies: { next: "16.4.6" } }));
	commit("base");
	git("branch", "upstream-main");
	// The fork: a hook in an upstream file plus its own module.
	write("proxy.ts", "export function proxy() { /* Fork: gate */ }\n");
	write("src/remote-access/gate.ts", "export {};\n");
	commit("fork");
	git("switch", "-q", "upstream-main");
	write("proxy.ts", "export function proxy() { /* upstream change */ }\n");
	write("app/api/new-feature/route.ts", "export function POST() {}\n");
	write("src/store/chats.ts", "export const chatStore = { v: 2 };\n");
	write("package.json", JSON.stringify({ dependencies: { next: "16.5.0", zod: "4.5.0" } }));
	commit("upstream: new feature");
	git("switch", "-q", "main");
});
after(() => rmSync(repo, { recursive: true, force: true }));

describe("upstream audit", () => {
	it("reports commits, conflicts, new routes, contract areas, dependencies and tests, read-only", () => {
		const headBefore = git("rev-parse", "HEAD");
		const report = execFileSync(process.execPath, [SCRIPT, "--repo", repo, "--upstream", "upstream-main"], { encoding: "utf8" });
		assert.match(report, /## New upstream commits \(1\)\n- [0-9a-f]+ upstream: new feature/);
		assert.match(report, /## Likely merge conflicts: upstream changed files the fork modified \(1\)\n- `proxy\.ts`/);
		assert.match(report, /- added `app\/api\/new-feature\/route\.ts`/);
		assert.match(report, /### Persistence formats\n- `src\/store\/chats\.ts`/);
		assert.match(report, /### Authentication and the request gate\n- `proxy\.ts`/);
		assert.match(report, /- next: 16\.4\.6 → 16\.5\.0/);
		assert.match(report, /- zod: \(none\) → 4\.5\.0/);
		assert.match(report, /tests\/remote-access-route-coverage\.test\.ts/);
		assert.match(report, /tests\/remote-access-gate\.test\.ts/);
		assert.doesNotMatch(report, /src\/remote-access\/gate\.ts/, "fork-only files are never conflicts");
		assert.equal(git("rev-parse", "HEAD"), headBefore, "nothing merged");
		assert.equal(git("status", "--porcelain"), "", "working tree untouched");
	});

	it("fails clearly when the upstream ref is missing", () => {
		assert.throws(() => execFileSync(process.execPath, [SCRIPT, "--repo", repo, "--upstream", "nope/main"], { encoding: "utf8", stdio: "pipe" }), /git fetch upstream/);
	});
});
