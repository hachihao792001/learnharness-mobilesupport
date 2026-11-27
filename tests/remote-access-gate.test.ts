// Fork: Remote Access — the server-side gate. Covers the 10 mandatory
// security cases (docs/REMOTE_ACCESS_SECURITY.md) through the real proxy(),
// apiRequestRefusal() and pair route, plus one full pairing round trip over
// the real IPC protocol wired to the real Electron-side manager.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { NextRequest } from "next/server";
import { proxy } from "../proxy.ts";
import { apiRequestRefusal, browserAPIRefusal } from "../src/server/desktop-access.ts";
import { hashDeviceToken, isRemoteRequest, PAIRING_COOKIE, REMOTE_GATE_HEADER } from "../src/remote-access/gate.ts";
import { setRemoteAccessPolicyForTests, type RemoteAccessPolicy } from "../src/remote-access/policy-store.ts";
import { remoteRouteAccess } from "../src/remote-access/route-policy.ts";
import { deviceLabelFromUserAgent } from "../src/remote-access/device-label.ts";
import { POST as pairPOST } from "../app/api/remote-access/pair/route.ts";
import { GET as pairPageGET } from "../app/remote/pair/route.ts";

const require = createRequire(import.meta.url);
const SECRET = "s".repeat(64);
const DNS = "company-cpu.tail14bb89.ts.net";
const ORIGIN = `https://${DNS}:8443`;
const OWNER = "owner@example.com";
const DEVICE_ID = "8c1f6a0e-2b7d-4c1a-9e3f-1a2b3c4d5e6f";
const TOKEN = "t".repeat(43);
const LOCAL = "http://127.0.0.1:50123";

function policy(overrides: Partial<Extract<RemoteAccessPolicy, { enabled: true }>> = {}): RemoteAccessPolicy {
	return { enabled: true, dnsName: DNS, servePort: 8443, ownerLogin: OWNER, devices: [{ id: DEVICE_ID, tokenHash: hashDeviceToken(TOKEN), expiresAt: Date.now() + 60_000 }], ...overrides };
}

/** What Tailscale Serve forwards for the owner's paired phone. */
function remote(path: string, { method = "GET", headers = {} as Record<string, string | null>, paired = true, body }: { method?: string; headers?: Record<string, string | null>; paired?: boolean; body?: string } = {}) {
	const base: Record<string, string | null> = {
		host: `${DNS}:8443`,
		"tailscale-user-login": OWNER,
		"x-forwarded-for": "100.101.102.103",
		...(paired ? { cookie: `${PAIRING_COOKIE}=${DEVICE_ID}.${TOKEN}` } : {}),
		...(method !== "GET" && method !== "HEAD" ? { origin: ORIGIN, "sec-fetch-site": "same-origin" } : {}),
		...(body !== undefined ? { "content-type": "application/json", "content-length": String(body.length) } : {}),
		...headers,
	};
	const finalHeaders = Object.fromEntries(Object.entries(base).filter((entry): entry is [string, string] => entry[1] !== null));
	return new NextRequest(`${ORIGIN}${path}`, { method, headers: finalHeaders, ...(body !== undefined ? { body } : {}) });
}

const passes = (response: Response) => response.headers.get("x-middleware-next") === "1";

let savedEnv: Record<string, string | undefined>;
before(() => {
	savedEnv = { LH_DESKTOP_SERVER: process.env.LH_DESKTOP_SERVER, LH_DESKTOP_API_SECRET: process.env.LH_DESKTOP_API_SECRET };
	process.env.LH_DESKTOP_SERVER = "1";
	process.env.LH_DESKTOP_API_SECRET = SECRET;
});
after(() => {
	for (const [name, value] of Object.entries(savedEnv)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
	setRemoteAccessPolicyForTests(null);
});
beforeEach(() => setRemoteAccessPolicyForTests(policy()));

describe("telling remote requests from local ones", () => {
	it("treats the desktop window's own requests as local, even though Next fills x-forwarded-* itself", () => {
		assert.equal(isRemoteRequest(new NextRequest(`${LOCAL}/chat/new`)), false);
		assert.equal(isRemoteRequest(new NextRequest(`${LOCAL}/chat/new`, { headers: { host: "127.0.0.1:50123", "x-forwarded-host": "127.0.0.1:50123", "x-forwarded-for": "::ffff:127.0.0.1", "x-forwarded-proto": "http" } })), false);
		assert.equal(isRemoteRequest(new NextRequest("http://localhost:3000/")), false);
	});

	it("treats Tailscale identity, a non-loopback host or a non-loopback forwarded address as remote", () => {
		for (const headers of <Record<string, string>[]>[{ "tailscale-user-login": "x" }, { "tailscale-user-name": "x" }, { host: `${DNS}:8443` }, { "x-forwarded-for": "100.64.0.9" }, { "x-forwarded-host": "evil.example" }, { forwarded: "for=1.2.3.4" }]) {
			assert.equal(isRemoteRequest(new NextRequest(`${LOCAL}/`, { headers })), true, JSON.stringify(headers));
		}
	});
});

describe("mandatory security cases", () => {
	it("1. forged Tailscale headers sent straight to the loopback port are refused", () => {
		const forged = new NextRequest(`${LOCAL}/chat/abc`, { headers: { host: "127.0.0.1:50123", "tailscale-user-login": OWNER } });
		const response = proxy(forged);
		assert.equal(response.status, 403);
		assert.equal(response.headers.get(REMOTE_GATE_HEADER), "gate");
		assert.equal(proxy(new NextRequest(`${LOCAL}/api/chats`, { headers: { host: "127.0.0.1:50123", "tailscale-user-login": OWNER } })).status, 403);
	});

	it("2. another Tailscale account is refused, even with a valid pairing cookie", async () => {
		for (const login of ["friend@other.example", `${OWNER}.evil`, ""]) {
			const response = proxy(remote("/api/chats", { headers: { "tailscale-user-login": login } }));
			assert.equal(response.status, 403, login);
			assert.equal((await response.json()).code, "remote-identity");
		}
	});

	it("3. a request with no Tailscale identity (e.g. a tagged device) is refused", () => {
		assert.equal(proxy(remote("/chat/abc", { headers: { "tailscale-user-login": null } })).status, 403);
		assert.equal(proxy(remote("/api/graph", { headers: { "tailscale-user-login": null } })).status, 403);
	});

	it("4. a local program that fakes the exact Serve headers still needs a paired device", async () => {
		const page = proxy(remote("/chat/abc", { paired: false }));
		assert.equal(page.status, 303);
		assert.equal(page.headers.get("location"), "/remote/pair?next=%2Fchat%2Fabc");
		const api = proxy(remote("/api/chats", { paired: false }));
		assert.equal(api.status, 401);
		assert.equal((await api.json()).code, "remote-pairing-required");
		for (const cookie of [`${PAIRING_COOKIE}=${DEVICE_ID}.${"x".repeat(43)}`, `${PAIRING_COOKIE}=00000000-0000-4000-8000-000000000000.${TOKEN}`, `${PAIRING_COOKIE}=${TOKEN}`, `other=${DEVICE_ID}.${TOKEN}`]) {
			assert.equal(proxy(remote("/api/chats", { paired: false, headers: { cookie } })).status, 401, cookie);
		}
		// Without the desktop secret and without remote markers, upstream refuses the API as before.
		assert.equal(proxy(new NextRequest(`${LOCAL}/api/chats`)).status, 403);
		assert.equal(apiRequestRefusal(new NextRequest(`${LOCAL}/api/chats`)), "Desktop API access requires the trusted LearnHarness window.");
	});

	it("5. cross-origin or form-like writes are refused", () => {
		const body = JSON.stringify({ chatId: "x", input: { type: "continue" } });
		assert(passes(proxy(remote("/api/chat", { method: "POST", body }))));
		for (const headers of <Record<string, string | null>[]>[{ origin: "https://evil.example" }, { origin: null }, { origin: `http://${DNS}:8443` }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }]) {
			assert.equal(proxy(remote("/api/chat", { method: "POST", body, headers })).status, 403, JSON.stringify(headers));
		}
		for (const type of ["text/plain", "application/x-www-form-urlencoded", ""]) {
			assert.equal(proxy(remote("/api/chat", { method: "POST", body, headers: { "content-type": type } })).status, 415, type);
		}
		assert.equal(proxy(remote("/api/chat", { method: "OPTIONS" })).status, 405);
		assert(passes(proxy(remote("/api/chats/x/side-chats/y/stop", { method: "POST" }))), "a write without a body needs no content type");
	});

	it("6. desktop-only APIs are refused to a paired phone, however the path is spelled", async () => {
		const refused: [string, string][] = [
			["GET", "/api/keys"], ["PUT", "/api/keys/OPENAI_API_KEY"], ["GET", "/api/custom-provider"], ["POST", "/api/custom-provider"],
			["GET", "/api/subscriptions"], ["GET", "/api/claude-code"], ["PUT", "/api/settings/agent"], ["PUT", "/api/settings/general"],
			["GET", "/api/settings/prompts"], ["PUT", "/api/settings/prompts/teacher/base"], ["POST", "/api/themes"], ["DELETE", "/api/themes/x"],
			["POST", "/api/plugins"], ["PUT", "/api/plugins/x"], ["POST", "/api/models"], ["GET", "/api/not-a-route"],
			["GET", "/api/%6Beys"], ["GET", "/API/keys"], ["GET", "//api//keys"], ["GET", "/api/keys/"],
		];
		for (const [method, path] of refused) {
			const response = proxy(remote(path, { method, ...(method === "GET" ? {} : { body: "{}" }) }));
			assert.equal(response.status, 403, `${method} ${path}`);
		}
		const response = proxy(remote("/api/keys"));
		assert.equal((await response.json()).error, "Only available on the desktop app.");
		for (const [method, path] of [["GET", "/api/settings"], ["GET", "/api/models"], ["GET", "/api/stt/token"], ["PUT", "/api/chats/abc/settings"], ["GET", "/api/chats/abc/stream"], ["GET", "/api/events"]]) {
			assert(passes(proxy(remote(path!, { method, ...(method === "GET" ? {} : { body: "{}" }) }))), `${method} ${path}`);
		}
	});

	it("7. paths that try to escape with encoded or backslash segments are refused", () => {
		assert.equal(remoteRouteAccess("GET", "/api/plugins/x/assets/..%5C..%5Cauth.json"), "local-only");
		assert.equal(remoteRouteAccess("GET", "/api/%E0%A4%A"), "local-only");
		assert.equal(remoteRouteAccess("GET", "/chat/%5C..%5Cx"), "local-only");
		assert.equal(proxy(remote("/api/plugins/x/assets/..%5C..%5Cauth.json")).status, 403);
	});

	it("8. no credential reaches the phone: the cookie is HttpOnly and pair responses carry no token", async () => {
		const page = await pairPageGET().text();
		assert(!page.includes(TOKEN));
		const refused = proxy(remote("/api/keys"));
		assert(!(await refused.text()).includes("sk-"));
		// The full pairing round trip below checks the Set-Cookie flags and body.
	});

	it("9. unexpected Host or forwarded host is refused", () => {
		for (const headers of <Record<string, string>[]>[{ host: "evil.example" }, { host: `${DNS}:443` }, { host: DNS }, { host: `${DNS}.evil.example:8443` }, { "x-forwarded-host": "evil.example" }]) {
			assert.equal(proxy(remote("/chat/abc", { headers })).status, 403, JSON.stringify(headers));
		}
	});

	it("10. once Remote Access is off, nothing remote gets through, even a paired phone", () => {
		setRemoteAccessPolicyForTests({ enabled: false });
		for (const path of ["/chat/abc", "/api/chats", "/remote/pair", "/api/remote-access/pair"]) {
			const response = proxy(remote(path, { method: path.endsWith("pair") && path.startsWith("/api") ? "POST" : "GET" }));
			assert.equal(response.status, 403, path);
		}
		assert.equal(apiRequestRefusal(remote("/api/plugins/x/documents/markdown", { method: "POST", body: "{}" })), "Desktop API access requires the trusted LearnHarness window.");
	});
});

describe("what a paired phone can do", () => {
	it("opens pages and APIs, marked no-store and with the gate header", () => {
		for (const path of ["/", "/chat/abc", "/chat/new?mode=practice", "/api/chats", "/api/graph"]) {
			const response = proxy(remote(path));
			assert(passes(response), path);
			assert.equal(response.headers.get("cache-control"), "no-store");
			assert.equal(response.headers.get(REMOTE_GATE_HEADER), "gate");
		}
	});

	it("reaches the pairing page and static assets before pairing, but nothing else", () => {
		for (const path of ["/remote/pair", "/remote/pair?next=%2F", "/fonts/cmunbx.ttf", "/_next/static/chunks/x.js"]) assert(passes(proxy(remote(path, { paired: false }))), path);
		assert.equal(proxy(remote("/plugin-loader.js", { paired: false })).status, 303);
	});

	it("an expired pairing needs pairing again", () => {
		setRemoteAccessPolicyForTests(policy({ devices: [{ id: DEVICE_ID, tokenHash: hashDeviceToken(TOKEN), expiresAt: Date.now() - 1 }] }));
		assert.equal(proxy(remote("/api/chats")).status, 401);
	});

	it("the streamed plugin-document route (which skips the proxy) gets the same decision", () => {
		assert.equal(apiRequestRefusal(remote("/api/plugins/x/documents/markdown", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": "10" } })), undefined);
		assert.notEqual(apiRequestRefusal(remote("/api/plugins/x/documents/markdown", { method: "GET" })), undefined);
		assert.notEqual(apiRequestRefusal(remote("/api/plugins/x/documents/markdown", { method: "POST", paired: false, body: "{}" })), undefined);
	});

	it("answers 503, not 'off', while the policy has not arrived yet", () => {
		setRemoteAccessPolicyForTests(null);
		assert.equal(proxy(remote("/chat/abc")).status, 503);
	});
});

describe("upstream behaviour is unchanged", () => {
	it("the desktop window with its secret, and local pages, pass as before", () => {
		assert(passes(proxy(new NextRequest(`${LOCAL}/api/settings`, { headers: { "x-learnharness-desktop": SECRET } }))));
		assert(passes(proxy(new NextRequest(`${LOCAL}/chat/new`))));
		assert(passes(proxy(new NextRequest(`${LOCAL}/`, { headers: { host: "127.0.0.1:50123", "x-forwarded-for": "127.0.0.1" } }))));
	});

	it("browser-only mode ignores the remote gate entirely, even with Tailscale headers", () => {
		const env = {};
		const request = new NextRequest(`${ORIGIN}/api/chats`, { headers: { host: `${DNS}:8443`, "tailscale-user-login": OWNER } });
		assert.equal(apiRequestRefusal(request, env), browserAPIRefusal(request, env));
		const saved = process.env.LH_DESKTOP_SERVER, savedSecret = process.env.LH_DESKTOP_API_SECRET;
		delete process.env.LH_DESKTOP_SERVER; delete process.env.LH_DESKTOP_API_SECRET;
		try {
			const response = proxy(request);
			assert.notEqual(response.headers.get(REMOTE_GATE_HEADER), "gate");
		} finally {
			process.env.LH_DESKTOP_SERVER = saved; process.env.LH_DESKTOP_API_SECRET = savedSecret;
		}
	});
});

describe("device labels", () => {
	it("names common phones and browsers plainly", () => {
		assert.equal(deviceLabelFromUserAgent("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36"), "Chrome on Android");
		assert.equal(deviceLabelFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1"), "Safari on iPhone");
		assert.equal(deviceLabelFromUserAgent("Mozilla/5.0 (Linux; Android 15) SamsungBrowser/28.0 Chrome/130.0 Mobile Safari/537.36"), "Samsung Internet on Android");
		assert.equal(deviceLabelFromUserAgent(null), "Browser");
	});
});

describe("pairing round trip over the real IPC protocol", () => {
	const manager = require("../electron/remote-access/remote-access-manager.cjs");
	const { attachRemoteAccessChild } = require("../electron/remote-access/remote-access-ipc.cjs");
	const { emptyState } = require("../electron/remote-access/remote-access-store.cjs");
	let restore: () => void;

	before(() => {
		const saved = { send: process.send, connected: Object.getOwnPropertyDescriptor(process, "connected") };
		restore = () => {
			if (saved.send) process.send = saved.send; else delete (process as { send?: unknown }).send;
			if (saved.connected) Object.defineProperty(process, "connected", saved.connected); else delete (process as { connected?: unknown }).connected;
		};
	});
	after(() => restore());

	it("pairs a phone, sets a strict HttpOnly cookie, and that cookie then opens the app", async () => {
		// Electron side: the real manager with a fake Tailscale, linked to a fake child pipe.
		const child = Object.assign(new EventEmitter(), { connected: true, send(packet: unknown, callback: () => void) { setImmediate(() => process.emit("message" as never, packet as never)); callback(); } });
		let saved = emptyState();
		let link: { sendSnapshot(snapshot: unknown): void } | null = null;
		const instance = manager.createRemoteAccess({
			store: { read: async () => saved, write: async (state: unknown) => { saved = structuredClone(state); }, writeSync() {} },
			getServerPort: () => 50123,
			onSnapshot: (snapshot: unknown) => link?.sendSnapshot(snapshot),
			findExecutable: () => "ts",
			makeCommands: () => {
				let config = {};
				return {
					readStatus: async () => ({ backendState: "Running", dnsName: DNS, ownerLogin: OWNER, httpsCertsEnabled: true, taggedDevice: false }),
					readServeConfig: async () => config,
					addServeEntry: async (port: number) => { config = { TCP: { "8443": { HTTPS: true } }, Web: { [`${DNS}:8443`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } } }; },
					removeServeEntry: async () => { config = {}; },
				};
			},
			probe: async () => true,
		});
		link = attachRemoteAccessChild(child, instance);
		// Server side: this process plays the Next server with an IPC pipe.
		process.send = ((message: unknown, callback?: (error: Error | null) => void) => { setImmediate(() => child.emit("message", message)); callback?.(null); return true; }) as typeof process.send;
		Object.defineProperty(process, "connected", { value: true, configurable: true });
		setRemoteAccessPolicyForTests(null);

		await instance.enable();
		await new Promise((resolve) => setImmediate(resolve));
		const { pairing } = await instance.startPairing();

		const wrong = await pairPOST(remote("/api/remote-access/pair", { method: "POST", paired: false, body: JSON.stringify({ code: "WRONGCOD" }) }));
		assert.equal(wrong.status, 400);
		assert.equal(wrong.headers.get("set-cookie"), null);

		const ok = await pairPOST(remote("/api/remote-access/pair", { method: "POST", paired: false, body: JSON.stringify({ code: pairing.code }), headers: { "user-agent": "Mozilla/5.0 (Linux; Android 15) Chrome/140.0 Mobile" } }));
		assert.equal(ok.status, 200);
		const cookie = ok.headers.get("set-cookie")!;
		assert.match(cookie, new RegExp(`^${PAIRING_COOKIE}=[0-9a-f-]{36}\\.[A-Za-z0-9_-]{43}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=\\d+$`));
		const bodyText = JSON.stringify(await ok.json());
		assert(!bodyText.includes(cookie.split("=")[1]!.split(";")[0]!.split(".")[1]!), "the token is only in the HttpOnly cookie");
		assert.equal((await instance.status()).devices[0].label, "Chrome on Android");

		await new Promise((resolve) => setImmediate(resolve));
		const cookieValue = cookie.split(";")[0]!;
		assert(passes(proxy(remote("/chat/abc", { paired: false, headers: { cookie: cookieValue } }))), "the new cookie opens the app");

		// The desktop window cannot pair itself through this route.
		assert.equal((await pairPOST(new NextRequest(`${LOCAL}/api/remote-access/pair`, { method: "POST", body: JSON.stringify({ code: "X" }) }))).status, 403);

		await instance.disable();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(proxy(remote("/chat/abc", { paired: false, headers: { cookie: cookieValue } })).status, 403, "off closes the gate at once");
	});
});
