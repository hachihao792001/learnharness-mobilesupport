// Fork: phone support (docs/MOBILE_PWA.md). Logic that runs in the browser:
// browser marking, remote detection, long press, image store, draft saving,
// reconnecting to a running turn, the graph node list filter, and the
// session composer's phone image button. Layout is checked in real Chrome by
// scripts/fork/smoke-mobile.mjs.
import React, { act, useRef } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";

const { window, document } = parseHTML("<html><head></head><body></body></html>");
const fakeLocation = { hostname: "company-cpu.tail14bb89.ts.net" };
Object.defineProperty(window, "location", { value: fakeLocation, configurable: true });
let visibility: "visible" | "hidden" = "visible";
Object.defineProperty(document, "visibilityState", { get: () => visibility, configurable: true });
const storage = new Map<string, string>();
const localStorageStub = {
	getItem: (key: string) => storage.get(key) ?? null,
	setItem: (key: string, value: string) => { storage.set(key, String(value)); },
	removeItem: (key: string) => { storage.delete(key); },
};
let userAgent = "Mozilla/5.0 (Linux; Android 15) Chrome/140.0 Mobile Safari/537.36";
Object.defineProperty(globalThis, "navigator", { value: { get userAgent() { return userAgent; } }, configurable: true });
Object.assign(globalThis, {
	window, document,
	Element: window.Element, HTMLElement: window.HTMLElement, Node: window.Node,
	Event: window.Event, CustomEvent: window.CustomEvent,
});
// linkedom has no MouseEvent; a real browser's keeps clientX/clientY from its init.
class TestMouseEvent extends window.Event {
	clientX: number; clientY: number; button: number;
	constructor(type: string, init: { clientX?: number; clientY?: number; button?: number } & EventInit = {}) {
		super(type, init);
		this.clientX = init.clientX ?? 0; this.clientY = init.clientY ?? 0; this.button = init.button ?? 0;
	}
}
Object.assign(globalThis, { MouseEvent: TestMouseEvent });
Object.defineProperty(globalThis, "localStorage", { value: localStorageStub, configurable: true });
Object.defineProperty(window, "localStorage", { value: localStorageStub, configurable: true });

const { MARK_BROWSER_SCRIPT, isRemoteBrowser } = await import("../components/mobile/browser-mode.ts");
const { installLongPressContextMenu, LONG_PRESS_MS } = await import("../components/mobile/long-press-context-menu.ts");
const images = await import("../components/mobile/remote-images.ts");
const { useRemoteComposerDraft, remoteDraftKey } = await import("../components/mobile/use-remote-composer-draft.ts");
const { useRemoteStreamRecovery } = await import("../components/mobile/use-remote-stream-recovery.ts");
const { filterGraphNodes } = await import("../components/mobile/graph-node-list.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { ChatSessionComposer } = await import("../components/composer.tsx");

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const roots: { root: Root; host: HTMLElement }[] = [];
async function mount(element: React.ReactElement) {
	const host = document.createElement("div") as unknown as HTMLElement;
	document.body.append(host);
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(host);
	roots.push({ root, host });
	await act(async () => { root.render(element); });
	return host;
}
afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => { root.unmount(); });
		host.remove();
	}
	storage.clear();
	fakeLocation.hostname = "company-cpu.tail14bb89.ts.net";
	userAgent = "Mozilla/5.0 (Linux; Android 15) Chrome/140.0 Mobile Safari/537.36";
	visibility = "visible";
});

describe("browser marking and remote detection", () => {
	it("marks any browser before first paint, never the Electron window", () => {
		for (const [agent, marked] of [["Mozilla/5.0 Chrome/140.0", true], ["Mozilla/5.0 LearnHarness/0.7.0 Chrome/140.0 Electron/44.9.3 Safari/537.36", false]] as const) {
			const classes = new Set<string>();
			runInNewContext(MARK_BROWSER_SCRIPT, { navigator: { userAgent: agent }, document: { documentElement: { classList: { add: (name: string) => classes.add(name) } } } });
			assert.equal(classes.has("lh-browser"), marked, agent);
		}
	});

	it("counts only a non-loopback browser as remote", () => {
		assert.equal(isRemoteBrowser(), true);
		for (const hostname of ["localhost", "127.0.0.1", "[::1]", "app.localhost"]) {
			fakeLocation.hostname = hostname;
			assert.equal(isRemoteBrowser(), false, hostname);
		}
		fakeLocation.hostname = "company-cpu.tail14bb89.ts.net";
		userAgent = "Mozilla/5.0 Chrome/140.0 Electron/44.9.3";
		assert.equal(isRemoteBrowser(), false, "the desktop window is never remote");
	});
});

describe("long press opens the existing context menus", () => {
	function pointer(type: string, props: Record<string, unknown>) {
		return Object.assign(new window.Event(type, { bubbles: true, cancelable: true }), { pointerType: "touch", pointerId: 1, clientX: 10, clientY: 20, ...props });
	}

	it("sends contextmenu at the finger's position after holding still, then swallows the lifting click", async () => {
		const row = document.createElement("div");
		document.body.append(row);
		const menus: { x: number; y: number }[] = [];
		row.addEventListener("contextmenu", (event) => menus.push({ x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY }));
		let clicks = 0;
		row.addEventListener("click", () => clicks++);
		const uninstall = installLongPressContextMenu(document as unknown as Document);
		try {
			row.dispatchEvent(pointer("pointerdown", {}));
			await delay(LONG_PRESS_MS + 50);
			assert.deepEqual(menus, [{ x: 10, y: 20 }]);
			// linkedom runs capture listeners after the target's (no capture phase), so check that the
			// lifting click is cancelled; a real browser also stops it before the row (scripts/fork/smoke-mobile.mjs).
			const lifting = new window.Event("click", { bubbles: true, cancelable: true });
			row.dispatchEvent(lifting);
			assert.equal(lifting.defaultPrevented, true, "the click from lifting the finger is cancelled");
			const nextTap = new window.Event("click", { bubbles: true, cancelable: true });
			row.dispatchEvent(nextTap);
			assert.equal(nextTap.defaultPrevented, false, "only that one click");
			assert.equal(clicks, 2);
		} finally { uninstall(); row.remove(); }
	});

	it("does nothing for a moving finger, a mouse, or a text field", async () => {
		const row = document.createElement("div");
		const field = document.createElement("textarea");
		document.body.append(row, field);
		let menus = 0;
		document.addEventListener("contextmenu", () => menus++);
		const uninstall = installLongPressContextMenu(document as unknown as Document);
		try {
			row.dispatchEvent(pointer("pointerdown", {}));
			row.dispatchEvent(pointer("pointermove", { clientX: 40 }));
			row.dispatchEvent(pointer("pointerdown", { pointerType: "mouse" }));
			field.dispatchEvent(pointer("pointerdown", {}));
			await delay(LONG_PRESS_MS + 50);
			assert.equal(menus, 0);
		} finally { uninstall(); row.remove(); field.remove(); }
	});
});

describe("phone image store", () => {
	let restore: () => void;
	beforeEach(() => {
		const createElement = document.createElement.bind(document);
		const saved = { createImageBitmap: (globalThis as { createImageBitmap?: unknown }).createImageBitmap, createElement: document.createElement };
		(globalThis as { createImageBitmap?: unknown }).createImageBitmap = async (file: { name: string }) => {
			if (file.name === "broken") throw new Error("not an image");
			return { width: 4000, height: 3000, close() {} };
		};
		(document as unknown as { createElement: unknown }).createElement = (tag: string) => tag === "canvas"
			? { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob: (callback: (blob: Blob) => void, type: string) => callback(new Blob([new Uint8Array([1, 2, 3])], { type })) }
			: createElement(tag);
		restore = () => {
			(globalThis as { createImageBitmap?: unknown }).createImageBitmap = saved.createImageBitmap;
			(document as unknown as { createElement: unknown }).createElement = saved.createElement;
			images.setImageTargetChat(null);
		};
	});
	afterEach(() => restore());

	it("keeps images per chat, as small JPEGs in the chat wire shape, up to the limit", async () => {
		images.setImageTargetChat("chat-a");
		const files = ["one", "broken", "two", "three", "four", "five"].map((name) => ({ name }) as unknown as File);
		const result = await images.addPickedImageFiles(files);
		assert.deepEqual(result, { skipped: 1, overLimit: true });
		const picked = images.pickedImagesForChat("chat-a");
		assert.equal(picked.length, images.MAX_IMAGES_PER_MESSAGE);
		assert.deepEqual(picked[0], { type: "image", data: "AQID", mimeType: "image/jpeg" });
		assert.deepEqual(images.pickedImagesForChat("chat-b"), [], "another chat never gets them");
		images.clearPickedImages("chat-a");
		assert.deepEqual(images.pickedImagesForChat("chat-a"), []);
	});

	it("drops images when the chat on screen changes", async () => {
		images.setImageTargetChat("chat-a");
		await images.addPickedImageFiles([{ name: "one" } as unknown as File]);
		images.setImageTargetChat("chat-b");
		assert.deepEqual(images.pickedImagesForChat("chat-a"), []);
	});
});

describe("unsent text survives on a phone", () => {
	function DraftProbe({ chatId, initial, onApply, textOut }: { chatId: string; initial: string; onApply: (text: string) => void; textOut: { ref?: React.RefObject<string> } }) {
		const textRef = useRef(initial);
		textOut.ref = textRef;
		useRemoteComposerDraft(chatId, textRef, (text) => { textRef.current = text; onApply(text); });
		return null;
	}

	it("restores a saved draft into an empty composer and saves new text", async () => {
		storage.set(remoteDraftKey("c1"), "half-written answer");
		const applied: string[] = [];
		const out: { ref?: React.RefObject<string> } = {};
		await mount(<DraftProbe chatId="c1" initial="" onApply={(text) => applied.push(text)} textOut={out} />);
		assert.deepEqual(applied, ["half-written answer"]);
		out.ref!.current = "new text";
		await act(async () => { await delay(1100); });
		assert.equal(storage.get(remoteDraftKey("c1")), "new text");
		out.ref!.current = "";
		await act(async () => { await delay(1100); });
		assert.equal(storage.has(remoteDraftKey("c1")), false, "an accepted (cleared) composer removes the draft");
	});

	it("never overwrites text already in the composer, and does nothing on the desktop or a local tab", async () => {
		storage.set(remoteDraftKey("c2"), "old");
		const applied: string[] = [];
		await mount(<DraftProbe chatId="c2" initial="typed now" onApply={(text) => applied.push(text)} textOut={{}} />);
		assert.equal(applied.length, 0);
		fakeLocation.hostname = "127.0.0.1";
		await mount(<DraftProbe chatId="c2" initial="" onApply={(text) => applied.push(text)} textOut={{}} />);
		assert.deepEqual(applied, []);
	});
});

describe("reconnecting to a running turn", () => {
	function RecoveryProbe({ chatId, attach, streaming }: { chatId: string; attach: () => void; streaming: () => boolean }) {
		useRemoteStreamRecovery(chatId, attach, streaming);
		return null;
	}
	let opened: (() => void) | null;
	const connect = () => ({ close() {}, onOpen(callback: () => void) { opened = callback; }, onEvent() {} });
	let savedFetch: typeof fetch;
	let turnInFlight: boolean;
	let requests: string[];
	beforeEach(() => {
		savedFetch = globalThis.fetch;
		turnInFlight = true;
		requests = [];
		opened = null;
		globalThis.fetch = (async (url: string) => { requests.push(url); return new Response(JSON.stringify({ jobs: [], turnInFlight })); }) as typeof fetch;
	});
	afterEach(() => { globalThis.fetch = savedFetch; });

	async function render(streaming = false) {
		let attached = 0;
		await mount(<ServerEventsProvider connect={connect}><RecoveryProbe chatId="c 1" attach={() => attached++} streaming={() => streaming} /></ServerEventsProvider>);
		return () => attached;
	}

	it("re-attaches when the phone comes back online and the turn still runs", async () => {
		const attached = await render();
		await act(async () => { window.dispatchEvent(new window.Event("online")); await delay(500); });
		assert.deepEqual(requests, ["/api/jobs?chatId=c%201"]);
		assert.equal(attached(), 1);
	});

	it("also checks when the events channel reconnects, and when the tab becomes visible", async () => {
		const attached = await render();
		await act(async () => { opened?.(); await delay(500); });
		visibility = "visible";
		await act(async () => { document.dispatchEvent(new window.Event("visibilitychange")); await delay(500); });
		assert.equal(attached(), 2);
	});

	it("does not attach when the turn is over or a stream is already live, and never posts anything", async () => {
		turnInFlight = false;
		const attachedWhenSettled = await render();
		await act(async () => { window.dispatchEvent(new window.Event("online")); await delay(500); });
		assert.equal(attachedWhenSettled(), 0);
		turnInFlight = true;
		const attachedWhileStreaming = await render(true);
		await act(async () => { window.dispatchEvent(new window.Event("online")); await delay(500); });
		assert.equal(attachedWhileStreaming(), 0);
		assert(requests.every((url) => url.startsWith("/api/jobs?")), "read-only: only GET /api/jobs");
	});

	it("is off outside a remote browser", async () => {
		fakeLocation.hostname = "localhost";
		const attached = await render();
		await act(async () => { window.dispatchEvent(new window.Event("online")); await delay(500); });
		assert.equal(attached(), 0);
		assert.deepEqual(requests, []);
	});
});

describe("graph node list", () => {
	it("matches every word in the name or statement, sorted by name", () => {
		const graph = {
			propositions: [
				{ id: "2", name: "Will to power", statement: "Nietzsche's basic drive." },
				{ id: "1", name: "Divine command theory", statement: "Morality is what God commands." },
				{ id: "3", name: "Categorical imperative", statement: "Act only by a maxim you could will as law." },
			],
			sessions: {}, nodeSessions: {},
		} as unknown as Parameters<typeof filterGraphNodes>[0];
		assert.deepEqual(filterGraphNodes(graph, "").map((node) => node.id), ["3", "1", "2"]);
		assert.deepEqual(filterGraphNodes(graph, "WILL").map((node) => node.id), ["3", "2"]);
		assert.deepEqual(filterGraphNodes(graph, "will law").map((node) => node.id), ["3"]);
	});
});

describe("session composer attach button", () => {
	afterEach(() => images.setImageTargetChat(null));
	const composer = () => <ChatSessionComposer busy={false} value="" revision={0} onChange={() => {}} onSend={() => {}} onStop={() => {}} sendAllowed dictationActive={false} />;

	it("shows the phone image button only in a remote browser on a chat page", async () => {
		images.setImageTargetChat("chat-a");
		const remote = await mount(composer());
		assert(remote.querySelector("[data-testid='remote-image-attach']"));
		assert.equal(remote.querySelector("[data-testid='attach-files']"), null);
	});

	it("keeps the desktop attach button everywhere else", async () => {
		const noChat = await mount(composer());
		assert(noChat.querySelector("[data-testid='attach-files']"), "no chat on screen");
		images.setImageTargetChat("chat-a");
		fakeLocation.hostname = "127.0.0.1";
		const local = await mount(composer());
		assert(local.querySelector("[data-testid='attach-files']"), "local browser tab");
		assert.equal(local.querySelector("[data-testid='remote-image-attach']"), null);
	});
});
