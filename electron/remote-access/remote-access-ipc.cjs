"use strict";
// Fork: Remote Access. Two narrow channels, same style as subscription-ipc.cjs:
//   renderer → main  "lh:remote-access:control"  (trusted desktop window only)
//   server  ↔ main   "lh:remote-access"          (the inherited child IPC pipe)
// Neither channel can name a command, executable, port or path.
const { DEVICE_ID } = require("./remote-access-store.cjs");

const CHANNEL = "lh:remote-access";
const CONTROL_CHANNEL = "lh:remote-access:control";
const CHANGED_CHANNEL = "lh:remote-access:changed";

const isShortText = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

function publicError(error) {
	return { code: typeof error?.code === "string" ? error.code : "failed", message: typeof error?.message === "string" && error.code ? error.message : "Remote Access failed." };
}

/** Caller has already checked the sender is the trusted desktop window. */
async function remoteAccessControl(command, manager) {
	if (!manager) return { available: false };
	if (!command || typeof command !== "object") throw new Error("Invalid Remote Access request.");
	switch (command.op) {
		case "status": return manager.status();
		case "enable": return manager.enable();
		case "disable": return manager.disable();
		case "startPairing": return manager.startPairing();
		case "cancelPairing": return manager.cancelPairing();
		case "revokeDevice":
			if (typeof command.deviceId !== "string" || !DEVICE_ID.test(command.deviceId)) throw new Error("Invalid device.");
			return manager.revokeDevice(command.deviceId);
		default: throw new Error("Invalid Remote Access request.");
	}
}

/** Wires the server child's IPC pipe to the manager. Disposes itself when the child exits. */
function attachRemoteAccessChild(child, manager) {
	let disposed = false;
	const send = (packet) => { if (!disposed && child.connected) { try { child.send(packet, () => {}); } catch { /* child exited */ } } };
	const reply = (message, result) => send({ channel: CHANNEL, id: message.id, op: message.op, ...result });
	const listener = async (message) => {
		if (disposed || !child.connected || message?.channel !== CHANNEL || typeof message.id !== "string" || message.id.length > 64) return;
		try {
			switch (message.op) {
				case "snapshot":
					await manager.ready;
					reply(message, { ok: true, value: manager.snapshot() });
					return;
				case "pair": {
					if (!isShortText(message.code, 32) || !isShortText(message.login, 320) || !isShortText(message.label, 120)) throw new Error("Invalid pairing request.");
					const value = await manager.pairDevice({ code: message.code, login: message.login, label: message.label });
					reply(message, { ok: true, value });
					return;
				}
				case "seen":
					if (typeof message.deviceId === "string" && DEVICE_ID.test(message.deviceId)) manager.markDeviceSeen(message.deviceId);
					reply(message, { ok: true, value: null });
					return;
				default:
					throw new Error("Invalid Remote Access request.");
			}
		} catch (error) {
			reply(message, { ok: false, error: publicError(error) });
		}
	};
	const dispose = () => { disposed = true; child.removeListener("message", listener); };
	child.on("message", listener);
	child.once?.("exit", dispose);
	return {
		sendSnapshot(snapshot) { send({ channel: CHANNEL, op: "changed", snapshot }); },
		dispose,
	};
}

module.exports = { CHANNEL, CONTROL_CHANNEL, CHANGED_CHANNEL, remoteAccessControl, attachRemoteAccessChild, publicError };
