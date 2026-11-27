// Fork: Remote Access. The pair route's work (app/api/remote-access/pair/route.ts).
// A phone sends the code shown on the desktop and gets a pairing cookie.
// Main keeps only the token's hash.
import { checkRemoteRequest, isRemoteRequest, PAIRING_COOKIE, remoteGateActive } from "./gate.ts";
import { loadRemoteAccessPolicy, remoteAccessRequest } from "./policy-store.ts";
import { deviceLabelFromUserAgent } from "./device-label.ts";

const MAX_BODY_BYTES = 1024;
const STATUS_FOR_ERROR: Record<string, number> = {
	"not-enabled": 403,
	"pairing-wrong-login": 403,
	"no-pairing-code": 400,
	"pairing-code-expired": 400,
	"pairing-code-wrong": 400,
	"pairing-code-locked": 429,
	"too-many-devices": 409,
};

function reply(body: unknown, status: number, headers: Record<string, string> = {}): Response {
	return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export async function remoteAccessPairResponse(request: Request): Promise<Response> {
	// The proxy already ran the gate; check again here so this route never
	// depends on the proxy matcher alone.
	if (!remoteGateActive() || !isRemoteRequest(request)) {
		return reply({ error: "Pair from the phone, using the remote address." }, 403);
	}
	const check = checkRemoteRequest(request, await loadRemoteAccessPolicy());
	if (!check.allowed) return reply({ error: check.message }, 403);

	const declaredLength = Number(request.headers.get("content-length") ?? "0");
	if (!Number.isFinite(declaredLength) || declaredLength > MAX_BODY_BYTES) return reply({ error: "Request too large." }, 413);
	const text = await request.text();
	if (text.length > MAX_BODY_BYTES) return reply({ error: "Request too large." }, 413);
	let code: unknown;
	try { code = (JSON.parse(text) as { code?: unknown }).code; } catch { return reply({ error: "Invalid request." }, 400); }
	if (typeof code !== "string" || code.length === 0 || code.length > 32) return reply({ error: "Enter the pairing code." }, 400);

	try {
		const paired = await remoteAccessRequest<{ deviceId: string; token: string; expiresAt: number }>("pair", {
			code,
			login: request.headers.get("tailscale-user-login") ?? "",
			label: deviceLabelFromUserAgent(request.headers.get("user-agent")),
		});
		const maxAgeSeconds = Math.max(0, Math.floor((paired.expiresAt - Date.now()) / 1000));
		const cookie = `${PAIRING_COOKIE}=${paired.deviceId}.${paired.token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
		return reply({ ok: true }, 200, { "Set-Cookie": cookie });
	} catch (error) {
		const code = (error as { code?: string }).code ?? "failed";
		return reply({ error: (error as Error).message, code }, STATUS_FOR_ERROR[code] ?? 503);
	}
}
