// Fork: LearnHarness PWA service worker (docs/MOBILE_PWA.md).
//
// Caches ONLY public, versioned static files: build assets under
// /_next/static/ (their names change with every build), fonts, icons and the
// offline page. It never caches pages, /api responses, streams, images from
// sessions or anything private. Pages always come from the network; when the
// network is gone, the static offline page is shown instead.
//
// Registered as /sw.js?v=<app version>; a new version waits until the page
// asks it to take over (the "Update ready" prompt), then old caches go.

const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const CACHE_PREFIX = "lh-static-";
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/icons/icon-192.png", "/icons/icon-512.png"];
const CACHEABLE_PATHS = [/^\/_next\/static\//, /^\/fonts\//, /^\/icons\//];

self.addEventListener("install", (event) => {
	event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener("activate", (event) => {
	event.waitUntil((async () => {
		const names = await caches.keys();
		await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name)));
		await self.clients.claim();
	})());
});

self.addEventListener("message", (event) => {
	if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

async function cacheFirst(request) {
	const cache = await caches.open(CACHE_NAME);
	const cached = await cache.match(request);
	if (cached) return cached;
	const response = await fetch(request);
	if (response.ok && response.type === "basic") await cache.put(request, response.clone());
	return response;
}

async function networkFirstPage(request) {
	try {
		return await fetch(request);
	} catch {
		const offline = await caches.match(OFFLINE_URL);
		return offline || new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
	}
}

self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	if (request.mode === "navigate") {
		event.respondWith(networkFirstPage(request));
		return;
	}
	if (CACHEABLE_PATHS.some((pattern) => pattern.test(url.pathname))) event.respondWith(cacheFirst(request));
	// Everything else (/api, streams, session images, plugin assets) goes to the network untouched.
});
