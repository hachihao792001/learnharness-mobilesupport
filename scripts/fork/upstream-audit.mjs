#!/usr/bin/env node
// Fork: upstream compatibility audit (docs/UPSTREAM_SYNC.md).
// Read-only: runs only `git log/diff/show/merge-base`. Never fetches, merges or
// changes anything. Run `git fetch upstream --tags` first.
//
// Usage: node scripts/fork/upstream-audit.mjs [--upstream upstream/main] [--fork HEAD] [--out report.md]
// (--repo <dir> points at another checkout; the tests use it with a scratch repo.)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const argument = (name, fallback) => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : fallback; };
const repo = path.resolve(argument("--repo", scriptRepo));
const upstreamRef = argument("--upstream", "upstream/main");
const forkRef = argument("--fork", "HEAD");
const outFile = argument("--out", null);

const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
const lines = (text) => text.split("\n").filter(Boolean);
const watched = JSON.parse(readFileSync(path.join(scriptRepo, "scripts", "fork", "upstream-touchpoints.json"), "utf8")).watched;
const matches = (file, prefixes) => prefixes.some((prefix) => file === prefix || (prefix.endsWith("/") && file.startsWith(prefix)));

/** Files changed between two commits: [{ status, file }] (renames reported under the new name). */
function changedFiles(from, to) {
	return lines(git("diff", "--name-status", "--no-renames", from, to)).map((line) => {
		const [status, file] = line.split("\t");
		return { status, file };
	});
}

function dependencies(ref) {
	try {
		const pkg = JSON.parse(git("show", `${ref}:package.json`));
		return { ...pkg.dependencies, ...pkg.devDependencies };
	} catch { return {}; }
}

export function buildAuditReport() {
	try { git("rev-parse", "--verify", upstreamRef); }
	catch { throw new Error(`upstream-audit: ${upstreamRef} not found. Run: git fetch upstream --tags`); }
	const base = git("merge-base", forkRef, upstreamRef);
	const newCommits = lines(git("log", "--oneline", "--no-decorate", `${forkRef}..${upstreamRef}`));
	const upstreamChanges = changedFiles(base, upstreamRef);
	const forkChanges = changedFiles(base, forkRef);
	// Upstream files the fork modified = files the fork changed that already existed at the merge base.
	const forkModified = forkChanges.filter((change) => change.status === "M").map((change) => change.file);
	const overlap = upstreamChanges.filter((change) => forkModified.includes(change.file));
	const routeChanges = upstreamChanges.filter((change) => /^app\/api\/.*\/route\.ts$|^app\/api\/route\.ts$/.test(change.file) && change.status !== "M");
	const routeEdits = upstreamChanges.filter((change) => /^app\/api\/.*route\.ts$/.test(change.file) && change.status === "M");

	const before = dependencies(base);
	const after = dependencies(upstreamRef);
	const dependencyChanges = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
		.filter((name) => before[name] !== after[name])
		.map((name) => `${name}: ${before[name] ?? "(none)"} → ${after[name] ?? "(removed)"}`);

	const areas = watched.map((area) => ({ ...area, hits: upstreamChanges.filter((change) => matches(change.file, area.paths)) })).filter((area) => area.hits.length);
	const tests = new Set(["full test suite", ...areas.flatMap((area) => area.tests)]);
	if (overlap.length) for (const test of ["tests/remote-access-gate.test.ts", "scripts/fork/smoke-mobile.mjs"]) tests.add(test);

	const list = (items, render = (item) => item) => (items.length ? items.map((item) => `- ${render(item)}`).join("\n") : "- none");
	return [
		`# Upstream compatibility audit`,
		``,
		`- Upstream: \`${upstreamRef}\` (${git("rev-parse", "--short", upstreamRef)})`,
		`- Fork: \`${forkRef === "HEAD" ? git("rev-parse", "--abbrev-ref", "HEAD") : forkRef}\` (${git("rev-parse", "--short", forkRef)})`,
		`- Merge base: ${git("rev-parse", "--short", base)}`,
		``,
		`## New upstream commits (${newCommits.length})`,
		list(newCommits.slice(0, 200)),
		newCommits.length > 200 ? `- … and ${newCommits.length - 200} more` : "",
		``,
		`## Likely merge conflicts: upstream changed files the fork modified (${overlap.length})`,
		list(overlap, (change) => `\`${change.file}\` (${change.status}) — see docs/UPSTREAM_MODIFICATIONS.md`),
		``,
		`## API routes added or removed upstream (need a decision in src/remote-access/route-policy.ts)`,
		list(routeChanges, (change) => `${change.status === "A" ? "added" : change.status === "D" ? "removed" : change.status} \`${change.file}\``),
		``,
		`## API routes edited upstream (check methods and contracts)`,
		list(routeEdits, (change) => `\`${change.file}\``),
		``,
		`## Areas the fork relies on that upstream changed`,
		areas.length ? areas.map((area) => `### ${area.area}\n${list(area.hits, (change) => `\`${change.file}\` (${change.status})`)}`).join("\n\n") : "- none",
		``,
		`## Dependency changes`,
		list(dependencyChanges),
		``,
		`## Tests to run after merging`,
		list([...tests]),
		``,
		`Nothing was merged. Review, then follow docs/UPSTREAM_SYNC.md.`,
		``,
	].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const report = buildAuditReport();
		if (outFile) { writeFileSync(path.resolve(outFile), report); console.log(`upstream-audit: report written to ${outFile}`); }
		else process.stdout.write(report);
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}
}
