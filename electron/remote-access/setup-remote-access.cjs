"use strict";
// Fork: Remote Access. Everything main.cjs needs, behind one call, so the
// upstream file only gains a require and a single setUpRemoteAccess(...) line.
const path = require("node:path");
const { createRemoteAccess } = require("./remote-access-manager.cjs");
const { remoteAccessStore } = require("./remote-access-store.cjs");
const { CONTROL_CHANNEL, CHANGED_CHANNEL, remoteAccessControl, attachRemoteAccessChild, publicError } = require("./remote-access-ipc.cjs");

/**
 * @param options.devMode       true for LH_DEV_URL: no server child, Remote Access unavailable
 * @param options.appURL        the app window's URL (http://127.0.0.1:<port>)
 * @param options.serverChild   the spawned Next server (null in dev mode)
 * @param options.isTrustedSender (event) => boolean   main.cjs's existing window check
 */
function setUpRemoteAccess({ electron, devMode, appURL, serverChild, userData, isTrustedSender, log }) {
	const { app, ipcMain, BrowserWindow, powerMonitor } = electron;
	let manager = null;
	let childLink = null;

	if (!devMode && serverChild) {
		const serverPort = Number(new URL(appURL).port);
		manager = createRemoteAccess({
			store: remoteAccessStore(path.join(userData, "remote-access.json")),
			getServerPort: () => (serverChild.exitCode === null && serverChild.signalCode === null ? serverPort : null),
			onSnapshot: (snapshot) => childLink?.sendSnapshot(snapshot),
			onChange: () => { for (const win of BrowserWindow.getAllWindows()) win.webContents.send(CHANGED_CHANNEL); },
			log,
		});
		childLink = attachRemoteAccessChild(serverChild, manager);
		manager.reconcile().catch((error) => log(`remote access: startup check failed: ${error.message}`));
		powerMonitor.on("resume", () => {
			manager.reconcile().catch((error) => log(`remote access: wake-up check failed: ${error.message}`));
		});
		app.on("before-quit", () => manager.removeOnQuit());
		process.on("exit", () => manager.removeOnQuit());
	}

	ipcMain.handle(CONTROL_CHANNEL, async (event, command) => {
		if (!isTrustedSender(event)) throw new Error("Untrusted desktop request.");
		if (!manager) return { available: false };
		try {
			return await remoteAccessControl(command, manager);
		} catch (error) {
			return { ...(await manager.status()), actionError: publicError(error) };
		}
	});

	return manager;
}

module.exports = { setUpRemoteAccess };
