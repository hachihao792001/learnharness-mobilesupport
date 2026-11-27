"use client";
// Fork: installable PWA support for a remote browser (docs/MOBILE_PWA.md).
// Registers public/sw.js, offers "Update ready" when a new version is
// waiting, an install button where the browser allows it (Android Chrome) or
// a one-time Add to Home Screen hint (iOS Safari), and an offline banner.
// Nothing here runs in the Electron window or on a local browser tab.
import { useEffect, useState } from "react";
import { isRemoteBrowser } from "@/components/mobile/browser-mode";

const IOS_HINT_DISMISSED_KEY = "lh:pwa:ios-hint-dismissed";
// Set when the user taps Reload; the first install also changes the controller but must not reload.
let updateAccepted = false;

interface InstallPromptEvent extends Event {
	prompt(): Promise<void>;
	userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function serviceWorkerURL(version: string | undefined): string {
	return `/sw.js?v=${encodeURIComponent(version || "dev")}`;
}

function runningInstalled(): boolean {
	return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isIOSSafari(): boolean {
	const agent = navigator.userAgent;
	return /iPhone|iPad|iPod/.test(agent) && /Safari\//.test(agent) && !/CriOS|FxiOS|EdgiOS/.test(agent);
}

export function PwaSupport() {
	const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
	const [installEvent, setInstallEvent] = useState<InstallPromptEvent | null>(null);
	const [showIOSHint, setShowIOSHint] = useState(false);
	const [offline, setOffline] = useState(false);

	useEffect(() => {
		if (!isRemoteBrowser()) return;
		const cleanups: (() => void)[] = [];

		const updateOnline = () => setOffline(!navigator.onLine);
		updateOnline();
		window.addEventListener("online", updateOnline);
		window.addEventListener("offline", updateOnline);
		cleanups.push(() => { window.removeEventListener("online", updateOnline); window.removeEventListener("offline", updateOnline); });

		if (!runningInstalled()) {
			const onInstallPrompt = (event: Event) => { event.preventDefault(); setInstallEvent(event as InstallPromptEvent); };
			window.addEventListener("beforeinstallprompt", onInstallPrompt);
			cleanups.push(() => window.removeEventListener("beforeinstallprompt", onInstallPrompt));
			try { if (isIOSSafari() && !localStorage.getItem(IOS_HINT_DISMISSED_KEY)) setShowIOSHint(true); } catch { /* storage blocked */ }
		}

		if ("serviceWorker" in navigator && window.isSecureContext) {
			let reloading = false;
			const onControllerChange = () => { if (updateAccepted && !reloading) { reloading = true; window.location.reload(); } };
			navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
			cleanups.push(() => navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange));
			navigator.serviceWorker.register(serviceWorkerURL(process.env.LH_VERSION), { scope: "/", updateViaCache: "none" }).then((registration) => {
				// Only an update needs asking: the very first install has no old version to replace.
				const offerIfWaiting = () => { if (registration.waiting && navigator.serviceWorker.controller) setWaitingWorker(registration.waiting); };
				offerIfWaiting();
				registration.addEventListener("updatefound", () => {
					registration.installing?.addEventListener("statechange", offerIfWaiting);
				});
				const checkForUpdate = () => { if (document.visibilityState === "visible") void registration.update().catch(() => {}); };
				document.addEventListener("visibilitychange", checkForUpdate);
				cleanups.push(() => document.removeEventListener("visibilitychange", checkForUpdate));
			}, () => { /* no service worker: the app still works, just without offline page and install */ });
		}
		return () => { for (const cleanup of cleanups) cleanup(); };
	}, []);

	return (
		<div className="lh-pwa-banners">
			{offline && <div role="status" className="lh-pwa-banner" data-testid="pwa-offline">You're offline. LearnHarness can't reach your computer; unsent text is kept.</div>}
			{waitingWorker && (
				<div role="status" className="lh-pwa-banner" data-testid="pwa-update">
					<span>A new version of LearnHarness is ready.</span>
					<button type="button" onClick={() => { updateAccepted = true; waitingWorker.postMessage({ type: "SKIP_WAITING" }); }}>Reload</button>
				</div>
			)}
			{installEvent && (
				<div role="status" className="lh-pwa-banner" data-testid="pwa-install">
					<span>Install LearnHarness on this phone?</span>
					<button type="button" onClick={async () => { await installEvent.prompt(); await installEvent.userChoice.catch(() => null); setInstallEvent(null); }}>Install</button>
					<button type="button" aria-label="Not now" onClick={() => setInstallEvent(null)}>✕</button>
				</div>
			)}
			{showIOSHint && (
				<div role="status" className="lh-pwa-banner" data-testid="pwa-ios-hint">
					<span>To install: tap Share, then “Add to Home Screen”.</span>
					<button type="button" aria-label="Got it" onClick={() => { setShowIOSHint(false); try { localStorage.setItem(IOS_HINT_DISMISSED_KEY, "1"); } catch { /* storage blocked */ } }}>✕</button>
				</div>
			)}
		</div>
	);
}
