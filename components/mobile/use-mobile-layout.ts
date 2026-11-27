"use client";
// Fork: mobile layout. The same rule as app/mobile.css: a browser (never the
// Electron window) narrower than 768px.
import { useSyncExternalStore } from "react";
import { isElectronWindow, MOBILE_LAYOUT_QUERY } from "./browser-mode.ts";

function subscribeToWidth(onChange: () => void): () => void {
	const query = window.matchMedia(MOBILE_LAYOUT_QUERY);
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
}

function readMobileLayout(): boolean {
	return !isElectronWindow() && window.matchMedia(MOBILE_LAYOUT_QUERY).matches;
}

/** False on the server and on first hydration, so markup always matches. */
export function useMobileLayout(): boolean {
	return useSyncExternalStore(subscribeToWidth, readMobileLayout, () => false);
}
