// Fork: Remote Access. The two functions upstream code calls (see
// docs/UPSTREAM_MODIFICATIONS.md): one from proxy.ts, one from
// src/server/desktop-access.ts apiRequestRefusal.
import { NextResponse, type NextRequest } from "next/server";
import { checkRemoteRequest, isRemoteRequest, remoteGateActive, remoteOrigin, REMOTE_GATE_HEADER, type RemoteCheck } from "./gate.ts";
import { currentRemoteAccessPolicy, loadRemoteAccessPolicy, remoteAccessRequest, type RemoteAccessPolicy } from "./policy-store.ts";
import { isAPIPath } from "./route-policy.ts";

const SEEN_REPORT_INTERVAL_MS = 10 * 60 * 1000;
const SEEN_KEY = Symbol.for("lh.remoteAccess.seen");

/**
 * For src/server/desktop-access.ts: a request without the desktop secret may
 * still go on if it is a remote request that passes every gate check. Covers
 * the streamed plugin-document route, which skips the proxy.
 */
export function remoteAPIRequestAllowed(request: Request, env: Record<string, string | undefined> = process.env): boolean {
	if (!remoteGateActive(env) || !isRemoteRequest(request)) return false;
	return checkRemoteRequest(request, currentRemoteAccessPolicy()).allowed;
}

function reportDeviceSeen(deviceId: string, now = Date.now()): void {
	const global = globalThis as typeof globalThis & { [SEEN_KEY]?: Map<string, number> };
	const lastReported = (global[SEEN_KEY] ??= new Map());
	if (now - (lastReported.get(deviceId) ?? 0) < SEEN_REPORT_INTERVAL_MS) return;
	lastReported.set(deviceId, now);
	remoteAccessRequest("seen", { deviceId }).catch(() => { /* only a "last seen" time */ });
}

/** Refusals the gate writes itself: never cached. */
function markRemoteResponse<T extends Response>(response: T): T {
	response.headers.set(REMOTE_GATE_HEADER, "gate");
	response.headers.set("Cache-Control", "no-store");
	return response;
}

/**
 * A request the gate lets through: only the marker. Headers set on
 * NextResponse.next() REPLACE the route's own, so setting Cache-Control here
 * dropped the streams' "no-cache, no-transform", and gzip then buffered SSE.
 * Routes keep their caching headers (dynamic pages are already private/no-store).
 */
function markPassedResponse<T extends Response>(response: T): T {
	response.headers.set(REMOTE_GATE_HEADER, "gate");
	return response;
}

/** Safe "come back here after pairing" path: same site, never "//host". */
export function pairingReturnPath(url: URL): string {
	const path = `${url.pathname}${url.search}`;
	return path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/remote/pair") ? path : "/";
}

function escapeHTML(text: string): string {
	return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function refusalResponse(request: NextRequest, check: Extract<RemoteCheck, { allowed: false }>, policy: RemoteAccessPolicy | null): NextResponse {
	const api = isAPIPath(request.nextUrl.pathname);
	if (check.kind === "pairing") {
		// A pairing refusal comes after the host check, so the policy is on and its
		// origin is the exact address the phone used. Next's proxy needs an
		// absolute Location (a relative one fails with "Invalid URL" there).
		if (!api && request.method === "GET" && policy?.enabled) {
			const target = new URL("/remote/pair", remoteOrigin(policy));
			target.searchParams.set("next", pairingReturnPath(request.nextUrl));
			return markRemoteResponse(NextResponse.redirect(target, 303));
		}
		return markRemoteResponse(NextResponse.json({ error: check.message, code: "remote-pairing-required" }, { status: 401 }));
	}
	const status = check.kind === "content-type" ? 415 : check.kind === "method" ? 405 : check.kind === "not-ready" ? 503 : 403;
	if (api) return markRemoteResponse(NextResponse.json({ error: check.message, code: `remote-${check.kind}` }, { status }));
	const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LearnHarness</title><body style="font-family:system-ui,sans-serif;padding:2rem;max-width:32rem;margin:auto"><h1 style="font-size:1.25rem">LearnHarness</h1><p>${escapeHTML(check.message)}</p></body>`;
	return markRemoteResponse(new NextResponse(page, { status, headers: { "Content-Type": "text/html; charset=utf-8" } }));
}

/** For proxy.ts: synchronous, so local requests keep upstream's synchronous proxy result. */
export function isRemoteAccessRequest(request: Request): boolean {
	return remoteGateActive() && isRemoteRequest(request);
}

/**
 * For proxy.ts, only after isRemoteAccessRequest: pass on (marked no-store) or
 * refuse. Synchronous like upstream proxy(): the policy is pushed by main and
 * fetched once when this module loads, so it is normally already here.
 */
export function remoteAccessProxyResponse(request: NextRequest): NextResponse {
	const policy = currentRemoteAccessPolicy();
	if (!policy) void loadRemoteAccessPolicy();
	const check = checkRemoteRequest(request, policy);
	if (!check.allowed) return refusalResponse(request, check, policy);
	if (check.device) reportDeviceSeen(check.device.id);
	return markPassedResponse(NextResponse.next());
}
