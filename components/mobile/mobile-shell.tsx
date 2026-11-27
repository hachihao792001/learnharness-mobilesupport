"use client";
// Fork: the phone layout around the existing app (docs/MOBILE_PWA.md).
// Nothing here replaces an upstream view: the bottom bar opens the existing
// sessions sidebar (as a drawer), the graph home, the existing activity list
// (in a sheet) and the existing settings dialog (full screen via mobile.css).
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ActivityIcon, BookOpenIcon, SettingsIcon, WaypointsIcon } from "lucide-react";
import { useSidebar } from "@/components/sidebar";
import { ActivitySection } from "@/components/activity-dock";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { cn } from "@/lib/utils";
import { useMobileLayout } from "./use-mobile-layout.ts";
import { installLongPressContextMenu } from "./long-press-context-menu.ts";
import { isElectronWindow, isRemoteBrowser } from "./browser-mode.ts";
import { MobileSheet } from "./mobile-sheet.tsx";
import { GraphNodeList } from "./graph-node-list.tsx";
import { RemoteNotices } from "./remote-notices.tsx";

type OpenSheet = "activity" | "graph-list" | null;

const EDITABLE = "input, textarea, select, [contenteditable='true'], [role='textbox']";

/** Mounted once inside AppShell. Renders nothing outside the phone layout. */
export function MobileShell() {
	const mobile = useMobileLayout();
	const { open: sidebarOpen, toggle: toggleSidebar } = useSidebar();
	const pathname = usePathname();
	const router = useRouter();
	const settings = useSettingsDialog();
	const [sheet, setSheet] = useState<OpenSheet>(null);
	const sidebarOpenRef = useRef(sidebarOpen);
	sidebarOpenRef.current = sidebarOpen;

	// Touch: long press opens the existing right-click menus, in any browser.
	useEffect(() => (isElectronWindow() ? undefined : installLongPressContextMenu()), []);

	// The drawer covers the page: start closed, and close after every navigation.
	useEffect(() => {
		if (mobile && sidebarOpenRef.current) toggleSidebar();
		setSheet(null);
		// Runs on navigation and on entering the phone layout only (toggleSidebar is read, not watched).
	}, [mobile, pathname]);

	// The on-screen keyboard needs the bottom bar's space: hide the bar while
	// it is up. Focus alone is not enough (the chat focuses its composer on
	// load without any keyboard), so it also needs the visible height to
	// shrink well below the height seen while not typing.
	useEffect(() => {
		if (!mobile) return;
		const root = document.documentElement;
		const visualViewport = window.visualViewport;
		let heightWithoutKeyboard = window.innerHeight;
		let widthWhenMeasured = window.innerWidth;
		const update = () => {
			const typing = !!document.activeElement?.closest(EDITABLE);
			const visibleHeight = visualViewport?.height ?? window.innerHeight;
			// Learn the full height again when not typing, or after the phone rotates.
			if (!typing || window.innerWidth !== widthWhenMeasured) {
				heightWithoutKeyboard = Math.max(window.innerHeight, visibleHeight);
				widthWhenMeasured = window.innerWidth;
			}
			root.classList.toggle("lh-keyboard-open", typing && visibleHeight < heightWithoutKeyboard * 0.8);
		};
		// focusout fires before the next element gets focus: look again a moment later.
		const updateAfterFocusMoves = () => setTimeout(update, 0);
		document.addEventListener("focusin", update);
		document.addEventListener("focusout", updateAfterFocusMoves);
		visualViewport?.addEventListener("resize", update);
		window.addEventListener("resize", update);
		return () => {
			document.removeEventListener("focusin", update);
			document.removeEventListener("focusout", updateAfterFocusMoves);
			visualViewport?.removeEventListener("resize", update);
			window.removeEventListener("resize", update);
			root.classList.remove("lh-keyboard-open");
		};
	}, [mobile]);

	if (!mobile) return isRemoteBrowser() ? <RemoteNotices /> : null;

	const onGraph = pathname === "/";
	const activeTab = sheet === "activity" ? "activity" : sidebarOpen ? "learn" : onGraph ? "graph" : pathname.startsWith("/chat") ? "learn" : null;
	const closeEverything = () => { setSheet(null); if (sidebarOpen) toggleSidebar(); };

	return (
		<>
			{sidebarOpen && <div className="lh-mobile-backdrop" aria-hidden onClick={toggleSidebar} data-testid="mobile-drawer-backdrop" />}
			<nav aria-label="Main" className="lh-mobile-bottom-nav" data-testid="mobile-bottom-nav">
				<MobileTab label="Learn" icon={<BookOpenIcon />} active={activeTab === "learn"} onClick={() => { setSheet(null); toggleSidebar(); }} />
				<MobileTab
					label="Graph"
					icon={<WaypointsIcon />}
					active={activeTab === "graph"}
					onClick={() => {
						closeEverything();
						// On the graph already, a second tap opens the searchable list.
						if (onGraph) setSheet("graph-list");
						else router.push("/");
					}}
				/>
				<MobileTab label="Activity" icon={<ActivityIcon />} active={activeTab === "activity"} onClick={() => { if (sidebarOpen) toggleSidebar(); setSheet(sheet === "activity" ? null : "activity"); }} />
				<MobileTab label="Settings" icon={<SettingsIcon />} active={false} onClick={() => { closeEverything(); settings.open(); }} />
			</nav>
			{sheet === "activity" && (
				<MobileSheet title="Activity" onClose={() => setSheet(null)} testid="mobile-activity-sheet">
					<ActivitySection />
				</MobileSheet>
			)}
			{sheet === "graph-list" && (
				<MobileSheet title="Knowledge graph" onClose={() => setSheet(null)} testid="mobile-graph-list-sheet">
					<GraphNodeList onOpenSession={(chatId) => { setSheet(null); router.push(`/chat/${encodeURIComponent(chatId)}`); }} />
				</MobileSheet>
			)}
			<RemoteNotices />
		</>
	);
}

function MobileTab({ label, icon, active, onClick }: { label: string; icon: React.ReactNode; active: boolean; onClick: () => void }) {
	return (
		<button
			type="button"
			aria-current={active ? "page" : undefined}
			onClick={onClick}
			data-testid={`mobile-tab-${label.toLowerCase()}`}
			className={cn("lh-mobile-tab", active && "lh-mobile-tab-active")}
		>
			<span aria-hidden className="[&_svg]:size-5">{icon}</span>
			<span>{label}</span>
		</button>
	);
}
