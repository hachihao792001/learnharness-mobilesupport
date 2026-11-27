"use client";
// Fork: Remote Access (docs/REMOTE_ACCESS_ARCHITECTURE.md). Desktop-only
// settings: turn Remote Access on/off, show the address, pair and remove
// devices. Talks to Electron main through window.lh.remoteAccess only.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsRow, Toggle } from "./controls.tsx";

type RemoteAccessMessage = { code: string; message: string };

export type RemoteAccessStatus = {
	available: boolean;
	enabled?: boolean;
	state?: "off" | "starting" | "on" | "error";
	url?: string | null;
	ownerLogin?: string | null;
	error?: RemoteAccessMessage | null;
	warning?: RemoteAccessMessage | null;
	actionError?: RemoteAccessMessage;
	pairing?: { code: string; expiresAt: number } | null;
	devices?: { id: string; label: string; createdAt: number; expiresAt: number; lastSeenAt: number }[];
};

export type RemoteAccessBridge = {
	status(): Promise<RemoteAccessStatus>;
	enable(): Promise<RemoteAccessStatus>;
	disable(): Promise<RemoteAccessStatus>;
	startPairing(): Promise<RemoteAccessStatus>;
	cancelPairing(): Promise<RemoteAccessStatus>;
	revokeDevice(deviceId: string): Promise<RemoteAccessStatus>;
	onChange(callback: () => void): () => void;
};

export function remoteAccessBridge(): RemoteAccessBridge | undefined {
	if (typeof window === "undefined") return undefined;
	return (window as unknown as { lh?: { remoteAccess?: RemoteAccessBridge } }).lh?.remoteAccess;
}

/** False on the server and in any browser (the phone included): only the desktop window has the bridge. */
export function useRemoteAccessAvailable(): boolean {
	const [available, setAvailable] = useState(false);
	useEffect(() => { setAvailable(!!remoteAccessBridge()); }, []);
	return available;
}

const STATE_TEXT: Record<NonNullable<RemoteAccessStatus["state"]>, string> = {
	off: "Off",
	starting: "Turning on…",
	on: "On",
	error: "Needs attention",
};

function formatDate(time: number): string {
	return new Date(time).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatSecondsLeft(expiresAt: number, now: number): string {
	const seconds = Math.max(0, Math.round((expiresAt - now) / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

async function copyToClipboard(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

export function RemoteAccessSection() {
	const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState(false);
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		const bridge = remoteAccessBridge();
		if (!bridge) { setStatus({ available: false }); return; }
		let live = true;
		const refresh = () => { void bridge.status().then((next) => { if (live) setStatus(next); }, () => {}); };
		const stopListening = bridge.onChange(refresh);
		refresh();
		return () => { live = false; stopListening(); };
	}, []);

	const pairingExpiresAt = status?.pairing?.expiresAt;
	useEffect(() => {
		if (!pairingExpiresAt) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [pairingExpiresAt]);

	async function run(action: (bridge: RemoteAccessBridge) => Promise<RemoteAccessStatus>) {
		const bridge = remoteAccessBridge();
		if (!bridge || busy) return;
		setBusy(true);
		try { setStatus(await action(bridge)); }
		finally { setBusy(false); }
	}

	if (!status) return <p className="text-xs text-muted-foreground/70">Loading…</p>;
	if (!status.available) {
		return <p className="text-xs text-muted-foreground" data-testid="remote-access-unavailable">
			Remote Access works only in the installed desktop app, not in a development server.
		</p>;
	}

	const isOn = status.state === "on";
	const problem = status.actionError ?? status.error;
	const devices = status.devices ?? [];
	const pairingActive = !!status.pairing && status.pairing.expiresAt > now;

	return (
		<div data-testid="remote-access-section" className="flex flex-col gap-3">
			<p className="text-xs text-muted-foreground">
				Use LearnHarness from your phone through your private Tailscale network. Only your Tailscale account, on devices you pair here, can connect. Nothing is published to the internet.
			</p>
			<SettingsRow label="Remote Access" hint={STATE_TEXT[status.state ?? "off"]} testid="remote-access-toggle-row">
				<Toggle
					label="Remote Access"
					checked={!!status.enabled}
					disabled={busy || status.state === "starting"}
					onChange={(next) => void run((bridge) => (next ? bridge.enable() : bridge.disable()))}
				/>
			</SettingsRow>
			{problem && <p role="alert" className="text-xs text-destructive" data-testid="remote-access-error">{problem.message}</p>}
			{status.warning && <p className="text-xs text-muted-foreground" data-testid="remote-access-warning">{status.warning.message}</p>}

			{isOn && status.url && (
				<SettingsGroup label="Address" testid="remote-access-address">
					<div className="flex items-center gap-2">
						<code className="min-w-0 flex-1 truncate rounded-sm bg-muted/50 px-2 py-1 text-xs" data-testid="remote-access-url">{status.url}</code>
						<Button size="sm" variant="outline" onClick={() => void copyToClipboard(status.url!).then((ok) => { setCopied(ok); if (ok) setTimeout(() => setCopied(false), 1500); })}>
							{copied ? "Copied" : "Copy"}
						</Button>
					</div>
					{status.ownerLogin && <p className="text-xs text-muted-foreground">Allowed Tailscale account: {status.ownerLogin}</p>}
				</SettingsGroup>
			)}

			{isOn && (
				<SettingsGroup label="Pair a device" testid="remote-access-pairing">
					{pairingActive ? (
						<div className="flex flex-col gap-2">
							<p className="text-xs text-muted-foreground">On the phone, open the address above and enter this code. It works once and expires in {formatSecondsLeft(status.pairing!.expiresAt, now)}.</p>
							<code className="self-start rounded-md bg-muted/60 px-3 py-2 text-2xl tracking-[0.3em]" data-testid="remote-access-pairing-code">{status.pairing!.code}</code>
							<Button size="sm" variant="ghost" className="self-start" disabled={busy} onClick={() => void run((bridge) => bridge.cancelPairing())}>Cancel</Button>
						</div>
					) : (
						<Button size="sm" variant="outline" className="self-start" disabled={busy} onClick={() => void run((bridge) => bridge.startPairing())} data-testid="remote-access-start-pairing">
							Pair a device
						</Button>
					)}
				</SettingsGroup>
			)}

			{devices.length > 0 && (
				<SettingsGroup label="Paired devices" testid="remote-access-devices">
					{devices.map((device) => (
						<SettingsRow
							key={device.id}
							label={device.label}
							hint={`Paired ${formatDate(device.createdAt)} · last used ${formatDate(device.lastSeenAt)} · expires ${formatDate(device.expiresAt)}`}
						>
							<Button size="xs" variant="ghost" disabled={busy} onClick={() => void run((bridge) => bridge.revokeDevice(device.id))}>Remove</Button>
						</SettingsRow>
					))}
				</SettingsGroup>
			)}
		</div>
	);
}
