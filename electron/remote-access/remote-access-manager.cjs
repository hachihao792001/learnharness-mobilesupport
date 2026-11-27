"use strict";
// Fork: Remote Access. Owns the on/off state, the one Tailscale Serve entry on
// :8443, pairing codes and paired devices. The Next server only ever gets a
// snapshot (token hashes, never tokens) and asks here to pair a device.
const https = require("node:https");
const { createHash, randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const { SERVE_HTTPS_PORT, findTailscaleExecutable, createTailscaleRunner, createTailscaleCommands, removeServeEntrySync } = require("./tailscale-cli.cjs");
const { describeServePort } = require("./serve-config.cjs");
const { MAX_DEVICES, emptyState } = require("./remote-access-store.cjs");

const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1
const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_LIFETIME_MS = 5 * 60 * 1000;
const PAIRING_MAX_WRONG_TRIES = 5;
const DEVICE_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const DEVICE_SEEN_SAVE_INTERVAL_MS = 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 8000;
const REMOTE_GATE_HEADER = "x-learnharness-remote";

const MESSAGES = {
	"server-not-running": "The LearnHarness server is not running.",
	"tailscale-missing": "Tailscale is not installed. Install it from tailscale.com and sign in.",
	"tailscale-not-running": "Tailscale is not connected. Open Tailscale and sign in.",
	"tailscale-tagged": "This PC is a tagged Tailscale device. Tailscale does not send user identity for tagged devices, so Remote Access cannot check who is connecting.",
	"https-certs-off": "HTTPS certificates are off for your tailnet. Turn on MagicDNS and HTTPS Certificates on the DNS page of the Tailscale admin console.",
	"owner-unknown": "Could not read the Tailscale login of this PC.",
	"serve-port-conflict": `Port ${SERVE_HTTPS_PORT} in Tailscale Serve is already used by something else. LearnHarness did not change it.`,
	"serve-command-failed": "Tailscale could not change the Serve settings.",
	"serve-verify-failed": "Tailscale Serve did not keep the LearnHarness setting.",
	"storage": "Could not read or save the Remote Access settings file.",
	"probe-failed": "Serve is set up, but this PC could not open the remote address to check it. Try it from your phone.",
	"not-enabled": "Remote Access is off.",
	"no-pairing-code": "There is no pairing code right now. Create a new one on the desktop.",
	"pairing-code-expired": "This pairing code has expired. Create a new one on the desktop.",
	"pairing-code-wrong": "That pairing code is not right.",
	"pairing-code-locked": "Too many wrong codes. Create a new one on the desktop.",
	"pairing-wrong-login": "This Tailscale account is not allowed to use this LearnHarness.",
	"too-many-devices": `You can pair at most ${MAX_DEVICES} devices. Remove one first.`,
	"unknown-device": "That device is not paired.",
};

function remoteAccessError(code, detail) {
	return Object.assign(new Error(MESSAGES[code] ?? code), { code, detail });
}

function hashDeviceToken(token) {
	return createHash("sha256").update(token).digest("hex");
}

function createPairingCode(randomBytesImpl = randomBytes) {
	// 32 letters: a byte & 31 picks each one with equal chance.
	return [...randomBytesImpl(PAIRING_CODE_LENGTH)].map((byte) => PAIRING_CODE_ALPHABET[byte & 31]).join("");
}

function normalizePairingCode(code) {
	return typeof code === "string" ? code.toUpperCase().replace(/[\s-]/g, "") : "";
}

function pairingCodeMatches(supplied, expected) {
	const actual = Buffer.from(normalizePairingCode(supplied));
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/** Asks the remote URL from this PC; the gate marks every response it handles. */
function probeRemoteURL(url, { requestImpl = https.request, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
	return new Promise((resolve) => {
		try {
			const request = requestImpl(url, { method: "GET", timeout: timeoutMs }, (response) => {
				response.resume();
				resolve(response.headers[REMOTE_GATE_HEADER] === "gate");
			});
			request.on("timeout", () => request.destroy());
			request.on("error", () => resolve(false));
			request.end();
		} catch { resolve(false); }
	});
}

/**
 * @param options.store         remoteAccessStore(...)
 * @param options.getServerPort () => the running server's loopback port, or null
 * @param options.onSnapshot    (snapshot) => void   pushes policy to the server
 * @param options.onChange      () => void           tells desktop windows to refresh
 */
function createRemoteAccess({
	store,
	getServerPort,
	onSnapshot = () => {},
	onChange = () => {},
	log = () => {},
	now = Date.now,
	findExecutable = () => findTailscaleExecutable(),
	makeCommands = (executable) => createTailscaleCommands(createTailscaleRunner(executable)),
	removeEntrySync = removeServeEntrySync,
	probe = probeRemoteURL,
	randomBytesImpl = randomBytes,
}) {
	let saved = emptyState();
	let phase = "off"; // off | starting | on | error
	let lastError = null;
	let warning = null;
	let identity = null; // { dnsName, ownerLogin }
	let pairing = null; // { code, expiresAt, wrongTries }
	let executable = null;
	let queue = Promise.resolve();
	let seenSaveTimer = null;

	const ready = (async () => {
		try { saved = await store.read(); }
		catch (error) { log(`remote access: ${error.message}`); lastError = remoteAccessError("storage"); phase = "error"; }
		saved.devices = saved.devices.filter((device) => device.expiresAt > now());
	})();

	function serialize(task) {
		const run = queue.then(() => ready).then(task);
		queue = run.catch(() => {});
		return run;
	}

	async function save() {
		saved.devices = saved.devices.filter((device) => device.expiresAt > now());
		await store.write(saved);
	}

	function remoteURL() {
		return identity ? `https://${identity.dnsName}:${SERVE_HTTPS_PORT}` : null;
	}

	function snapshot() {
		if (!saved.enabled || phase !== "on" || !identity) return { enabled: false };
		return {
			enabled: true,
			dnsName: identity.dnsName,
			servePort: SERVE_HTTPS_PORT,
			ownerLogin: identity.ownerLogin,
			devices: saved.devices.filter((device) => device.expiresAt > now()).map(({ id, tokenHash, expiresAt }) => ({ id, tokenHash, expiresAt })),
		};
	}

	function publish() {
		try { onSnapshot(snapshot()); } catch (error) { log(`remote access: snapshot push failed: ${error.message}`); }
		try { onChange(); } catch { /* a window may be gone */ }
	}

	function fail(error) {
		phase = "error";
		lastError = error.code && MESSAGES[error.code] ? error : remoteAccessError("serve-command-failed", error.stderr);
		log(`remote access: ${lastError.code}${lastError.detail ? ` (${String(lastError.detail).split("\n")[0]})` : ""}`);
	}

	async function loadTailscale() {
		executable = findExecutable();
		if (!executable) throw remoteAccessError("tailscale-missing");
		const commands = makeCommands(executable);
		let status;
		try { status = await commands.readStatus(); }
		catch (error) { throw remoteAccessError("tailscale-not-running", error.stderr); }
		if (status.backendState !== "Running" || !status.dnsName) throw remoteAccessError("tailscale-not-running");
		if (status.taggedDevice) throw remoteAccessError("tailscale-tagged");
		if (!status.httpsCertsEnabled) throw remoteAccessError("https-certs-off");
		if (!status.ownerLogin) throw remoteAccessError("owner-unknown");
		return { commands, status };
	}

	async function addServeEntryForServer() {
		const serverPort = getServerPort();
		if (!serverPort) throw remoteAccessError("server-not-running");
		const { commands, status } = await loadTailscale();
		const current = describeServePort(await commands.readServeConfig(), status.dnsName, SERVE_HTTPS_PORT);
		if (current.kind === "other" || (current.kind === "loopback-proxy" && !saved.serveEntryOwned)) {
			throw remoteAccessError("serve-port-conflict", current.reason ?? "points at a local port LearnHarness did not set");
		}
		if (current.kind !== "loopback-proxy" || current.serverPort !== serverPort) {
			// Mark ownership before touching Serve, so a crash in between still
			// lets the next launch recognise and clean up this entry.
			if (!saved.serveEntryOwned) { saved.serveEntryOwned = true; await save(); }
			if (current.kind === "loopback-proxy") await commands.removeServeEntry();
			await commands.addServeEntry(serverPort);
		}
		const after = describeServePort(await commands.readServeConfig(), status.dnsName, SERVE_HTTPS_PORT);
		if (after.kind !== "loopback-proxy" || after.serverPort !== serverPort) throw remoteAccessError("serve-verify-failed");
		identity = { dnsName: status.dnsName, ownerLogin: status.ownerLogin };
	}

	async function removeOwnedServeEntry() {
		if (!saved.serveEntryOwned) return;
		executable = executable ?? findExecutable();
		if (!executable) throw remoteAccessError("tailscale-missing");
		const commands = makeCommands(executable);
		const status = await commands.readStatus();
		const current = describeServePort(await commands.readServeConfig(), status.dnsName, SERVE_HTTPS_PORT);
		if (current.kind === "loopback-proxy") {
			await commands.removeServeEntry();
			const after = describeServePort(await commands.readServeConfig(), status.dnsName, SERVE_HTTPS_PORT);
			if (after.kind === "loopback-proxy") throw remoteAccessError("serve-verify-failed");
		}
		// "other": someone else changed the port since; it is no longer ours.
		saved.serveEntryOwned = false;
		await save();
	}

	async function turnOn() {
		phase = "starting"; lastError = null; warning = null;
		publish();
		try {
			await addServeEntryForServer();
			phase = "on";
			log(`remote access: on at ${remoteURL()}`);
		} catch (error) {
			fail(error);
		}
		publish();
		if (phase === "on") {
			const reachable = await probe(`${remoteURL()}/remote/pair`);
			warning = reachable ? null : remoteAccessError("probe-failed");
			if (!reachable) log("remote access: probe of the remote URL failed");
			try { onChange(); } catch { /* a window may be gone */ }
		}
	}

	async function turnOff() {
		saved.enabled = false;
		phase = "off"; lastError = null; warning = null; pairing = null;
		await save();
		publish();
		try { await removeOwnedServeEntry(); }
		catch (error) { fail(error); publish(); }
	}

	function publicStatus() {
		return {
			available: true,
			enabled: saved.enabled,
			state: phase,
			url: phase === "on" ? remoteURL() : null,
			ownerLogin: identity?.ownerLogin ?? null,
			error: lastError ? { code: lastError.code, message: lastError.message } : null,
			warning: warning ? { code: warning.code, message: warning.message } : null,
			pairing: pairing && pairing.expiresAt > now() ? { code: pairing.code, expiresAt: pairing.expiresAt } : null,
			devices: saved.devices
				.filter((device) => device.expiresAt > now())
				.map(({ id, label, createdAt, expiresAt, lastSeenAt }) => ({ id, label, createdAt, expiresAt, lastSeenAt })),
		};
	}

	return {
		ready,
		snapshot,
		status: () => serialize(async () => publicStatus()),
		enable: () => serialize(async () => {
			if (!saved.enabled) { saved.enabled = true; await save(); }
			await turnOn();
			return publicStatus();
		}),
		disable: () => serialize(async () => { await turnOff(); return publicStatus(); }),
		/** App start, and after the PC wakes up: bring Serve back in line with the setting. */
		reconcile: () => serialize(async () => {
			if (saved.enabled) await turnOn();
			else if (saved.serveEntryOwned) {
				try { await removeOwnedServeEntry(); } catch (error) { fail(error); }
				publish();
			}
			return publicStatus();
		}),
		startPairing: () => serialize(async () => {
			if (!saved.enabled || phase !== "on") throw remoteAccessError("not-enabled");
			pairing = { code: createPairingCode(randomBytesImpl), expiresAt: now() + PAIRING_CODE_LIFETIME_MS, wrongTries: 0 };
			try { onChange(); } catch { /* a window may be gone */ }
			return publicStatus();
		}),
		cancelPairing: () => serialize(async () => { pairing = null; try { onChange(); } catch { /* a window may be gone */ } return publicStatus(); }),
		revokeDevice: (deviceId) => serialize(async () => {
			const before = saved.devices.length;
			saved.devices = saved.devices.filter((device) => device.id !== deviceId);
			if (saved.devices.length === before) throw remoteAccessError("unknown-device");
			await save();
			publish();
			return publicStatus();
		}),
		/** From the server's pair route. Returns the token once; only its hash is kept. */
		pairDevice: ({ code, login, label }) => serialize(async () => {
			if (!saved.enabled || phase !== "on" || !identity) throw remoteAccessError("not-enabled");
			if (login.toLowerCase() !== identity.ownerLogin.toLowerCase()) throw remoteAccessError("pairing-wrong-login");
			if (!pairing) throw remoteAccessError("no-pairing-code");
			if (pairing.expiresAt <= now()) { pairing = null; throw remoteAccessError("pairing-code-expired"); }
			if (!pairingCodeMatches(code, pairing.code)) {
				pairing.wrongTries += 1;
				if (pairing.wrongTries >= PAIRING_MAX_WRONG_TRIES) { pairing = null; try { onChange(); } catch { /* window gone */ } throw remoteAccessError("pairing-code-locked"); }
				throw remoteAccessError("pairing-code-wrong");
			}
			pairing = null;
			saved.devices = saved.devices.filter((device) => device.expiresAt > now());
			if (saved.devices.length >= MAX_DEVICES) throw remoteAccessError("too-many-devices");
			const token = randomBytesImpl(32).toString("base64url");
			const createdAt = now();
			const device = { id: randomUUID(), label, login, createdAt, expiresAt: createdAt + DEVICE_LIFETIME_MS, lastSeenAt: createdAt, tokenHash: hashDeviceToken(token) };
			saved.devices.push(device);
			await save();
			publish();
			log(`remote access: paired device ${device.id} (${label})`);
			return { deviceId: device.id, token, expiresAt: device.expiresAt };
		}),
		/** Throttled: a device in use updates its "last seen" at most once an hour. */
		markDeviceSeen(deviceId) {
			const device = saved.devices.find((entry) => entry.id === deviceId);
			if (!device || now() - device.lastSeenAt < DEVICE_SEEN_SAVE_INTERVAL_MS) return;
			device.lastSeenAt = now();
			if (seenSaveTimer) return;
			seenSaveTimer = setTimeout(() => {
				seenSaveTimer = null;
				serialize(save).then(() => { try { onChange(); } catch { /* window gone */ } }, (error) => log(`remote access: ${error.message}`));
			}, 1000);
			seenSaveTimer.unref?.();
		},
		/** Synchronous: runs from before-quit, where async work never finishes. */
		removeOnQuit() {
			if (!saved.serveEntryOwned) return;
			const quitExecutable = executable ?? findExecutable();
			try {
				if (quitExecutable) removeEntrySync(quitExecutable);
				saved.serveEntryOwned = false;
				store.writeSync(saved);
				log("remote access: removed the Serve entry on quit");
			} catch (error) {
				log(`remote access: could not remove the Serve entry on quit: ${error.message}`);
			}
		},
	};
}

module.exports = {
	PAIRING_CODE_ALPHABET,
	PAIRING_CODE_LENGTH,
	PAIRING_CODE_LIFETIME_MS,
	PAIRING_MAX_WRONG_TRIES,
	DEVICE_LIFETIME_MS,
	REMOTE_GATE_HEADER,
	MESSAGES,
	createRemoteAccess,
	createPairingCode,
	normalizePairingCode,
	pairingCodeMatches,
	hashDeviceToken,
	probeRemoteURL,
	remoteAccessError,
};
