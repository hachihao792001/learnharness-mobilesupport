"use client";
// Fork: reconnect a phone to a turn that kept running on the desktop while
// the phone was asleep, offline or in another app (remote browsers only).
//
// Uses only existing contracts: GET /api/jobs?chatId= reports turnInFlight,
// and the chat's own attachToRunningTurn() replays the running turn from its
// start (GET /api/chats/[id]/stream). It never sends input again.
import { useEffect, useRef } from "react";
import { useServerResync } from "@/components/server-events";
import { isRemoteBrowser } from "./browser-mode.ts";

const CHECK_DELAY_MS = 400;

export function useRemoteStreamRecovery(chatId: string, attachToRunningTurn: () => void, isStreaming: () => boolean): void {
	const attachRef = useRef(attachToRunningTurn);
	attachRef.current = attachToRunningTurn;
	const isStreamingRef = useRef(isStreaming);
	isStreamingRef.current = isStreaming;
	const checkRef = useRef<() => void>(() => {});

	useEffect(() => {
		if (!isRemoteBrowser()) return;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let checking = false;
		const checkRunningTurn = async () => {
			if (checking || document.visibilityState !== "visible" || isStreamingRef.current()) return;
			checking = true;
			try {
				const response = await fetch(`/api/jobs?chatId=${encodeURIComponent(chatId)}`, { cache: "no-store" });
				if (!response.ok) return;
				const { turnInFlight } = (await response.json()) as { turnInFlight?: boolean };
				if (turnInFlight === true && !isStreamingRef.current()) attachRef.current();
			} catch { /* still offline: the next online/visible event checks again */ }
			finally { checking = false; }
		};
		const scheduleCheck = () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => { timer = null; void checkRunningTurn(); }, CHECK_DELAY_MS);
		};
		checkRef.current = scheduleCheck;
		const onVisible = () => { if (document.visibilityState === "visible") scheduleCheck(); };
		window.addEventListener("online", scheduleCheck);
		window.addEventListener("pageshow", scheduleCheck);
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			if (timer) clearTimeout(timer);
			checkRef.current = () => {};
			window.removeEventListener("online", scheduleCheck);
			window.removeEventListener("pageshow", scheduleCheck);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [chatId]);

	// The events channel reconnected (its EventSource retries on its own): check too.
	useServerResync(() => checkRef.current());
}
