"use strict";
// Fork: Remote Access. userData/remote-access.json, main process only.
// Written like subscription-store.cjs: temp file (0600) → fsync → rename.
// Devices keep only a SHA-256 of their pairing token, never the token.
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const STORE_VERSION = 1;
const MAX_DEVICES = 20;
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_HASH = /^[0-9a-f]{64}$/;

function emptyState() {
	return { version: STORE_VERSION, enabled: false, serveEntryOwned: false, devices: [] };
}

function storageError() {
	return Object.assign(new Error("storage"), { code: "storage" });
}

const isTime = (value) => Number.isSafeInteger(value) && value >= 0;
const isShortText = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

function validateDevice(device) {
	if (!device || !DEVICE_ID.test(device.id) || !TOKEN_HASH.test(device.tokenHash)) throw storageError();
	if (!isShortText(device.label, 120) || !isShortText(device.login, 320)) throw storageError();
	if (![device.createdAt, device.expiresAt, device.lastSeenAt].every(isTime) || device.expiresAt <= device.createdAt) throw storageError();
	return device;
}

function validateState(state) {
	if (!state || state.version !== STORE_VERSION || typeof state.enabled !== "boolean" || typeof state.serveEntryOwned !== "boolean") throw storageError();
	if (!Array.isArray(state.devices) || state.devices.length > MAX_DEVICES) throw storageError();
	state.devices.forEach(validateDevice);
	return state;
}

function serializeState(state) {
	return `${JSON.stringify(validateState(state), null, "\t")}\n`;
}

/** A corrupt file is reported, never silently replaced: the user decides. */
function remoteAccessStore(file, io = fsPromises, syncIO = fs) {
	return {
		file,
		async read() {
			try {
				const stat = await io.lstat(file);
				if (!stat.isFile() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())))) throw storageError();
				return validateState(JSON.parse(await io.readFile(file, "utf8")));
			} catch (error) {
				if (error.code === "ENOENT") return emptyState();
				throw storageError();
			}
		},
		async write(state) {
			const text = serializeState(state);
			const temporary = `${file}.${randomUUID()}.tmp`;
			let handle;
			try {
				await io.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
				handle = await io.open(temporary, "wx", 0o600);
				await handle.writeFile(text);
				await handle.sync(); await handle.close(); handle = null;
				await io.rename(temporary, file);
			} catch { throw storageError(); }
			finally { await handle?.close().catch(() => {}); await io.unlink(temporary).catch(() => {}); }
		},
		/** Only for app quit, where nothing async can finish. */
		writeSync(state) {
			const text = serializeState(state);
			const temporary = `${file}.${randomUUID()}.tmp`;
			try {
				syncIO.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
				syncIO.writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
				syncIO.renameSync(temporary, file);
			} catch {
				try { syncIO.unlinkSync(temporary); } catch { /* not created */ }
				throw storageError();
			}
		},
	};
}

module.exports = { STORE_VERSION, MAX_DEVICES, DEVICE_ID, emptyState, validateState, validateDevice, remoteAccessStore };
