"use strict";
// Fork: Remote Access (see docs/REMOTE_ACCESS_ARCHITECTURE.md).
// The only code that runs the Tailscale CLI. Every call uses a fixed argument
// array built here; nothing from the renderer or the server reaches argv.
const { execFile, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SERVE_HTTPS_PORT = 8443;
const COMMAND_TIMEOUT_MS = 15000;
const QUIT_TIMEOUT_MS = 3000;

/** Fixed install locations first, PATH last: a PATH entry is easier to plant. */
function tailscaleExecutableCandidates(platform = process.platform, env = process.env) {
	const fixed = {
		win32: [
			env.ProgramFiles && path.win32.join(env.ProgramFiles, "Tailscale", "tailscale.exe"),
			"C:\\Program Files\\Tailscale\\tailscale.exe",
		],
		darwin: [
			"/Applications/Tailscale.app/Contents/MacOS/Tailscale",
			"/usr/local/bin/tailscale",
			"/opt/homebrew/bin/tailscale",
		],
		linux: ["/usr/bin/tailscale", "/usr/local/bin/tailscale"],
	}[platform] ?? ["/usr/bin/tailscale", "/usr/local/bin/tailscale"];
	const pathModule = platform === "win32" ? path.win32 : path.posix;
	const executableName = platform === "win32" ? "tailscale.exe" : "tailscale";
	const fromPath = (env.PATH ?? env.Path ?? "")
		.split(platform === "win32" ? ";" : ":")
		.filter((directory) => directory && pathModule.isAbsolute(directory))
		.map((directory) => pathModule.join(directory, executableName));
	return [...new Set([...fixed.filter(Boolean), ...fromPath])];
}

function findTailscaleExecutable({ platform = process.platform, env = process.env, isFile = defaultIsFile } = {}) {
	return tailscaleExecutableCandidates(platform, env).find((candidate) => isFile(candidate)) ?? null;
}

function defaultIsFile(candidate) {
	try { return fs.statSync(candidate).isFile(); } catch { return false; }
}

class TailscaleCommandError extends Error {
	constructor(message, { stderr = "", timedOut = false } = {}) {
		super(message);
		this.code = "tailscale-command-failed";
		this.stderr = String(stderr).slice(0, 2000);
		this.timedOut = timedOut;
	}
}

/** Runs one CLI call. `execFileImpl` is replaced in tests so no tailnet is needed. */
function createTailscaleRunner(executable, { execFileImpl = execFile, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
	return function runTailscale(args) {
		return new Promise((resolve, reject) => {
			execFileImpl(executable, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
				if (error) {
					reject(new TailscaleCommandError(`tailscale ${args[0]} failed`, { stderr: stderr || error.message, timedOut: error.killed === true }));
					return;
				}
				resolve({ stdout: String(stdout), stderr: String(stderr) });
			});
		});
	};
}

function checkServerPort(serverPort) {
	if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) throw new Error("invalid server port");
	return serverPort;
}

function parseJSONOutput(stdout) {
	const text = String(stdout).trim();
	return text ? JSON.parse(text) : {};
}

/** The parts of `tailscale status --json` Remote Access needs. */
function readTailscaleStatusFromJSON(status) {
	const self = status?.Self ?? {};
	const dnsName = typeof self.DNSName === "string" ? self.DNSName.replace(/\.$/, "").toLowerCase() : "";
	const owner = status?.User?.[String(self.UserID)];
	const certDomains = Array.isArray(status?.CertDomains) ? status.CertDomains.map((domain) => String(domain).toLowerCase()) : [];
	return {
		backendState: typeof status?.BackendState === "string" ? status.BackendState : "Unknown",
		dnsName,
		ownerLogin: typeof owner?.LoginName === "string" ? owner.LoginName : "",
		httpsCertsEnabled: !!dnsName && certDomains.includes(dnsName),
		taggedDevice: Array.isArray(self.Tags) && self.Tags.length > 0,
	};
}

function createTailscaleCommands(runTailscale) {
	return {
		async readStatus() {
			const { stdout } = await runTailscale(["status", "--json"]);
			return readTailscaleStatusFromJSON(parseJSONOutput(stdout));
		},
		async readServeConfig() {
			const { stdout } = await runTailscale(["serve", "status", "--json"]);
			return parseJSONOutput(stdout);
		},
		async addServeEntry(serverPort) {
			checkServerPort(serverPort);
			await runTailscale(["serve", "--bg", `--https=${SERVE_HTTPS_PORT}`, `http://127.0.0.1:${serverPort}`]);
		},
		async removeServeEntry() {
			await runTailscale(["serve", `--https=${SERVE_HTTPS_PORT}`, "off"]);
		},
	};
}

/** Used only while the app quits, when nothing async can be awaited. */
function removeServeEntrySync(executable, { execFileSyncImpl = execFileSync } = {}) {
	execFileSyncImpl(executable, ["serve", `--https=${SERVE_HTTPS_PORT}`, "off"], { timeout: QUIT_TIMEOUT_MS, windowsHide: true, stdio: "ignore" });
}

module.exports = {
	SERVE_HTTPS_PORT,
	TailscaleCommandError,
	tailscaleExecutableCandidates,
	findTailscaleExecutable,
	createTailscaleRunner,
	createTailscaleCommands,
	readTailscaleStatusFromJSON,
	removeServeEntrySync,
};
