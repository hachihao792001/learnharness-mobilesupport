// Fork: PWA (docs/MOBILE_PWA.md). The real public/sw.js runs in a vm with
// fake caches/fetch/clients: it may cache only versioned static files and
// must never cache pages or private data. Plus the manifest and its icons.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { runInNewContext } from "node:vm";
import manifest from "../app/manifest.ts";
import { serviceWorkerURL } from "../components/pwa/pwa-support.tsx";

const ORIGIN = "https://company-cpu.tail14bb89.ts.net:8443";
const SOURCE = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

function loadWorker({ version = "0.7.0", online = true, existingCaches = [] as string[] } = {}) {
	const stores = new Map<string, Map<string, Response>>(existingCaches.map((name) => [name, new Map()]));
	const listeners = new Map<string, (event: unknown) => void>();
	const network: string[] = [];
	let skipped = 0;
	let claimed = 0;
	const keyOf = (request: Request | string) => (typeof request === "string" ? new URL(request, ORIGIN).href : request.url);
	const caches = {
		async open(name: string) {
			if (!stores.has(name)) stores.set(name, new Map());
			const store = stores.get(name)!;
			return {
				async match(request: Request | string) { return store.get(keyOf(request))?.clone(); },
				async put(request: Request | string, response: Response) { store.set(keyOf(request), response); },
				async addAll(urls: string[]) { for (const url of urls) store.set(keyOf(url), new Response(`precached ${url}`)); },
			};
		},
		async match(request: Request | string) {
			for (const store of stores.values()) { const hit = store.get(keyOf(request)); if (hit) return hit.clone(); }
			return undefined;
		},
		async keys() { return [...stores.keys()]; },
		async delete(name: string) { return stores.delete(name); },
	};
	const fetchStub = async (request: Request) => {
		network.push(`${request.method} ${new URL(request.url).pathname}`);
		if (!online) throw new TypeError("Failed to fetch");
		const response = new Response(`network ${request.url}`, { status: 200 });
		Object.defineProperty(response, "type", { value: "basic" });
		return response;
	};
	const self = {
		location: { href: `${ORIGIN}/sw.js?v=${version}`, origin: ORIGIN },
		addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
		skipWaiting: () => { skipped++; },
		clients: { claim: async () => { claimed++; } },
	};
	runInNewContext(SOURCE, { self, caches, fetch: fetchStub, URL, Response, Request, Promise, console });

	async function dispatchFetch(url: string, init: RequestInit & { mode?: string } = {}) {
		// Node's Request refuses mode "navigate" (only browsers create those): set it afterwards.
		const { mode, ...requestInit } = init;
		const request = new Request(url, requestInit);
		if (mode === "navigate") Object.defineProperty(request, "mode", { value: "navigate" });
		let responded: Promise<Response> | undefined;
		listeners.get("fetch")!({ request, respondWith: (value: Promise<Response>) => { responded = value; } });
		return responded ? await responded : undefined;
	}
	async function dispatchLifecycle(type: "install" | "activate") {
		let work: Promise<unknown> = Promise.resolve();
		listeners.get(type)!({ waitUntil: (value: Promise<unknown>) => { work = value; } });
		await work;
	}
	return {
		stores, network, dispatchFetch, dispatchLifecycle,
		message: (data: unknown) => listeners.get("message")!({ data }),
		get skipped() { return skipped; },
		get claimed() { return claimed; },
		setOnline(value: boolean) { online = value; },
	};
}

describe("service worker caching rules", () => {
	it("precaches the offline page and icons into a cache named for the app version", async () => {
		const worker = loadWorker();
		await worker.dispatchLifecycle("install");
		assert.deepEqual([...worker.stores.keys()], ["lh-static-0.7.0"]);
		assert(worker.stores.get("lh-static-0.7.0")!.has(`${ORIGIN}/offline.html`));
	});

	it("never touches API calls, streams, session images, plugin assets or writes", async () => {
		const worker = loadWorker();
		for (const path of ["/api/chats", "/api/chats/x/stream", "/api/events", "/api/chats/x/images/abc", "/api/plugins/p/assets/a.js", "/api/keys"]) {
			assert.equal(await worker.dispatchFetch(`${ORIGIN}${path}`), undefined, path);
		}
		assert.equal(await worker.dispatchFetch(`${ORIGIN}/_next/static/a.js`, { method: "POST", body: "x" }), undefined);
		assert.equal(await worker.dispatchFetch("https://cdn.example/_next/static/a.js"), undefined, "other origins are left alone");
		assert.equal(worker.stores.size, 0, "nothing was cached");
	});

	it("serves pages from the network and never stores them", async () => {
		const worker = loadWorker();
		const page = await worker.dispatchFetch(`${ORIGIN}/chat/abc`, { mode: "navigate" });
		assert.equal(await page!.text(), `network ${ORIGIN}/chat/abc`);
		for (const store of worker.stores.values()) assert(![...store.keys()].some((key) => key.includes("/chat/")));
	});

	it("shows the offline page when a page cannot be loaded", async () => {
		const worker = loadWorker({ online: false });
		await worker.dispatchLifecycle("install");
		const page = await worker.dispatchFetch(`${ORIGIN}/chat/abc`, { mode: "navigate" });
		assert.equal(await page!.text(), "precached /offline.html");
	});

	it("caches versioned build assets, fonts and icons, then serves them without the network", async () => {
		const worker = loadWorker();
		for (const path of ["/_next/static/chunks/app-123.js", "/fonts/cmunbx.ttf", "/icons/icon-512.png"]) {
			await worker.dispatchFetch(`${ORIGIN}${path}`);
		}
		worker.setOnline(false);
		const again = await worker.dispatchFetch(`${ORIGIN}/_next/static/chunks/app-123.js`);
		assert.equal(await again!.text(), `network ${ORIGIN}/_next/static/chunks/app-123.js`);
		assert.deepEqual(worker.network, ["GET /_next/static/chunks/app-123.js", "GET /fonts/cmunbx.ttf", "GET /icons/icon-512.png"]);
	});

	it("deletes older versions' caches on activate, leaving unrelated caches alone", async () => {
		const worker = loadWorker({ version: "0.8.0", existingCaches: ["lh-static-0.7.0", "lh-static-0.8.0", "someone-else"] });
		await worker.dispatchLifecycle("activate");
		assert.deepEqual([...worker.stores.keys()].sort(), ["lh-static-0.8.0", "someone-else"]);
		assert.equal(worker.claimed, 1);
	});

	it("waits for the page's 'Reload' before taking over", () => {
		const worker = loadWorker();
		worker.message({ type: "something-else" });
		assert.equal(worker.skipped, 0);
		worker.message({ type: "SKIP_WAITING" });
		assert.equal(worker.skipped, 1);
	});

	it("is registered with the app version in its URL", () => {
		assert.equal(serviceWorkerURL("0.7.0"), "/sw.js?v=0.7.0");
		assert.equal(serviceWorkerURL(undefined), "/sw.js?v=dev");
	});
});

describe("web app manifest", () => {
	it("is installable: standalone, same-origin start, real icons including maskable", () => {
		const value = manifest();
		assert.equal(value.display, "standalone");
		assert.equal(value.start_url, "/");
		assert.equal(value.scope, "/");
		assert(value.icons?.some((icon) => icon.purpose === "maskable"));
		for (const icon of value.icons ?? []) {
			assert(existsSync(new URL(`../public${icon.src}`, import.meta.url)), icon.src);
			const png = readFileSync(new URL(`../public${icon.src}`, import.meta.url));
			const size = png.readUInt32BE(16);
			assert.equal(`${size}x${png.readUInt32BE(20)}`, icon.sizes, icon.src);
		}
		assert(existsSync(new URL("../public/icons/apple-touch-icon.png", import.meta.url)));
	});
});
