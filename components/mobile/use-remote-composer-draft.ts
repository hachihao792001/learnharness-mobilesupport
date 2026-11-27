"use client";
// Fork: unsent text survives a reload, a lost connection or the phone closing
// the tab (remote browsers only; the desktop app behaves as upstream). The
// chat clears its composer only after the server accepts a message, so a
// saved draft is exactly the text that was not confirmed as sent.
import { useEffect, type RefObject } from "react";
import { isRemoteBrowser } from "./browser-mode.ts";
import { showRemoteNotice } from "./remote-notices.tsx";

const SAVE_INTERVAL_MS = 1000;

export function remoteDraftKey(chatId: string): string {
	return `lh:remote-draft:${chatId}`;
}

export function useRemoteComposerDraft(chatId: string, textRef: RefObject<string>, applyText: (text: string) => void): void {
	useEffect(() => {
		if (!isRemoteBrowser()) return;
		const key = remoteDraftKey(chatId);
		let lastSaved = "";
		try {
			const stored = localStorage.getItem(key) ?? "";
			if (stored && !textRef.current) {
				applyText(stored);
				showRemoteNotice("Your unsent text was restored. If you already sent it, check the conversation before sending again.");
			}
			lastSaved = stored;
		} catch { return; /* storage blocked: nothing to restore or save */ }

		const save = () => {
			const text = textRef.current ?? "";
			if (text === lastSaved) return;
			lastSaved = text;
			try {
				if (text.trim()) localStorage.setItem(key, text);
				else localStorage.removeItem(key);
			} catch { /* storage full or blocked */ }
		};
		const saveWhenHidden = () => { if (document.visibilityState === "hidden") save(); };
		const timer = setInterval(save, SAVE_INTERVAL_MS);
		window.addEventListener("pagehide", save);
		document.addEventListener("visibilitychange", saveWhenHidden);
		return () => {
			save();
			clearInterval(timer);
			window.removeEventListener("pagehide", save);
			document.removeEventListener("visibilitychange", saveWhenHidden);
		};
	}, [chatId, textRef, applyText]);
}
