"use client";
// Fork: short notices for the phone (restored draft, reconnecting, offline).
// A tiny store so hooks inside upstream components can show a message
// without the component rendering anything new.
import { useEffect, useSyncExternalStore } from "react";

const NOTICE_MS = 6000;
let currentNotice: { id: number; text: string } | null = null;
let nextId = 0;
const listeners = new Set<() => void>();

function publish(notice: typeof currentNotice) {
	currentNotice = notice;
	for (const listener of listeners) listener();
}

export function showRemoteNotice(text: string): void {
	publish({ id: ++nextId, text });
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function RemoteNotices() {
	const notice = useSyncExternalStore(subscribe, () => currentNotice, () => null);
	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(() => { if (currentNotice?.id === notice.id) publish(null); }, NOTICE_MS);
		return () => clearTimeout(timer);
	}, [notice]);
	if (!notice) return null;
	return (
		<div role="status" aria-live="polite" data-testid="remote-notice" className="lh-remote-notice" onClick={() => publish(null)}>
			{notice.text}
		</div>
	);
}
