"use client";

import {
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
	type RefObject,
} from "react";
import { Button } from "@/components/ui/button";
import { useSideChatSnapshot, useSideChatStore, type SideChatStore } from "@/components/side-chat-state";
import type { SideChatQuote, SideChatSource } from "@/src/core";
import {
	captureSideSelection,
	encodeSideSource,
	SIDE_SOURCE_ATTRIBUTE,
	type CapturedSideSelection,
	navigateToSideQuote,
} from "@/components/side-selection-text";

export { navigateToSideQuote };

const registered = new WeakMap<object, Set<Element>>();

function registerSource(store: object | null, element: Element, add: boolean): void {
	if (!store) return;
	let entries = registered.get(store);
	if (!entries) {
		entries = new Set();
		registered.set(store, entries);
	}
	if (add) entries.add(element);
	else entries.delete(element);
}

export function SideSource({
	source,
	enabled = true,
	children,
	className,
}: {
	source: SideChatSource;
	enabled?: boolean;
	children: ReactNode;
	className?: string;
}) {
	const store = useSideChatStore();
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const element = ref.current;
		if (!enabled || !element) return;
		registerSource(store, element, true);
		return () => registerSource(store, element, false);
	}, [enabled, store]);

	return (
		<div
			ref={ref}
			className={className}
			{...(enabled ? { [SIDE_SOURCE_ATTRIBUTE]: encodeSideSource(source) } : {})}
		>
			{children}
		</div>
	);
}

type ToolbarState = {
	capture: CapturedSideSelection;
	x: number;
	y: number;
	error?: string;
};

type SideSelectionAction = "ask" | "new" | "add";

/** Returns false when the store rejected the quote and its captured data must remain available. */
export function submitSideSelectionAction(
	store: SideChatStore,
	action: SideSelectionAction,
	quote: SideChatQuote,
): boolean {
	if (action === "add") {
		const accepted = store.addQuote(quote);
		const snapshot = store.getSnapshot();
		const draft = snapshot.activeKey ? snapshot.entries[snapshot.activeKey]?.draft : undefined;
		return accepted !== false && !snapshot.validationError && !!draft?.quotes.includes(quote);
	}

	store.openNew(quote);
	const snapshot = store.getSnapshot();
	const draft = snapshot.activeKey ? snapshot.entries[snapshot.activeKey]?.draft : undefined;
	return !snapshot.validationError && !!draft?.quotes.includes(quote);
}

/** Split out for static accessibility/action tests and predictable button ordering. */
export function SideSelectionActions({
	active,
	onAction,
}: {
	active: boolean;
	onAction: (action: SideSelectionAction) => void;
}) {
	return active ? (
		<>
			<Button type="button" size="sm" variant="outline" onClick={() => onAction("new")}>
				New question
			</Button>
			<Button type="button" size="sm" onClick={() => onAction("add")}>
				Add to current thread
			</Button>
		</>
	) : (
		<Button type="button" size="sm" onClick={() => onAction("ask")}>
			Ask
		</Button>
	);
}

export function SideSelectionAsk({ scopeRef }: { scopeRef: RefObject<HTMLElement | null> }) {
	const store = useSideChatStore();
	const snapshot = useSideChatSnapshot();
	const [state, setState] = useState<ToolbarState | null>(null);
	const stateRef = useRef<ToolbarState | null>(null);
	const toolbarRef = useRef<HTMLDivElement>(null);
	stateRef.current = state;

	const active = useMemo(
		() => snapshot.panelOpen && snapshot.activeKey !== null,
		[snapshot.panelOpen, snapshot.activeKey],
	);

	useEffect(() => {
		const scope = scopeRef.current;
		if (!scope || !store) return;
		let frame = 0;

		const update = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				const sourceElements = registered.get(store);
				const captured = captureSideSelection(window.getSelection(), null, sourceElements);
				if (!captured || !sourceElements?.has(captured.element)) {
					if (stateRef.current?.error) return;
					setState(null);
					return;
				}
				const rect = captured.range.getBoundingClientRect();
				if (!rect.width && !rect.height) {
					setState(null);
					return;
				}
				setState({
					capture: captured,
					x: rect.left,
					y: rect.bottom + 6,
				});
			});
		};

		const onPointerDown = (event: PointerEvent) => {
			const toolbar = toolbarRef.current;
			if (!toolbar?.contains(event.target as Node)) setState(null);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			const toolbar = toolbarRef.current;
			const target = event.target;
			const insideToolbar = !!toolbar && target instanceof Node && toolbar.contains(target);
			if (event.key === "Escape" && stateRef.current) {
				event.preventDefault();
				event.stopImmediatePropagation();
				setState(null);
				return;
			}
			if (insideToolbar) {
				// Let native button Enter and Tab behavior run, but keep application
				// keyboard handlers from treating toolbar keys as chat commands.
				if (event.key === "Enter" || event.key === "Tab") {
					event.stopImmediatePropagation();
				}
				return;
			}
			if (event.key !== "Tab" || !stateRef.current || !toolbar) return;
			const buttons = toolbar.querySelectorAll<HTMLButtonElement>("button:not([disabled])");
			const button = event.shiftKey ? buttons.item(buttons.length - 1) : buttons.item(0);
			if (!button) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			button.focus({ preventScroll: true });
		};

		document.addEventListener("selectionchange", update);
		document.addEventListener("scroll", update, true);
		window.addEventListener("resize", update);
		document.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("keydown", onKeyDown, true);
		return () => {
			cancelAnimationFrame(frame);
			document.removeEventListener("selectionchange", update);
			document.removeEventListener("scroll", update, true);
			window.removeEventListener("resize", update);
			document.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("keydown", onKeyDown, true);
		};
	}, [scopeRef, store]);

	useLayoutEffect(() => {
		if (!state || !toolbarRef.current) return;
		const rect = toolbarRef.current.getBoundingClientRect();
		toolbarRef.current.style.left = `${Math.max(8, Math.min(state.x, innerWidth - rect.width - 8))}px`;
		toolbarRef.current.style.top = `${Math.max(8, Math.min(state.y, innerHeight - rect.height - 8))}px`;
	}, [state]);

	if (!state || !store) return null;

	const runAction = (action: SideSelectionAction) => {
		const successful = submitSideSelectionAction(store, action, state.capture.quote);
		if (!successful) {
			const error = store.getSnapshot().validationError || "That quote could not be added. The selected text is still available.";
			const retained = { ...state, error };
			stateRef.current = retained;
			setState(retained);
			window.getSelection()?.removeAllRanges();
			return;
		}
		// Clear browser selection only after the store accepted the original
		// captured quote. Panel autofocus must not resurrect this toolbar.
		window.getSelection()?.removeAllRanges();
		setState(null);
	};

	return (
		<div
			ref={toolbarRef}
			data-side-selection-toolbar
			role="toolbar"
			aria-label="Ask about selected text"
			className="fixed z-30 flex max-w-[calc(100vw-1rem)] flex-wrap gap-1 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
			style={{ left: state.x, top: state.y }}
			onPointerDown={(event) => event.preventDefault()}
		>
			<SideSelectionActions active={active} onAction={runAction} />
			{state.error && <span role="status" className="basis-full px-2 py-1 text-xs text-destructive">{state.error}</span>}
		</div>
	);
}

export type { SideChatQuote, SideChatSource };
