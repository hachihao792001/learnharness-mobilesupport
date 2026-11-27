// Fork: Remote Access. What a paired phone may call. Deny by default: a route
// or method missing here is local-only, so a new upstream route stays
// desktop-only until someone reviews it (tests/remote-access-route-coverage.test.ts
// fails until every app/api route file is listed).

/** "remote": paired phone may use it. "local-only": desktop window only. "before-pairing": allowed with identity alone. */
export type RemoteRouteAccess = "remote" | "local-only" | "before-pairing";
type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

/** Keys are the app/api folder paths of the route files, exactly. */
export const REMOTE_API_ROUTE_POLICY: Record<string, Partial<Record<Method, RemoteRouteAccess>>> = {
	"/api/activity": { GET: "remote" },
	"/api/activity/abort": { POST: "remote" },
	"/api/chat": { POST: "remote" },
	"/api/chats": { GET: "remote", POST: "remote" },
	"/api/chats/[id]": { GET: "remote", PUT: "remote", DELETE: "remote" },
	"/api/chats/[id]/artifact-ui": { POST: "remote" },
	"/api/chats/[id]/dismiss": { POST: "remote" },
	"/api/chats/[id]/images/[snapshotId]": { GET: "remote" },
	"/api/chats/[id]/markdown": { GET: "remote" },
	"/api/chats/[id]/settings": { PUT: "remote" },
	"/api/chats/[id]/side-chats": { GET: "remote", POST: "remote" },
	"/api/chats/[id]/side-chats/[threadId]": { GET: "remote", PATCH: "remote" },
	"/api/chats/[id]/side-chats/[threadId]/stop": { POST: "remote" },
	"/api/chats/[id]/steer": { POST: "remote" },
	"/api/chats/[id]/stream": { GET: "remote" },
	"/api/claude-code": { GET: "local-only" },
	"/api/custom-provider": { GET: "local-only", POST: "local-only", PATCH: "local-only", DELETE: "local-only" },
	"/api/events": { GET: "remote" },
	"/api/graph": { GET: "remote" },
	"/api/graph/costs": { GET: "remote" },
	"/api/graph/coverage/extract": { POST: "remote" },
	"/api/graph/import": { POST: "remote" },
	"/api/graph/nodes/[id]": { DELETE: "remote" },
	"/api/graph/positions": { PUT: "remote" },
	"/api/graph/render-settings": { GET: "remote", PUT: "remote" },
	"/api/graph/sources": { GET: "remote", POST: "remote", DELETE: "remote" },
	"/api/graph/sources/folders/[id]": { DELETE: "remote" },
	"/api/graph/status": { GET: "remote" },
	"/api/jobs": { GET: "remote" },
	"/api/keys": { GET: "local-only" },
	"/api/keys/[id]": { PUT: "local-only", DELETE: "local-only" },
	// GET is the picker's catalog; POST refreshes it from pi.dev (global configuration).
	"/api/models": { GET: "remote", POST: "local-only" },
	"/api/plugins": { GET: "remote", POST: "local-only" },
	"/api/plugins/[id]": { PUT: "local-only" },
	"/api/plugins/[id]/assets/[...file]": { GET: "remote" },
	"/api/plugins/[id]/call": { POST: "remote" },
	// The route answers every method itself; only POST does work.
	"/api/plugins/[id]/documents/markdown": { POST: "remote", GET: "local-only", HEAD: "local-only", PUT: "local-only", PATCH: "local-only", DELETE: "local-only", OPTIONS: "local-only" },
	"/api/remote-access/pair": { POST: "before-pairing" },
	"/api/search": { GET: "remote" },
	"/api/settings": { GET: "remote" },
	"/api/settings/[section]": { PUT: "local-only" },
	"/api/settings/prompts": { GET: "local-only" },
	"/api/settings/prompts/[...segment]": { PUT: "local-only", DELETE: "local-only" },
	"/api/stt/token": { GET: "remote" },
	"/api/subscriptions": { GET: "local-only", POST: "local-only" },
	"/api/subscriptions/browser": { GET: "local-only", POST: "local-only" },
	"/api/themes": { GET: "remote", POST: "local-only" },
	"/api/themes/[id]": { DELETE: "local-only" },
};

/** Non-API paths a phone needs before it has paired (GET/HEAD only). Everything else needs pairing. */
const BEFORE_PAIRING_PAGES = [
	/^\/remote\/pair\/?$/,
	/^\/_next\/static\//,
	/^\/fonts\//,
	/^\/icons\//,
	/^\/manifest\.webmanifest$/,
	/^\/sw\.js$/,
	/^\/offline\.html$/,
];

function templateToRegExp(template: string): RegExp {
	const pattern = template.split("/").map((segment) => {
		if (/^\[\.\.\.[^\]]+\]$/.test(segment)) return ".+";
		if (/^\[[^\]]+\]$/.test(segment)) return "[^/]+";
		return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}).join("/");
	return new RegExp(`^${pattern}/?$`);
}

// Static segments must win over [param] siblings, so try the most specific templates first.
const COMPILED_API_ROUTES = Object.entries(REMOTE_API_ROUTE_POLICY)
	.map(([template, methods]) => ({ template, methods, pattern: templateToRegExp(template), dynamicSegments: (template.match(/\[/g) ?? []).length }))
	.sort((a, b) => a.dynamicSegments - b.dynamicSegments || b.template.length - a.template.length);

export function findRemoteAPIRoute(pathname: string): string | undefined {
	return COMPILED_API_ROUTES.find((route) => route.pattern.test(pathname))?.template;
}

export function isAPIPath(pathname: string): boolean {
	return pathname === "/api" || pathname.startsWith("/api/");
}

/** Decoded, single slashes, lower case: so "/API//%6Beys" is judged as "/api/keys". Null if it cannot be decoded. */
export function normalizePathForPolicy(rawPathname: string): string | null {
	try {
		return decodeURIComponent(rawPathname).replace(/\/{2,}/g, "/").toLowerCase();
	} catch {
		return null;
	}
}

export function remoteRouteAccess(method: string, rawPathname: string): RemoteRouteAccess {
	const pathname = normalizePathForPolicy(rawPathname);
	if (pathname === null || pathname.includes("\\")) return "local-only";
	const upperMethod = method.toUpperCase();
	if (isAPIPath(pathname)) {
		const route = COMPILED_API_ROUTES.find((entry) => entry.pattern.test(pathname));
		return route?.methods[upperMethod as Method] ?? "local-only";
	}
	if (upperMethod !== "GET" && upperMethod !== "HEAD") return "local-only";
	return BEFORE_PAIRING_PAGES.some((pattern) => pattern.test(pathname)) ? "before-pairing" : "remote";
}
