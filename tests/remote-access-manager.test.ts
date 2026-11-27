// Fork: Remote Access — store, manager and Electron IPC. Tailscale is a fake
// that keeps a Serve config in memory, so no tailnet is needed.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { remoteAccessStore, emptyState } = require("../electron/remote-access/remote-access-store.cjs");
const manager = require("../electron/remote-access/remote-access-manager.cjs");
const { remoteAccessControl, attachRemoteAccessChild } = require("../electron/remote-access/remote-access-ipc.cjs");
const { setUpRemoteAccess } = require("../electron/remote-access/setup-remote-access.cjs");

const DNS = "company-cpu.tail14bb89.ts.net";
const OWNER = "owner@example.com";

type ServeConfig = Record<string, unknown>;
interface FakeTailscale {
	config: ServeConfig;
	status: Record<string, unknown>;
	calls: string[];
	failAdd?: boolean;
}

function proxyConfig(serverPort: number): ServeConfig {
	return { TCP: { "8443": { HTTPS: true } }, Web: { [`${DNS}:8443`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${serverPort}` } } } } };
}

function fakeTailscale(): FakeTailscale {
	return { config: {}, status: { backendState: "Running", dnsName: DNS, ownerLogin: OWNER, httpsCertsEnabled: true, taggedDevice: false }, calls: [] };
}

function memoryStore(initial = emptyState()) {
	let saved = structuredClone(initial);
	return {
		writes: 0,
		get saved() { return saved; },
		async read() { return structuredClone(saved); },
		async write(state: unknown) { this.writes++; saved = structuredClone(state); },
		writeSync(state: unknown) { this.writes++; saved = structuredClone(state); },
	};
}

function build({ ts = fakeTailscale(), store = memoryStore(), serverPort = 50123 as number | null, executable = "ts" as string | null, clock = { now: 1_000_000 } } = {}) {
	const snapshots: unknown[] = [];
	let changes = 0;
	const instance = manager.createRemoteAccess({
		store,
		getServerPort: () => serverPort,
		onSnapshot: (snapshot: unknown) => snapshots.push(snapshot),
		onChange: () => { changes++; },
		now: () => clock.now,
		findExecutable: () => executable,
		makeCommands: () => ({
			async readStatus() { ts.calls.push("status"); return ts.status; },
			async readServeConfig() { ts.calls.push("serve-status"); return ts.config; },
			async addServeEntry(port: number) { ts.calls.push(`add ${port}`); if (ts.failAdd) throw Object.assign(new Error("x"), { code: "tailscale-command-failed", stderr: "denied" }); ts.config = proxyConfig(port); },
			async removeServeEntry() { ts.calls.push("remove"); ts.config = {}; },
		}),
		removeEntrySync: (file: string) => { ts.calls.push(`remove-sync ${file}`); ts.config = {}; },
		probe: async () => true,
		randomBytesImpl: (size: number) => Buffer.alloc(size, 7),
	});
	return { instance, ts, store, snapshots, clock, changes: () => changes };
}

describe("remote-access.json store", () => {
	let dir: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lh-remote-store-")); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	it("starts empty, round-trips, and leaves no temp files", async () => {
		const file = join(dir, "remote-access.json");
		const store = remoteAccessStore(file);
		assert.deepEqual(await store.read(), emptyState());
		const state = { ...emptyState(), enabled: true, serveEntryOwned: true, devices: [{ id: "8c1f6a0e-2b7d-4c1a-9e3f-1a2b3c4d5e6f", label: "Chrome on Android", login: OWNER, createdAt: 1, expiresAt: 2, lastSeenAt: 1, tokenHash: "a".repeat(64) }] };
		await store.write(state);
		assert.deepEqual(await store.read(), state);
		store.writeSync({ ...state, serveEntryOwned: false });
		assert.equal((await store.read()).serveEntryOwned, false);
		assert.deepEqual(readdirSync(dir), ["remote-access.json"]);
	});

	it("reports a corrupt or wrong-shaped file instead of replacing it", async () => {
		const file = join(dir, "remote-access.json");
		for (const content of ["{not json", JSON.stringify({ version: 2 }), JSON.stringify({ ...emptyState(), devices: [{ id: "x" }] })]) {
			writeFileSync(file, content);
			await assert.rejects(remoteAccessStore(file).read(), { code: "storage" });
			assert.equal(readFileSync(file, "utf8"), content);
		}
	});

	it("refuses to write an invalid state", async () => {
		await assert.rejects(remoteAccessStore(join(dir, "r.json")).write({ ...emptyState(), devices: [{ id: "nope" }] }), { code: "storage" });
	});
});

describe("turning Remote Access on and off", () => {
	it("adds the :8443 entry for the server port, verifies it, then pushes an enabled snapshot without tokens", async () => {
		const f = build();
		const status = await f.instance.enable();
		assert.equal(status.state, "on");
		assert.equal(status.url, `https://${DNS}:8443`);
		assert.deepEqual(f.ts.config, proxyConfig(50123));
		assert.equal(f.store.saved.enabled, true);
		assert.equal(f.store.saved.serveEntryOwned, true);
		assert.deepEqual(f.snapshots.at(-1), { enabled: true, dnsName: DNS, servePort: 8443, ownerLogin: OWNER, devices: [] });
		assert(f.ts.calls.indexOf("add 50123") > 0);
	});

	it("stops and changes nothing when port 8443 is used by something else", async () => {
		for (const config of [proxyConfig(3000), { TCP: { "8443": { TCPForward: "127.0.0.1:22" } } }]) {
			const ts = fakeTailscale();
			ts.config = structuredClone(config);
			const f = build({ ts });
			const status = await f.instance.enable();
			assert.equal(status.state, "error");
			assert.equal(status.error.code, "serve-port-conflict");
			assert.deepEqual(ts.config, config, "the other config is untouched");
			assert(!ts.calls.some((call) => call.startsWith("add") || call === "remove"));
			assert.deepEqual(f.snapshots.at(-1), { enabled: false });
		}
	});

	it("points its own entry at the new port after an app restart", async () => {
		const ts = fakeTailscale();
		ts.config = proxyConfig(40000);
		const store = memoryStore({ ...emptyState(), enabled: true, serveEntryOwned: true });
		const f = build({ ts, store, serverPort: 50123 });
		const status = await f.instance.reconcile();
		assert.equal(status.state, "on");
		assert.deepEqual(ts.config, proxyConfig(50123));
		assert.deepEqual(ts.calls.filter((call) => call === "remove" || call.startsWith("add")), ["remove", "add 50123"]);
	});

	it("leaves an already-correct entry alone", async () => {
		const ts = fakeTailscale();
		ts.config = proxyConfig(50123);
		const f = build({ ts, store: memoryStore({ ...emptyState(), enabled: true, serveEntryOwned: true }) });
		await f.instance.reconcile();
		assert(!ts.calls.some((call) => call === "remove" || call.startsWith("add")));
	});

	it("reports each missing dependency plainly and stays closed", async () => {
		const cases: [string, (f: FakeTailscale) => void, { executable?: string | null; serverPort?: number | null }][] = [
			["tailscale-missing", () => {}, { executable: null }],
			["server-not-running", () => {}, { serverPort: null }],
			["tailscale-not-running", (ts) => { ts.status.backendState = "Stopped"; }, {}],
			["tailscale-tagged", (ts) => { ts.status.taggedDevice = true; }, {}],
			["https-certs-off", (ts) => { ts.status.httpsCertsEnabled = false; }, {}],
			["owner-unknown", (ts) => { ts.status.ownerLogin = ""; }, {}],
		];
		for (const [code, change, options] of cases) {
			const ts = fakeTailscale();
			change(ts);
			const f = build({ ts, ...options });
			const status = await f.instance.enable();
			assert.equal(status.error?.code, code);
			assert.equal(status.state, "error");
			assert.deepEqual(f.snapshots.at(-1), { enabled: false });
			assert.deepEqual(ts.config, {});
		}
	});

	it("reports a failed Serve command without showing it as on", async () => {
		const ts = fakeTailscale();
		ts.failAdd = true;
		const status = await build({ ts }).instance.enable();
		assert.equal(status.state, "error");
		assert.equal(status.error.code, "serve-command-failed");
	});

	it("closes the gate first, then removes only its own entry, when turned off", async () => {
		const f = build();
		await f.instance.enable();
		const status = await f.instance.disable();
		assert.equal(status.state, "off");
		assert.deepEqual(f.ts.config, {});
		assert.equal(f.store.saved.enabled, false);
		assert.equal(f.store.saved.serveEntryOwned, false);
		assert.deepEqual(f.snapshots.at(-1), { enabled: false });
	});

	it("does not remove an entry that someone else changed after LearnHarness set it", async () => {
		const f = build();
		await f.instance.enable();
		const foreign = { TCP: { "8443": { HTTPS: true } }, Web: { [`${DNS}:8443`]: { Handlers: { "/": { Path: "/srv" } } } } };
		f.ts.config = foreign;
		await f.instance.disable();
		assert.deepEqual(f.ts.config, foreign);
		assert.equal(f.store.saved.serveEntryOwned, false);
	});

	it("removes its entry synchronously on quit and records that it no longer owns one", async () => {
		const f = build();
		await f.instance.enable();
		f.instance.removeOnQuit();
		assert.deepEqual(f.ts.config, {});
		assert(f.ts.calls.includes("remove-sync ts"));
		assert.equal(f.store.saved.serveEntryOwned, false);
		assert.equal(f.store.saved.enabled, true, "still on: the next launch adds the entry again");
		const next = build({ ts: f.ts, store: f.store });
		assert.equal((await next.instance.reconcile()).state, "on");
	});

	it("cleans up an owned entry left by a crash while Remote Access was off", async () => {
		const ts = fakeTailscale();
		ts.config = proxyConfig(40000);
		const f = build({ ts, store: memoryStore({ ...emptyState(), enabled: false, serveEntryOwned: true }) });
		await f.instance.reconcile();
		assert.deepEqual(ts.config, {});
		assert.equal(f.store.saved.serveEntryOwned, false);
	});
});

describe("pairing devices", () => {
	async function enabled() {
		const f = build();
		await f.instance.enable();
		return f;
	}

	it("creates an 8-letter code without look-alike characters, valid for 5 minutes", async () => {
		const f = await enabled();
		const status = await f.instance.startPairing();
		assert.match(status.pairing.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
		assert.equal(status.pairing.expiresAt, f.clock.now + 5 * 60 * 1000);
		const random = manager.createPairingCode((size: number) => Buffer.from([...Array(size).keys()].map((index) => index * 37)));
		assert.equal(random.length, 8);
	});

	it("refuses to pair while Remote Access is off", async () => {
		await assert.rejects(build().instance.startPairing(), { code: "not-enabled" });
	});

	it("pairs once with the right code and login, keeping only the token's hash", async () => {
		const f = await enabled();
		const { pairing } = await f.instance.startPairing();
		const paired = await f.instance.pairDevice({ code: ` ${pairing.code.slice(0, 4).toLowerCase()}-${pairing.code.slice(4)} `, login: OWNER.toUpperCase(), label: "Chrome on Android" });
		assert.match(paired.token, /^[A-Za-z0-9_-]{43}$/);
		const device = f.store.saved.devices[0];
		assert.equal(device.tokenHash, manager.hashDeviceToken(paired.token));
		assert.equal(device.expiresAt, f.clock.now + 90 * 24 * 60 * 60 * 1000);
		assert(!JSON.stringify(f.store.saved).includes(paired.token), "the token itself is never saved");
		assert(!JSON.stringify(f.snapshots).includes(paired.token), "the token is never pushed to the server");
		assert.deepEqual(f.snapshots.at(-1), { enabled: true, dnsName: DNS, servePort: 8443, ownerLogin: OWNER, devices: [{ id: device.id, tokenHash: device.tokenHash, expiresAt: device.expiresAt }] });
		const status = await f.instance.status();
		assert.equal(status.pairing, null, "a code works only once");
		assert(!JSON.stringify(status).includes(device.tokenHash), "the desktop UI never sees hashes");
		await assert.rejects(f.instance.pairDevice({ code: pairing.code, login: OWNER, label: "again" }), { code: "no-pairing-code" });
	});

	it("rejects another Tailscale account even with the right code", async () => {
		const f = await enabled();
		const { pairing } = await f.instance.startPairing();
		await assert.rejects(f.instance.pairDevice({ code: pairing.code, login: "friend@other.example", label: "x" }), { code: "pairing-wrong-login" });
		assert.equal(f.store.saved.devices.length, 0);
	});

	it("locks the code after 5 wrong tries", async () => {
		const f = await enabled();
		const { pairing } = await f.instance.startPairing();
		for (let attempt = 1; attempt <= 4; attempt++) await assert.rejects(f.instance.pairDevice({ code: "WRONGCOD", login: OWNER, label: "x" }), { code: "pairing-code-wrong" });
		await assert.rejects(f.instance.pairDevice({ code: "WRONGCOD", login: OWNER, label: "x" }), { code: "pairing-code-locked" });
		await assert.rejects(f.instance.pairDevice({ code: pairing.code, login: OWNER, label: "x" }), { code: "no-pairing-code" });
	});

	it("rejects an expired code", async () => {
		const f = await enabled();
		const { pairing } = await f.instance.startPairing();
		f.clock.now += 5 * 60 * 1000 + 1;
		await assert.rejects(f.instance.pairDevice({ code: pairing.code, login: OWNER, label: "x" }), { code: "pairing-code-expired" });
	});

	it("revokes a device and drops expired ones from the snapshot", async () => {
		const f = await enabled();
		for (const label of ["one", "two"]) {
			const { pairing } = await f.instance.startPairing();
			await f.instance.pairDevice({ code: pairing.code, login: OWNER, label });
		}
		const [first, second] = f.store.saved.devices;
		await f.instance.revokeDevice(first.id);
		assert.deepEqual(f.store.saved.devices.map((device: { label: string }) => device.label), ["two"]);
		await assert.rejects(f.instance.revokeDevice(first.id), { code: "unknown-device" });
		f.clock.now = second.expiresAt;
		assert.deepEqual(f.instance.snapshot().devices, []);
	});

	it("blocks every device at once when turned off", async () => {
		const f = await enabled();
		const { pairing } = await f.instance.startPairing();
		await f.instance.pairDevice({ code: pairing.code, login: OWNER, label: "x" });
		await f.instance.disable();
		assert.deepEqual(f.snapshots.at(-1), { enabled: false });
		assert.equal(f.store.saved.devices.length, 1, "devices stay paired for when it is turned on again");
	});
});

describe("Remote Access IPC", () => {
	it("renderer control accepts only whitelisted ops and well-formed device ids", async () => {
		const calls: string[] = [];
		const fake = new Proxy({}, { get: (_target, name) => async (...args: unknown[]) => { calls.push(`${String(name)}${args.length ? ` ${args.join(",")}` : ""}`); return { ok: true }; } });
		for (const op of ["status", "enable", "disable", "startPairing", "cancelPairing"]) await remoteAccessControl({ op }, fake);
		await remoteAccessControl({ op: "revokeDevice", deviceId: "8c1f6a0e-2b7d-4c1a-9e3f-1a2b3c4d5e6f" }, fake);
		assert.deepEqual(calls, ["status", "enable", "disable", "startPairing", "cancelPairing", "revokeDevice 8c1f6a0e-2b7d-4c1a-9e3f-1a2b3c4d5e6f"]);
		for (const command of [null, "enable", { op: "pairDevice" }, { op: "exec", command: "calc" }, { op: "revokeDevice", deviceId: "../../x" }, { op: "removeOnQuit" }]) {
			await assert.rejects(remoteAccessControl(command, fake));
		}
		assert.equal(calls.length, 6);
		assert.deepEqual(await remoteAccessControl({ op: "status" }, null), { available: false });
	});

	it("child channel answers snapshot/pair/seen, validates fields, and stops after the child exits", async () => {
		const f = build();
		await f.instance.enable();
		const child = Object.assign(new EventEmitter(), { connected: true, sent: [] as Record<string, unknown>[], send(packet: Record<string, unknown>, callback: () => void) { this.sent.push(packet); callback(); } });
		const link = attachRemoteAccessChild(child, f.instance);
		const ask = async (message: Record<string, unknown>) => {
			child.emit("message", { channel: "lh:remote-access", ...message });
			await new Promise((resolve) => setTimeout(resolve, 5));
			return child.sent.at(-1)!;
		};
		assert.deepEqual((await ask({ id: "1", op: "snapshot" })).value, f.instance.snapshot());
		assert.equal((await ask({ id: "2", op: "pair", code: "x".repeat(33), login: OWNER, label: "x" })).ok, false);
		assert.equal((await ask({ id: "3", op: "pair", code: "ABCD", login: OWNER, label: "bad\nlabel" })).ok, false);
		const { pairing } = await f.instance.startPairing();
		const paired = await ask({ id: "4", op: "pair", code: pairing.code, login: OWNER, label: "Safari on iPhone" });
		assert.equal(paired.ok, true);
		assert.equal(((paired.value as { token: string }).token).length, 43);
		assert.equal((await ask({ id: "5", op: "launch", path: "C:\\x" })).ok, false);
		link.sendSnapshot({ enabled: false });
		assert.deepEqual(child.sent.at(-1), { channel: "lh:remote-access", op: "changed", snapshot: { enabled: false } });
		child.emit("exit");
		const before = child.sent.length;
		child.emit("message", { channel: "lh:remote-access", id: "6", op: "snapshot" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(child.sent.length, before);
	});

	it("dev mode registers only the control channel, which reports Remote Access as unavailable", async () => {
		const handlers = new Map<string, (event: unknown, command: unknown) => unknown>();
		const app = new EventEmitter();
		const powerMonitor = new EventEmitter();
		const result = setUpRemoteAccess({
			electron: { app, ipcMain: { handle: (channel: string, handler: (event: unknown, command: unknown) => unknown) => handlers.set(channel, handler) }, BrowserWindow: { getAllWindows: () => [] }, powerMonitor },
			devMode: true, appURL: "http://localhost:3000", serverChild: null, userData: tmpdir(), log: () => {},
			isTrustedSender: (event: { trusted: boolean }) => event.trusted,
		});
		assert.equal(result, null);
		assert.deepEqual([...handlers.keys()], ["lh:remote-access:control"]);
		assert.equal(app.listenerCount("before-quit"), 0);
		assert.equal(powerMonitor.listenerCount("resume"), 0);
		assert.deepEqual(await handlers.get("lh:remote-access:control")!({ trusted: true }, { op: "status" }), { available: false });
		await assert.rejects(async () => handlers.get("lh:remote-access:control")!({ trusted: false }, { op: "status" }));
	});
});
