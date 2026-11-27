// Fork: Remote Access (docs/REMOTE_ACCESS_ARCHITECTURE.md).
// The server's copy of the Remote Access policy, pushed by the Electron main
// process over the inherited IPC pipe (like src/agent/subscription-bridge.ts).
// Kept on globalThis because the proxy bundle and the route bundles are
// separate module instances in the same Node process. No policy = closed.

export interface RemoteDevicePolicy {
	id: string;
	tokenHash: string;
	expiresAt: number;
}

export type RemoteAccessPolicy =
	| { enabled: false }
	| { enabled: true; dnsName: string; servePort: number; ownerLogin: string; devices: RemoteDevicePolicy[] };

interface PendingRequest {
	op: string;
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

interface PolicyState {
	policy: RemoteAccessPolicy | null;
	pending: Map<string, PendingRequest>;
	counter: number;
	snapshotRequest: Promise<RemoteAccessPolicy | null> | null;
}

const CHANNEL = "lh:remote-access";
const KEY = Symbol.for("lh.remoteAccess.policy");
const SNAPSHOT_TIMEOUT_MS = 3000;
const DNS_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_HASH = /^[0-9a-f]{64}$/;

export function desktopServerMode(env: Record<string, string | undefined> = process.env): boolean {
	return env.LH_DESKTOP_SERVER === "1" && (env.LH_DESKTOP_API_SECRET?.length ?? 0) >= 64;
}

function desktopIPCConnected(): boolean {
	return desktopServerMode() && typeof process.send === "function" && process.connected === true;
}

/** Anything not exactly the expected shape becomes "off". */
export function readRemoteAccessPolicy(raw: unknown): RemoteAccessPolicy {
	const value = raw as Partial<Extract<RemoteAccessPolicy, { enabled: true }>> | null;
	if (!value || value.enabled !== true) return { enabled: false };
	if (typeof value.dnsName !== "string" || !DNS_NAME.test(value.dnsName)) return { enabled: false };
	if (!Number.isInteger(value.servePort) || value.servePort! < 1 || value.servePort! > 65535) return { enabled: false };
	if (typeof value.ownerLogin !== "string" || !value.ownerLogin || value.ownerLogin.length > 320) return { enabled: false };
	if (!Array.isArray(value.devices)) return { enabled: false };
	const devices = value.devices.filter((device): device is RemoteDevicePolicy =>
		!!device && DEVICE_ID.test(device.id) && TOKEN_HASH.test(device.tokenHash) && Number.isSafeInteger(device.expiresAt));
	return { enabled: true, dnsName: value.dnsName, servePort: value.servePort!, ownerLogin: value.ownerLogin, devices };
}

function policyState(): PolicyState {
	const global = globalThis as typeof globalThis & { [KEY]?: PolicyState };
	if (!global[KEY]) {
		const state: PolicyState = { policy: null, pending: new Map(), counter: 0, snapshotRequest: null };
		global[KEY] = state;
		process.on("message", (raw: unknown) => {
			const message = raw as { channel?: string; op?: string; id?: string; ok?: boolean; value?: unknown; error?: { code?: string; message?: string }; snapshot?: unknown };
			if (!desktopIPCConnected() || message?.channel !== CHANNEL) return;
			if (message.op === "changed") { state.policy = readRemoteAccessPolicy(message.snapshot); return; }
			if (!message.id) return;
			const pending = state.pending.get(message.id);
			if (!pending || pending.op !== message.op) return;
			clearTimeout(pending.timer);
			state.pending.delete(message.id);
			if (message.ok) pending.resolve(message.value);
			else pending.reject(Object.assign(new Error(message.error?.message ?? "Remote Access failed."), { code: message.error?.code ?? "failed" }));
		});
		process.on("disconnect", () => {
			state.policy = { enabled: false };
			for (const pending of state.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("The desktop connection closed.")); }
			state.pending.clear();
		});
	}
	return global[KEY]!;
}

// Listen as soon as any gate module loads, so the first pushed snapshot is not missed.
if (desktopIPCConnected()) policyState();

/** Sends one request to the Electron main process and waits for its answer. */
export function remoteAccessRequest<T>(op: "snapshot" | "pair" | "seen", fields: Record<string, unknown> = {}, timeoutMs = 10000): Promise<T> {
	const state = policyState();
	if (!desktopIPCConnected()) return Promise.reject(new Error("Remote Access needs the desktop app."));
	return new Promise<T>((resolve, reject) => {
		const id = `${process.pid}:${++state.counter}`;
		const timer = setTimeout(() => { state.pending.delete(id); reject(new Error("The desktop app did not answer.")); }, timeoutMs);
		state.pending.set(id, { op, timer, resolve: (value) => resolve(value as T), reject });
		process.send!({ ...fields, channel: CHANNEL, id, op }, (error: Error | null) => {
			if (error) { clearTimeout(timer); state.pending.delete(id); reject(new Error("The desktop connection closed.")); }
		});
	});
}

/** The policy now, without waiting. Null until main has answered once. */
export function currentRemoteAccessPolicy(): RemoteAccessPolicy | null {
	return policyState().policy;
}

/** The proxy calls this before checking a remote request, so the first one is not refused for lack of a snapshot. */
export async function loadRemoteAccessPolicy(): Promise<RemoteAccessPolicy | null> {
	const state = policyState();
	if (state.policy) return state.policy;
	if (!desktopIPCConnected()) return null;
	state.snapshotRequest ??= remoteAccessRequest<unknown>("snapshot", {}, SNAPSHOT_TIMEOUT_MS)
		.then((raw) => { state.policy ??= readRemoteAccessPolicy(raw); return state.policy; })
		.catch(() => null)
		.finally(() => { state.snapshotRequest = null; });
	return state.snapshotRequest;
}

// Listen and ask for the policy as soon as any gate module loads, so the
// synchronous proxy normally has it before the first phone request.
if (desktopIPCConnected()) void loadRemoteAccessPolicy();

/** Tests only: replace the policy without an IPC pipe. */
export function setRemoteAccessPolicyForTests(policy: RemoteAccessPolicy | null): void {
	policyState().policy = policy;
}
