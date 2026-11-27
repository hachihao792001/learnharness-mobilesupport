// Fork: mobile layout (docs/MOBILE_PWA.md). Tells the desktop window apart
// from a browser, and a phone on the remote address from a local tab.

/** Runs in <head> before first paint (app/layout.tsx), so the mobile CSS in
 * app/mobile.css never flashes in the Electron window, which never gets it. */
export const MARK_BROWSER_SCRIPT = 'if(!/Electron\\//.test(navigator.userAgent))document.documentElement.classList.add("lh-browser")';

export const MOBILE_LAYOUT_QUERY = "(max-width: 767px)";

export function isElectronWindow(): boolean {
	return typeof navigator !== "undefined" && /Electron\//.test(navigator.userAgent);
}

function isLoopbackHostName(hostname: string): boolean {
	const bare = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	return bare === "localhost" || bare.endsWith(".localhost") || bare === "::1" || /^127\./.test(bare);
}

/** A browser on the Remote Access address (not the desktop window, not a local dev tab). */
export function isRemoteBrowser(): boolean {
	if (typeof window === "undefined" || isElectronWindow()) return false;
	return !isLoopbackHostName(window.location.hostname);
}
