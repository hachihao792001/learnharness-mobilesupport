"use client";
// Fork: a bottom sheet for the phone layout (activity list, graph node list).
// Escape and the backdrop close it; it sits above the bottom bar.
import { useEffect } from "react";
import { XIcon } from "lucide-react";

export function MobileSheet({ title, onClose, testid, children }: { title: string; onClose: () => void; testid?: string; children: React.ReactNode }) {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onClose]);
	return (
		<>
			<div className="lh-mobile-backdrop" aria-hidden onClick={onClose} />
			<section role="dialog" aria-modal="true" aria-label={title} data-testid={testid} className="lh-mobile-sheet">
				<header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
					<h2 className="font-title text-xl tracking-tight">{title}</h2>
					<button type="button" aria-label={`Close ${title}`} onClick={onClose} className="flex size-10 items-center justify-center rounded-md text-muted-foreground hover:bg-accent">
						<XIcon className="size-4" />
					</button>
				</header>
				<div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
			</section>
		</>
	);
}
