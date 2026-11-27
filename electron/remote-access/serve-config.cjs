"use strict";
// Fork: Remote Access. Reads `tailscale serve status --json` and says what is
// on the one HTTPS port LearnHarness uses. It never decides to change anything
// on another port or host name.

const LOOPBACK_PROXY = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/;

/**
 * Returns one of:
 *   { kind: "free" }
 *   { kind: "loopback-proxy", serverPort }   a single "/" proxy to 127.0.0.1
 *   { kind: "other", reason }                 anything else: never ours to touch
 */
function describeServePort(config, dnsName, servePort) {
	const portKey = String(servePort);
	const hostPort = `${dnsName}:${servePort}`;
	const tcpEntry = config?.TCP?.[portKey];
	const webEntry = findWebEntry(config?.Web, hostPort);

	const foregroundUsesPort = Object.values(config?.Foreground ?? {}).some((session) => session?.TCP?.[portKey]);
	if (foregroundUsesPort) return { kind: "other", reason: "A foreground `tailscale serve` session is using this port." };
	if (findWebEntry(config?.AllowFunnel, hostPort)) return { kind: "other", reason: "Tailscale Funnel is turned on for this port." };
	if (!tcpEntry && !webEntry) return { kind: "free" };
	if (!tcpEntry?.HTTPS) return { kind: "other", reason: "This port is used for a TCP forward, not HTTPS." };
	if (!webEntry) return { kind: "other", reason: "This port is set to HTTPS for a different host name." };

	const handlers = webEntry.Handlers ?? {};
	const handlerPaths = Object.keys(handlers);
	if (handlerPaths.length !== 1 || handlerPaths[0] !== "/") return { kind: "other", reason: "This port serves more than one path." };
	const match = typeof handlers["/"]?.Proxy === "string" ? LOOPBACK_PROXY.exec(handlers["/"].Proxy) : null;
	if (!match) return { kind: "other", reason: "This port serves something other than a local web server." };
	const serverPort = Number(match[1]);
	if (serverPort < 1 || serverPort > 65535) return { kind: "other", reason: "This port points at an invalid local port." };
	return { kind: "loopback-proxy", serverPort };
}

/** Serve keys host names exactly as the node reports them; compare without case. */
function findWebEntry(entries, hostPort) {
	if (!entries || typeof entries !== "object") return undefined;
	const wanted = hostPort.toLowerCase();
	const key = Object.keys(entries).find((name) => name.toLowerCase() === wanted);
	return key === undefined ? undefined : entries[key];
}

module.exports = { describeServePort };
