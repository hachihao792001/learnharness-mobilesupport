import { NextResponse, type NextRequest } from "next/server";
import { apiRequestRefusal, desktopAPIAuthorized } from "./src/server/desktop-access.ts";
// Fork: Remote Access (docs/UPSTREAM_MODIFICATIONS.md).
import { isRemoteAccessRequest, remoteAccessProxyResponse } from "./src/remote-access/proxy-hooks.ts";
import { isAPIPath } from "./src/remote-access/route-policy.ts";

/** Protects API methods, including SSE and spending/settings routes. The one
 * streamed document route enforces the identical all-method request policy
 * inside its handler, avoiding Next's silently truncated Proxy body clone.
 * No public callback or worker bypass: legitimate self-HTTP still needs the capability. */
export function proxy(request: NextRequest) {
	// Fork: requests that came through Tailscale Serve are answered by the
	// remote gate (pages too: they carry transcripts). The desktop secret still
	// decides first, and local page requests pass untouched, exactly as when
	// the matcher covered only /api.
	if (!desktopAPIAuthorized(request.headers) && isRemoteAccessRequest(request)) return remoteAccessProxyResponse(request);
	if (!isAPIPath(request.nextUrl.pathname)) return NextResponse.next();
	const refusal = apiRequestRefusal(request);
	if (refusal) {
		return NextResponse.json(
			{ error: refusal },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	return NextResponse.next();
}

export const config = {
	// Keep /api itself covered; exempt only the exact streamed endpoint, not
	// the documents subtree or other plugin routes. Must remain static literals.
	// Fork: the third entry adds every non-API path except build assets, for the remote gate.
	matcher: ["/api", "/api/((?!plugins/[^/]+/documents/markdown/?$).*)", "/((?!api$|api/|_next/static/).*)"],
};
