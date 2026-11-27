#!/usr/bin/env node
// Fork: phone layout smoke test in real Chrome (docs/MOBILE_PWA.md).
//
// Boots the built standalone server (browser-only mode, scratch data) and
// opens it in headless Chrome at the five required viewport sizes. Chrome
// maps the name lh-remote.test to 127.0.0.1 and treats it as a secure
// origin, so the page behaves like a phone on the Remote Access address
// (remote-only features on) without Tailscale or a real phone.
//
// Usage: npm run build && node scripts/build-server.mjs && node scripts/fork/smoke-mobile.mjs [--out <dir>]
// Needs Chrome stable installed (never downloads a browser).
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const standalone = path.join(repo, ".next", "standalone", "server.js");
const REMOTE_NAME = "lh-remote.test";
const VIEWPORTS = [
	{ width: 360, height: 800 },
	{ width: 390, height: 844 },
	{ width: 412, height: 915 },
	{ width: 768, height: 1024 },
	{ width: 1280, height: 800 },
];
const PHONE_AGENT = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36";
const ELECTRON_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) LearnHarness/0.7.0 Chrome/140.0 Electron/44.9.3 Safari/537.36";

const outArg = process.argv.indexOf("--out");
const outDir = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : path.join(tmpdir(), `lh-smoke-mobile-${Date.now()}`);
const failures = [];
// The script must never hang a CI job: each step is named, and a watchdog
// fails the run with that name if the whole smoke takes too long.
let currentStep = "start";
const step = (name) => { currentStep = name; };
const WATCHDOG_MS = 12 * 60 * 1000;
setTimeout(() => {
	console.error(`\nsmoke-mobile: stuck for ${WATCHDOG_MS / 60000} minutes at step "${currentStep}"`);
	process.exit(1);
}, WATCHDOG_MS).unref();
const check = (ok, message) => { console.log(`${ok ? "  ok  " : "  FAIL"} ${message}`); if (!ok) failures.push(message); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function chromeExecutable() {
	const candidates = [
		process.env.CHROME_PATH,
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		path.join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
		"/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/opt/google/chrome/chrome",
		...[process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
			.filter(Boolean).map((directory) => path.join(directory, "Google", "Chrome", "Application", "chrome.exe")),
	].filter(Boolean);
	for (const candidate of candidates) {
		try {
			await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
			if ((await stat(candidate)).isFile()) return candidate;
		} catch { /* next */ }
	}
	throw new Error("smoke-mobile: Chrome stable not found. Set CHROME_PATH.");
}

function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
		server.on("error", reject);
	});
}

async function waitForServer(url) {
	for (let attempt = 0; attempt < 150; attempt++) {
		try { if ((await fetch(url)).ok) return; } catch { /* starting */ }
		await sleep(200);
	}
	throw new Error(`smoke-mobile: server never answered on ${url}`);
}

/** PWA in real Chrome: manifest, service worker, offline banner and page, and what got cached. */
/** A Node-side limit: a stalled page or protocol call fails the check instead of hanging the job. */
function within(ms, promise, label) {
	return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s: ${label}`)), ms))]);
}

async function checkPwa(page, origin, chatId) {
	console.log("  -- PWA");
	step("PWA: manifest");
	const manifest = await page.evaluate(async () => {
		const link = document.querySelector("link[rel='manifest']");
		if (!link) return null;
		const response = await fetch(link.href);
		return { status: response.status, body: await response.json() };
	});
	check(manifest?.status === 200 && manifest.body.display === "standalone", "manifest is linked and served (standalone)");
	step("PWA: service worker ready");
	const active = await within(20000, page.evaluate(() => Promise.race([
		navigator.serviceWorker.ready.then((registration) => !!registration.active),
		new Promise((resolve) => setTimeout(() => resolve(false), 8000)),
	])), "service worker ready").catch((error) => { console.log(`  (${error.message})`); return false; });
	check(active, "service worker is active");
	step("PWA: reload under the service worker");
	await within(40000, page.reload({ waitUntil: "networkidle2" }), "reload").catch((error) => console.log(`  (${error.message})`));
	check(await within(10000, page.evaluate(() => !!navigator.serviceWorker.controller), "controller").catch(() => false), "service worker controls the page after reload");
	step("PWA: offline banner");

	await page.setOfflineMode(true);
	await sleep(300);
	check(!!(await page.$("[data-testid='pwa-offline']")), "offline banner shows when the connection drops");
	// (Offline emulation covers the page, not the service worker's own fetches:
	// the offline page is checked at the end by really stopping the server.)
	await page.setOfflineMode(false);
	await page.goto(`${origin}/chat/${chatId}`, { waitUntil: "networkidle2" });
	await page.waitForSelector("[data-testid='composer']");

	const cached = await page.evaluate(async () => {
		const urls = [];
		for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname);
		return urls;
	});
	check(cached.length > 0 && cached.every((pathname) => /^\/(_next\/static|fonts|icons)\/|^\/offline\.html$/.test(pathname)), `only static files are cached (${cached.length} entries, no pages or /api)`);
}

async function main() {
	if (!existsSync(standalone)) throw new Error("smoke-mobile: build first (npm run build && node scripts/build-server.mjs).");
	await mkdir(outDir, { recursive: true });
	const data = await mkdtemp(path.join(tmpdir(), "lh-smoke-mobile-data-"));
	const seeded = spawnSync(process.execPath, ["--import", "tsx", path.join(repo, "scripts", "fork", "seed-mobile-fixture.ts")], { cwd: repo, env: { ...process.env, LH_DATA_DIR: data, NODE_ENV: "test" }, encoding: "utf8" });
	if (seeded.status !== 0) throw new Error(`smoke-mobile: seeding failed\n${seeded.stderr}`);
	const { chatId } = JSON.parse(seeded.stdout.trim().split("\n").at(-1));

	const port = await freePort();
	const server = spawn(process.execPath, [standalone], {
		cwd: path.dirname(standalone),
		env: { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1", NODE_ENV: "production", LH_DATA_DIR: data, LH_AUTH_FILE: path.join(data, "auth.json"), LH_ALLOWED_HOSTS: REMOTE_NAME, LH_DESKTOP_SERVER: "", LH_DESKTOP_API_SECRET: "" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let serverLog = "";
	server.stdout.on("data", (chunk) => { serverLog += chunk; });
	server.stderr.on("data", (chunk) => { serverLog += chunk; });
	const origin = `http://${REMOTE_NAME}:${port}`;
	let browser;
	try {
		await waitForServer(`http://127.0.0.1:${port}/`);
		browser = await puppeteer.launch({
			executablePath: await chromeExecutable(),
			headless: true,
			// A stalled protocol call fails within a minute instead of the default three.
			protocolTimeout: 60000,
			args: [`--host-resolver-rules=MAP ${REMOTE_NAME} 127.0.0.1`, `--unsafely-treat-insecure-origin-as-secure=${origin}`, "--no-first-run", "--no-default-browser-check"],
		});

		for (const viewport of VIEWPORTS) {
			const phone = viewport.width < 768;
			console.log(`\n${viewport.width}×${viewport.height}${phone ? " (phone layout)" : ""}`);
			step(`${viewport.width}×${viewport.height}: layout`);
			// Each size is a separate device: its own storage (drafts), cookies and cache.
			const device = await browser.createBrowserContext();
			const page = await device.newPage();
			page.setDefaultTimeout(30000);
			page.setDefaultNavigationTimeout(30000);
			await page.setUserAgent(viewport.width < 1024 ? PHONE_AGENT : (await browser.userAgent()));
			await page.setViewport({ ...viewport, isMobile: viewport.width < 1024, hasTouch: viewport.width < 1024, deviceScaleFactor: 2 });
			await page.goto(`${origin}/chat/${chatId}`, { waitUntil: "networkidle2" });
			await page.waitForSelector("[data-testid='composer']");
			await sleep(300);
			const layout = await page.evaluate(() => {
				const box = (selector) => { const element = document.querySelector(selector); if (!element) return null; const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width }; };
				const nav = document.querySelector("[data-testid='mobile-bottom-nav']");
				return {
					browserMarked: document.documentElement.classList.contains("lh-browser"),
					navVisible: !!nav && getComputedStyle(nav).display !== "none",
					navTop: nav ? nav.getBoundingClientRect().top : window.innerHeight,
					overflow: document.documentElement.scrollWidth - window.innerWidth,
					composer: box("[data-testid='composer']"),
					// A wide block is fine if it fits, or if its nearest sideways-scrolling box fits.
					blocksOffScreen: [...document.querySelectorAll("main pre, main table")].filter((element) => {
						if (element.getBoundingClientRect().right <= window.innerWidth + 1) return false;
						for (let box = element.parentElement; box; box = box.parentElement) {
							const overflow = getComputedStyle(box).overflowX;
							if (overflow === "auto" || overflow === "scroll") return box.getBoundingClientRect().right > window.innerWidth + 1;
						}
						return true;
					}).length,
					hasPre: !!document.querySelector("main pre"),
					hasTable: !!document.querySelector("main table"),
					imageButton: !!document.querySelector("[data-testid='remote-image-attach']"),
					rootFontSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
					navHeight: nav ? Math.round(nav.getBoundingClientRect().height) : 0,
					innerWidth: window.innerWidth,
					innerHeight: window.innerHeight,
				};
			});
			check(layout.browserMarked, "browser is marked (html.lh-browser)");
			check(layout.navVisible === phone, phone ? "bottom navigation is shown" : "bottom navigation is hidden");
			check(layout.overflow <= 1, `no sideways page scroll (overflow ${layout.overflow}px)`);
			check(!!layout.composer && layout.composer.left >= 0 && layout.composer.right <= layout.innerWidth + 1, "composer fits the width");
			check(!!layout.composer && layout.composer.bottom <= layout.navTop + 1, "composer sits above the bottom bar");
			check(layout.hasPre && layout.hasTable, "code block and table rendered");
			check(layout.blocksOffScreen === 0, `wide code blocks and tables scroll inside the screen (${layout.blocksOffScreen} cut off)`);
			check(layout.imageButton, "phone image button shown (remote browser on a chat page)");
			check(layout.rootFontSize === (phone ? 12.8 : 16), `${phone ? "phone layout at 80% size" : "full size"} (root ${layout.rootFontSize}px)`);
			if (phone) check(layout.navHeight === 56, `bottom bar keeps full-size tap targets (${layout.navHeight}px)`);
			await page.screenshot({ path: path.join(outDir, `chat-${viewport.width}x${viewport.height}.png`) });
			if (viewport.width === 390) await checkPwa(page, origin, chatId);

			if (phone) {
				step(`${viewport.width}×${viewport.height}: drawer, menus, settings, draft, graph`);
				await page.click("[data-testid='mobile-tab-learn']");
				await sleep(350);
				const drawer = await page.$eval("aside.sidebar-motion", (aside) => ({ open: aside.getAttribute("aria-hidden") === "false", width: aside.getBoundingClientRect().width, position: getComputedStyle(aside).position }));
				check(drawer.open && drawer.position === "fixed" && drawer.width <= viewport.width * 0.86, `Learn opens the sessions drawer (${Math.round(drawer.width)}px, ${drawer.position})`);
				await page.screenshot({ path: path.join(outDir, `drawer-${viewport.width}x${viewport.height}.png`) });

				// Long press on a session row opens its existing context menu (pointerType touch).
				const row = await page.$(`[data-session-id='${chatId}']`);
				const rowBox = await row.boundingBox();
				const urlBefore = page.url();
				await page.touchscreen.touchStart(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
				await sleep(900);
				await page.touchscreen.touchEnd();
				await sleep(300);
				check(!!(await page.$("[data-testid='session-context-menu']")), "long press opens the session menu");
				check(page.url() === urlBefore, "lifting the finger does not also open the row");
				await page.keyboard.press("Escape");
				await sleep(200);

				// Tap to the right of the drawer (the backdrop's centre is under the drawer).
				await page.touchscreen.tap(viewport.width - 12, Math.round(viewport.height / 2));
				await sleep(350);
				check(await page.$eval("aside.sidebar-motion", (aside) => aside.getAttribute("aria-hidden") === "true"), "tapping outside closes the drawer");

				await page.click("[data-testid='mobile-tab-activity']");
				await page.waitForSelector("[data-testid='mobile-activity-sheet']", { timeout: 3000 }).then(() => check(true, "Activity opens its sheet"), () => check(false, "Activity opens its sheet"));
				await page.click("[data-testid='mobile-tab-activity']");

				await page.click("[data-testid='mobile-tab-settings']");
				await page.waitForSelector("[data-testid='settings-dialog']", { timeout: 5000 });
				await sleep(300);
				const settings = await page.$eval("[data-testid='settings-dialog']", (dialog) => dialog.getBoundingClientRect().width);
				check(settings >= viewport.width - 1, `Settings opens full width (${Math.round(settings)}px)`);
				check(!(await page.$("[data-testid='section-remote-access']")) && !(await page.evaluate(() => document.body.innerText.includes("Remote Access"))), "Remote Access settings are not offered on the phone");
				await page.screenshot({ path: path.join(outDir, `settings-${viewport.width}x${viewport.height}.png`) });
				await page.click("[data-testid='settings-close']");
				await sleep(300);

				// Unsent text survives a reload.
				await page.click("[data-testid='composer'] [role='textbox']");
				await page.keyboard.type("draft that must survive");
				await sleep(200);
				check(!(await page.evaluate(() => document.documentElement.classList.contains("lh-keyboard-open"))), "focus alone (no keyboard) keeps the bottom bar");
				// A keyboard shrinks the visible height: simulate it.
				await page.setViewport({ ...viewport, height: Math.round(viewport.height * 0.55), isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
				await sleep(300);
				const keyboard = await page.evaluate(() => ({
					open: document.documentElement.classList.contains("lh-keyboard-open"),
					composerBottom: document.querySelector("[data-testid='composer']").getBoundingClientRect().bottom,
					height: window.innerHeight,
					visibleHeight: window.visualViewport?.height,
					focused: document.activeElement ? `${document.activeElement.tagName.toLowerCase()}[role=${document.activeElement.getAttribute("role")}]` : "none",
				}));
				check(keyboard.open, `the keyboard hides the bottom bar (focused ${keyboard.focused}, visible height ${keyboard.visibleHeight})`);
				check(keyboard.composerBottom <= keyboard.height + 1, "the composer stays above the keyboard");
				await page.screenshot({ path: path.join(outDir, `keyboard-${viewport.width}x${viewport.height}.png`) });
				await page.setViewport({ ...viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
				await sleep(300);
				await sleep(1200);
				await page.reload({ waitUntil: "networkidle2" });
				await page.waitForSelector("[data-testid='composer'] [role='textbox']");
				await sleep(500);
				const restored = await page.$eval("[data-testid='composer'] [role='textbox']", (box) => box.textContent);
				check(restored === "draft that must survive", "unsent text is restored after a reload");
				check(!!(await page.$("[data-testid='remote-notice']")), "a notice says the text was restored");
				check(await page.evaluate(() => {
					const notice = document.querySelector("[data-testid='remote-notice']")?.getBoundingClientRect();
					const composer = document.querySelector("[data-testid='composer']").getBoundingClientRect();
					return !notice || notice.bottom <= composer.top || notice.top >= composer.bottom;
				}), "the notice does not cover the composer");

				// Graph tab: home, then the searchable list.
				await page.click("[data-testid='mobile-tab-graph']");
				await page.waitForFunction(() => location.pathname === "/", { timeout: 5000 });
				await sleep(500);
				await page.click("[data-testid='mobile-tab-graph']");
				await page.waitForSelector("[data-testid='mobile-graph-list-sheet']", { timeout: 3000 }).then(() => check(true, "a second Graph tap opens the node list"), () => check(false, "a second Graph tap opens the node list"));
				await page.screenshot({ path: path.join(outDir, `graph-list-${viewport.width}x${viewport.height}.png`) });
			}
			await device.close();
		}

		step("Electron window");
		console.log("\nElectron window at 360×800 (must keep the desktop layout)");
		const desktopWindow = await browser.newPage();
		await desktopWindow.setUserAgent(ELECTRON_AGENT);
		await desktopWindow.setViewport({ width: 360, height: 800 });
		await desktopWindow.goto(`http://127.0.0.1:${port}/chat/${chatId}`, { waitUntil: "networkidle2" });
		await desktopWindow.waitForSelector("[data-testid='composer']");
		await sleep(1000);
		const electron = await desktopWindow.evaluate(async () => ({
			marked: document.documentElement.classList.contains("lh-browser"),
			nav: !!document.querySelector("[data-testid='mobile-bottom-nav']"),
			image: !!document.querySelector("[data-testid='remote-image-attach']"),
			serviceWorkers: (await navigator.serviceWorker?.getRegistrations?.())?.length ?? 0,
			rootFontSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
		}));
		check(!electron.marked && !electron.nav && !electron.image, "no mobile layout, no phone features in the Electron window");
		check(electron.rootFontSize === 16, `the Electron window keeps full size at 360px (root ${electron.rootFontSize}px)`);
		check(electron.serviceWorkers === 0, "no service worker in the Electron window");
		await desktopWindow.close();

		step("computer unreachable");
		console.log("\nComputer unreachable (server stopped), phone at 390×844");
		const phoneDevice = await browser.createBrowserContext();
		const phonePage = await phoneDevice.newPage();
		await phonePage.setUserAgent(PHONE_AGENT);
		await phonePage.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
		phonePage.setDefaultTimeout(30000);
		phonePage.setDefaultNavigationTimeout(30000);
		await phonePage.goto(`${origin}/chat/${chatId}`, { waitUntil: "networkidle2" });
		await within(20000, phonePage.evaluate(() => navigator.serviceWorker.ready.then(() => true)), "service worker ready").catch(() => false);
		await within(40000, phonePage.reload({ waitUntil: "networkidle2" }), "reload").catch(() => {});
		const controlled = await phonePage.evaluate(() => !!navigator.serviceWorker.controller);
		// Like a computer that sleeps or loses power: on Linux a plain SIGTERM lets Next
		// wait for the open events stream, which never ends, so the server never exits.
		const exited = new Promise((resolve) => server.once("exit", resolve));
		server.kill("SIGKILL");
		await within(15000, exited, "server stop").catch((error) => console.log(`  (${error.message})`));
		await phonePage.goto(`${origin}/chat/${chatId}`, { waitUntil: "domcontentloaded" }).catch(() => {});
		check(controlled && (await phonePage.evaluate(() => document.body.innerText)).includes("Can't reach your computer"), "with the computer unreachable, pages show the offline page");
		await phonePage.screenshot({ path: path.join(outDir, "offline-390x844.png") });
		await phoneDevice.close();
	} finally {
		await browser?.close().catch(() => {});
		server.kill();
		await sleep(300);
		await rm(data, { recursive: true, force: true }).catch(() => {});
	}

	console.log(`\nScreenshots: ${outDir}`);
	if (failures.length) {
		console.error(`\nsmoke-mobile: ${failures.length} check(s) failed`);
		if (process.env.SMOKE_MOBILE_SERVER_LOG) console.error(serverLog);
		process.exit(1);
	}
	console.log("smoke-mobile: all checks passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
