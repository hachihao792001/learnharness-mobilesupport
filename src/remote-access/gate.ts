// Fork: Remote Access. Decides whether a request came through Tailscale Serve
// and, if so, whether it may continue. See docs/REMOTE_ACCESS_SECURITY.md.
import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { desktopServerMode, type RemoteAccessPolicy, type RemoteDevicePolicy } from "./policy-store.ts";
import { remoteRouteAccess } from "./route-policy.ts";

export const REMOTE_GATE_HEADER = "x-learnharness-remote";
export const PAIRING_COOKIE = "__Host-lh-remote";
const TAILSCALE_IDENTITY_HEADERS = ["tailscale-user-login", "tailscale-user-name", "tailscale-user-profile-pic"];
const READ_METHODS = new Set(["GET", "HEAD"]);

export type RemoteRefusalKind = "not-ready" | "off" | "host" | "identity" | "method" | "origin" | "content-type" | "pairing" | "local-only";
export type RemoteCheck =
	| { allowed: true; device: RemoteDevicePolicy | null }
	| { allowed: false; kind: RemoteRefusalKind; message: string };

function isLoopbackHostName(hostname: string): boolean {
	const bare = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (bare === "localhost" || bare.endsWith(".localhost")) return true;
	if (isIP(bare) === 4) return bare.startsWith("127.");
	if (isIP(bare) === 6) return bare === "::1" || bare.startsWith("::ffff:127.");
	return false;
}

function hostHeaderIsLoopback(host: string): boolean {
	try {
		return isLoopbackHostName(new URL(`http://${host}`).hostname);
	} catch {
		return false;
	}
}

/**
 * True when the request did not come straight from this PC. Next fills the
 * x-forwarded-* headers itself for every request (with loopback values), so
 * only non-loopback values count, never the mere presence of the header.
 */
export function isRemoteRequest(request: Request): boolean {
	const headers = request.headers;
	if (TAILSCALE_IDENTITY_HEADERS.some((name) => headers.has(name))) return true;
	// Like upstream subscriptionRequestOrigin: a real server always has Host; the URL is the fallback.
	const host = headers.get("host") ?? new URL(request.url).host;
	if (!host || !hostHeaderIsLoopback(host)) return true;
	const forwardedHost = headers.get("x-forwarded-host");
	if (forwardedHost && forwardedHost.split(",").some((value) => !hostHeaderIsLoopback(value.trim()))) return true;
	const forwardedFor = headers.get("x-forwarded-for");
	if (forwardedFor && forwardedFor.split(",").some((value) => !isLoopbackHostName(value.trim()))) return true;
	if (headers.has("forwarded")) return true;
	return false;
}

/** The gate only exists in the packaged desktop app; browser-only and dev servers keep upstream rules. */
export function remoteGateActive(env: Record<string, string | undefined> = process.env): boolean {
	return desktopServerMode(env);
}

export function remoteOrigin(policy: Extract<RemoteAccessPolicy, { enabled: true }>): string {
	return `https://${policy.dnsName}:${policy.servePort}`;
}

function readPairingCookie(cookieHeader: string | null): { deviceId: string; token: string } | null {
	if (!cookieHeader) return null;
	for (const part of cookieHeader.split(";")) {
		const separator = part.indexOf("=");
		if (separator < 0 || part.slice(0, separator).trim() !== PAIRING_COOKIE) continue;
		const value = part.slice(separator + 1).trim();
		const dot = value.indexOf(".");
		if (dot <= 0) return null;
		return { deviceId: value.slice(0, dot), token: value.slice(dot + 1) };
	}
	return null;
}

export function hashDeviceToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function findPairedDevice(policy: Extract<RemoteAccessPolicy, { enabled: true }>, cookieHeader: string | null, now: number): RemoteDevicePolicy | null {
	const cookie = readPairingCookie(cookieHeader);
	if (!cookie || cookie.token.length < 32 || cookie.token.length > 128) return null;
	const device = policy.devices.find((entry) => entry.id === cookie.deviceId);
	if (!device || device.expiresAt <= now) return null;
	const actual = Buffer.from(hashDeviceToken(cookie.token), "hex");
	const wanted = Buffer.from(device.tokenHash, "hex");
	return actual.length === wanted.length && timingSafeEqual(actual, wanted) ? device : null;
}

function requestHasBody(headers: Headers): boolean {
	const length = headers.get("content-length");
	return headers.has("transfer-encoding") || (length !== null && length.trim() !== "0");
}

/** Every check a request from Tailscale Serve must pass. Order matters: identity before pairing. */
export function checkRemoteRequest(request: Request, policy: RemoteAccessPolicy | null, now = Date.now()): RemoteCheck {
	if (!policy) return { allowed: false, kind: "not-ready", message: "LearnHarness is still starting on your computer. Try again in a moment." };
	if (!policy.enabled) return { allowed: false, kind: "off", message: "Remote access is turned off on the desktop app." };
	const headers = request.headers;
	const expectedHost = `${policy.dnsName}:${policy.servePort}`;
	const host = (headers.get("host") ?? new URL(request.url).host).toLowerCase();
	const forwardedHost = headers.get("x-forwarded-host")?.toLowerCase();
	if (host !== expectedHost || (forwardedHost !== undefined && forwardedHost !== expectedHost)) {
		return { allowed: false, kind: "host", message: "This address is not the LearnHarness remote address." };
	}
	const login = headers.get("tailscale-user-login");
	if (!login || login.toLowerCase() !== policy.ownerLogin.toLowerCase()) {
		return { allowed: false, kind: "identity", message: "This Tailscale account is not allowed to use this LearnHarness." };
	}
	const method = request.method.toUpperCase();
	if (method === "OPTIONS") return { allowed: false, kind: "method", message: "Cross-origin requests are not allowed." };
	if (!READ_METHODS.has(method)) {
		const site = headers.get("sec-fetch-site");
		if (headers.get("origin") !== remoteOrigin(policy) || (site !== null && site !== "same-origin")) {
			return { allowed: false, kind: "origin", message: "Cross-site requests to LearnHarness are not allowed." };
		}
		if (requestHasBody(headers)) {
			const type = (headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
			if (type !== "application/json" && type !== "multipart/form-data") {
				return { allowed: false, kind: "content-type", message: "This request body type is not allowed." };
			}
		}
	}
	const access = remoteRouteAccess(method, new URL(request.url).pathname);
	const device = findPairedDevice(policy, headers.get("cookie"), now);
	if (access === "before-pairing") return { allowed: true, device };
	if (!device) return { allowed: false, kind: "pairing", message: "Pair this device with the code shown in the desktop app's Remote Access settings." };
	if (access === "local-only") return { allowed: false, kind: "local-only", message: "Only available on the desktop app." };
	return { allowed: true, device };
}
