// Fork: touch support. Session rows, folders and graph nodes open their menus
// only on right-click (`contextmenu`). On a touch screen, holding a finger
// still for LONG_PRESS_MS sends that same event, so the existing menus open
// without any change to the components that own them. Android Chrome already
// sends a native contextmenu on long press (iOS Safari does not), so the timer
// waits a little longer than Android's and a native event cancels it.

export const LONG_PRESS_MS = 650;
const MOVE_TOLERANCE_PX = 10;

export function installLongPressContextMenu(root: Document = document): () => void {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let start: { x: number; y: number; pointerId: number; target: Element } | null = null;
	let swallowNextClick = false;
	let sentMenuAt = 0;

	const cancel = () => {
		if (timer) clearTimeout(timer);
		timer = null;
		start = null;
	};

	const onPointerDown = (event: PointerEvent) => {
		if (event.pointerType !== "touch" || !(event.target instanceof Element)) return;
		if (event.target.closest("input, textarea, [contenteditable='true'], [role='textbox']")) return;
		cancel();
		start = { x: event.clientX, y: event.clientY, pointerId: event.pointerId, target: event.target };
		timer = setTimeout(() => {
			if (!start) return;
			const { x, y, target } = start;
			cancel();
			const menuEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, buttons: 2, view: window });
			sentMenuAt = Date.now();
			target.dispatchEvent(menuEvent);
			// The finger lifting next would also "click" the row under it.
			swallowNextClick = true;
			setTimeout(() => { swallowNextClick = false; }, 800);
		}, LONG_PRESS_MS);
	};

	const onPointerMove = (event: PointerEvent) => {
		if (!start || event.pointerId !== start.pointerId) return;
		if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_TOLERANCE_PX) cancel();
	};

	const onNativeContextMenu = (event: MouseEvent) => {
		if (!event.isTrusted) return;
		if (Date.now() - sentMenuAt < 1000) { event.preventDefault(); event.stopPropagation(); return; }
		cancel();
	};

	const onClick = (event: MouseEvent) => {
		if (!swallowNextClick) return;
		swallowNextClick = false;
		event.preventDefault();
		event.stopPropagation();
	};

	root.addEventListener("pointerdown", onPointerDown, true);
	root.addEventListener("pointermove", onPointerMove, true);
	root.addEventListener("pointerup", cancel, true);
	root.addEventListener("pointercancel", cancel, true);
	root.addEventListener("click", onClick, true);
	root.addEventListener("contextmenu", onNativeContextMenu, true);
	return () => {
		cancel();
		root.removeEventListener("pointerdown", onPointerDown, true);
		root.removeEventListener("pointermove", onPointerMove, true);
		root.removeEventListener("pointerup", cancel, true);
		root.removeEventListener("pointercancel", cancel, true);
		root.removeEventListener("click", onClick, true);
		root.removeEventListener("contextmenu", onNativeContextMenu, true);
	};
}
