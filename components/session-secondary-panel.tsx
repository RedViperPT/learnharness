"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export const SIDE_PANEL_OVERLAY_THRESHOLD = 800;
export function clampSideChatWidth(width: number, available: number): number {
	return Math.max(320, Math.min(Math.round(width), Math.floor(available / 2)));
}
let preferredWidth = 400;

/** The shared layout and keyboard boundary. Content owns its own draft/network state. */
export function SessionSecondaryPanel({ chatId, label, id, testId, obscured = false, onEscape, children }: {
	chatId: string; label: string; id: string; testId: string; obscured?: boolean;
	onEscape: () => void; children: ReactNode;
}) {
	const [width, setWidth] = useState(preferredWidth);
	const [available, setAvailable] = useState(0);
	const drag = useRef<{ x: number; width: number } | null>(null);
	const dismiss = useRef(onEscape);
	dismiss.current = onEscape;
	const overlay = available < SIDE_PANEL_OVERLAY_THRESHOLD;
	const shownWidth = clampSideChatWidth(width, available);
	useLayoutEffect(() => {
		const shell = document.querySelector<HTMLElement>("[data-session-shell]");
		if (!shell) return;
		const measure = () => setAvailable(shell.getBoundingClientRect().width);
		measure();
		if (typeof ResizeObserver === "undefined") { window.addEventListener("resize", measure); return () => window.removeEventListener("resize", measure); }
		const observer = new ResizeObserver(measure);
		observer.observe(shell);
		return () => observer.disconnect();
	}, [chatId]);
	useEffect(() => {
		if (obscured) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			event.preventDefault(); event.stopPropagation(); dismiss.current();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [obscured]);
	const changeWidth = (next: number) => { preferredWidth = clampSideChatWidth(next, available); setWidth(preferredWidth); };
	return <aside id={id} aria-label={label} data-testid={testId} data-layout={overlay ? "overlay" : "column"} inert={obscured}
		className={`flex min-h-0 shrink-0 flex-col border-l border-border bg-background ${overlay ? "absolute inset-0 z-30 w-full" : "relative"}`}
		style={overlay ? undefined : { width: shownWidth }}
		onKeyDown={(event) => {
			if (obscured) return;
			if (!event.metaKey && !event.ctrlKey && !event.altKey) event.stopPropagation();
			if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss.current(); }
		}}>
		{!overlay && <div role="separator" aria-orientation="vertical" aria-label={`Resize ${label.toLowerCase()}`} aria-controls={id}
			aria-valuemin={320} aria-valuemax={Math.floor(available / 2)} aria-valuenow={shownWidth} tabIndex={0}
			className="absolute inset-y-0 -left-0.5 z-10 w-1 select-none touch-none cursor-col-resize hover:bg-muted-foreground/50 focus-visible:bg-muted-foreground"
			onPointerDown={(event) => { drag.current = { x: event.clientX, width: shownWidth }; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }}
			onPointerMove={(event) => { if (drag.current) changeWidth(drag.current.width + drag.current.x - event.clientX); }}
			onPointerUp={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
			onKeyDown={(event) => {
				if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
				event.preventDefault();
				changeWidth(event.key === "Home" ? 320 : event.key === "End" ? available / 2 : shownWidth + (event.key === "ArrowLeft" ? 24 : -24));
			}} />}
		{children}
	</aside>;
}
