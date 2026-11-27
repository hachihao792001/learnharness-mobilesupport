// Fork: Remote Access — Tailscale CLI wrapper and Serve config reader. No tailnet needed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cli = require("../electron/remote-access/tailscale-cli.cjs");
const { describeServePort } = require("../electron/remote-access/serve-config.cjs");

const DNS = "company-cpu.tail14bb89.ts.net";

describe("finding the Tailscale executable", () => {
	it("tries fixed install locations before PATH entries, and ignores relative PATH entries", () => {
		const candidates: string[] = cli.tailscaleExecutableCandidates("win32", { ProgramFiles: "C:\\Program Files", PATH: "relative\\bin;D:\\tools\\ts" });
		assert.equal(candidates[0], "C:\\Program Files\\Tailscale\\tailscale.exe");
		assert.equal(candidates.at(-1), "D:\\tools\\ts\\tailscale.exe");
		assert(!candidates.some((candidate) => candidate.startsWith("relative")));
		const mac: string[] = cli.tailscaleExecutableCandidates("darwin", { PATH: "/opt/x" });
		assert.equal(mac[0], "/Applications/Tailscale.app/Contents/MacOS/Tailscale");
		assert.equal(mac.at(-1), "/opt/x/tailscale");
	});

	it("returns the first candidate that is a file, or null", () => {
		const found = cli.findTailscaleExecutable({ platform: "linux", env: { PATH: "/a:/b" }, isFile: (file: string) => file === "/b/tailscale" });
		assert.equal(found, "/b/tailscale");
		assert.equal(cli.findTailscaleExecutable({ platform: "linux", env: {}, isFile: () => false }), null);
	});
});

describe("Tailscale commands", () => {
	function recordingRunner(outputs: Record<string, string> = {}) {
		const calls: { file: string; args: string[]; options: Record<string, unknown> }[] = [];
		const execFileImpl = (file: string, args: string[], options: Record<string, unknown>, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
			calls.push({ file, args, options });
			const key = args.join(" ");
			if (key in outputs) callback(null, outputs[key]!, "");
			else callback(Object.assign(new Error("exit 1"), { killed: false }), "", "boom: not allowed");
		};
		return { calls, run: cli.createTailscaleRunner("C:\\ts.exe", { execFileImpl, timeoutMs: 1234 }) };
	}

	it("uses only fixed argument arrays with a timeout and a hidden window", async () => {
		const { calls, run } = recordingRunner({ "serve --bg --https=8443 http://127.0.0.1:50123": "", "serve --https=8443 off": "" });
		const commands = cli.createTailscaleCommands(run);
		await commands.addServeEntry(50123);
		await commands.removeServeEntry();
		assert.deepEqual(calls.map((call) => call.args), [["serve", "--bg", "--https=8443", "http://127.0.0.1:50123"], ["serve", "--https=8443", "off"]]);
		for (const call of calls) {
			assert.equal(call.file, "C:\\ts.exe");
			assert.equal(call.options.timeout, 1234);
			assert.equal(call.options.windowsHide, true);
		}
	});

	it("refuses a server port that is not a plain port number", async () => {
		const { calls, run } = recordingRunner();
		const commands = cli.createTailscaleCommands(run);
		for (const port of [0, 70000, 3.5, "3000", "3000 --funnel"]) await assert.rejects(commands.addServeEntry(port));
		assert.equal(calls.length, 0);
	});

	it("reports a failed command with its stderr, cut short", async () => {
		const { run } = recordingRunner();
		await assert.rejects(run(["status", "--json"]), (error: { code: string; stderr: string }) => error.code === "tailscale-command-failed" && error.stderr.includes("not allowed"));
	});

	it("reads owner login, DNS name, HTTPS certs and tags from status JSON", async () => {
		const status = {
			BackendState: "Running",
			Self: { DNSName: `${DNS.toUpperCase()}.`, UserID: 42 },
			User: { "42": { LoginName: "owner@example.com" } },
			CertDomains: [DNS],
		};
		const { run } = recordingRunner({ "status --json": JSON.stringify(status) });
		assert.deepEqual(await cli.createTailscaleCommands(run).readStatus(), {
			backendState: "Running", dnsName: DNS, ownerLogin: "owner@example.com", httpsCertsEnabled: true, taggedDevice: false,
		});
		assert.equal(cli.readTailscaleStatusFromJSON({ ...status, CertDomains: [] }).httpsCertsEnabled, false);
		assert.equal(cli.readTailscaleStatusFromJSON({ ...status, Self: { ...status.Self, Tags: ["tag:server"] } }).taggedDevice, true);
		assert.equal(cli.readTailscaleStatusFromJSON({}).backendState, "Unknown");
	});

	it("reads an empty serve status as an empty config", async () => {
		const { run } = recordingRunner({ "serve status --json": "{}\n" });
		assert.deepEqual(await cli.createTailscaleCommands(run).readServeConfig(), {});
	});

	it("removes the entry synchronously on quit with only the :8443 off arguments", () => {
		const calls: unknown[][] = [];
		cli.removeServeEntrySync("ts", { execFileSyncImpl: (...args: unknown[]) => { calls.push(args); } });
		assert.deepEqual(calls[0]![1], ["serve", "--https=8443", "off"]);
		assert.equal((calls[0]![2] as { timeout: number }).timeout, 3000);
	});
});

describe("reading the Serve config for port 8443", () => {
	const proxyTo = (target: string) => ({ TCP: { "8443": { HTTPS: true } }, Web: { [`${DNS}:8443`]: { Handlers: { "/": { Proxy: target } } } } });

	it("sees an empty config as free, and leaves other ports alone", () => {
		assert.deepEqual(describeServePort({}, DNS, 8443), { kind: "free" });
		const otherPort = { TCP: { "443": { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } };
		assert.deepEqual(describeServePort(otherPort, DNS, 8443), { kind: "free" });
	});

	it("recognises a single root proxy to a loopback port", () => {
		assert.deepEqual(describeServePort(proxyTo("http://127.0.0.1:50123"), DNS, 8443), { kind: "loopback-proxy", serverPort: 50123 });
		assert.deepEqual(describeServePort(proxyTo("http://127.0.0.1:50123/"), DNS.toUpperCase(), 8443), { kind: "loopback-proxy", serverPort: 50123 });
	});

	it("treats every other use of the port as something it must not touch", () => {
		const cases = [
			proxyTo("http://localhost:50123"),
			proxyTo("http://127.0.0.1:50123/sub"),
			proxyTo("https+insecure://127.0.0.1:50123"),
			proxyTo("http://192.168.1.5:50123"),
			{ TCP: { "8443": { TCPForward: "127.0.0.1:22" } } },
			{ TCP: { "8443": { HTTPS: true } }, Web: { [`${DNS}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:1" }, "/blog": { Path: "/srv" } } } } },
			{ TCP: { "8443": { HTTPS: true } }, Web: { [`${DNS}:8443`]: { Handlers: { "/": { Path: "C:\\site" } } } } },
			{ ...proxyTo("http://127.0.0.1:50123"), AllowFunnel: { [`${DNS}:8443`]: true } },
			{ Foreground: { session1: { TCP: { "8443": { HTTPS: true } } } } },
			{ TCP: { "8443": { HTTPS: true } }, Web: { "other.tail.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:1" } } } } },
		];
		for (const config of cases) assert.equal(describeServePort(config, DNS, 8443).kind, "other", JSON.stringify(config));
	});
});
