// Fork: Remote Access — every API route and method must have an explicit
// remote decision. When an upstream merge adds a route, this fails until
// someone decides (in src/remote-access/route-policy.ts) whether a paired
// phone may use it. Until then the gate already refuses it (deny by default).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { REMOTE_API_ROUTE_POLICY, findRemoteAPIRoute, remoteRouteAccess } from "../src/remote-access/route-policy.ts";

const API_DIR = fileURLToPath(new URL("../app/api", import.meta.url));
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

function routeFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return routeFiles(path);
		return name === "route.ts" ? [path] : [];
	});
}

function exportedMethods(source: string): string[] {
	const found = new Set<string>();
	for (const match of source.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+([A-Z]+)\b/g)) found.add(match[1]!);
	for (const match of source.matchAll(/export\s+const\s+\{([^}]*)\}/g)) for (const name of match[1]!.split(",")) found.add(name.trim().split(/\s|:/)[0]!);
	for (const match of source.matchAll(/export\s+\{([^}]*)\}/g)) for (const name of match[1]!.split(",")) found.add(name.trim().split(/\s+as\s+/).pop()!.trim());
	if (/createPluginDocumentRoute\(/.test(source)) for (const method of METHODS) found.add(method);
	return [...found].filter((name) => METHODS.includes(name)).sort();
}

const ROUTES = routeFiles(API_DIR).map((file) => ({
	template: `/api/${relative(API_DIR, file).split(sep).slice(0, -1).join("/")}`.replace(/\/$/, ""),
	methods: exportedMethods(readFileSync(file, "utf8")),
}));

describe("remote route policy covers every API route", () => {
	it("found the route files", () => {
		assert(ROUTES.length >= 45, `only ${ROUTES.length} route files found`);
	});

	it("lists every route file, with no stale entries", () => {
		const templates = new Set(ROUTES.map((route) => route.template));
		const missing = [...templates].filter((template) => !(template in REMOTE_API_ROUTE_POLICY));
		const stale = Object.keys(REMOTE_API_ROUTE_POLICY).filter((template) => !templates.has(template));
		assert.deepEqual(missing, [], `new routes need a remote decision in src/remote-access/route-policy.ts: ${missing.join(", ")}`);
		assert.deepEqual(stale, [], `policy entries without a route file: ${stale.join(", ")}`);
	});

	it("decides every exported method of every route", () => {
		const undecided = ROUTES.flatMap((route) => route.methods
			.filter((method) => !(method in (REMOTE_API_ROUTE_POLICY[route.template] ?? {})))
			.map((method) => `${method} ${route.template}`));
		assert.deepEqual(undecided, []);
	});

	it("matches each concrete path to its own route, static segments before [params]", () => {
		for (const route of ROUTES) {
			const concrete = route.template.replace(/\[\.\.\.[^\]]+\]/g, "a/b").replace(/\[[^\]]+\]/g, "x1");
			assert.equal(findRemoteAPIRoute(concrete), route.template, concrete);
		}
	});

	it("keeps credentials, providers and global settings desktop-only", () => {
		for (const [method, path] of [["GET", "/api/keys"], ["PUT", "/api/keys/X"], ["GET", "/api/custom-provider"], ["GET", "/api/subscriptions"], ["GET", "/api/claude-code"], ["PUT", "/api/settings/agent"]]) {
			assert.equal(remoteRouteAccess(method!, path!), "local-only", `${method} ${path}`);
		}
	});
});
