"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { existingNotesStore, type NotesStateStore } from "./notes-state";
import { Button } from "./ui/button";

type Pending = { store: NotesStateStore; navigate: () => void; retrying: boolean };
let pending: Pending | null = null;
let navigating = false;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of [...listeners]) listener(); };
function storeAt(pathname: string) {
	const id = /^\/chat\/([^/]+)$/.exec(pathname)?.[1];
	return id && id !== "new" ? existingNotesStore(decodeURIComponent(id)) : undefined;
}

/** Used by imperative router actions as well as captured same-window links. */
export async function navigateAfterNotesSave(navigate: () => void, pathname = window.location.pathname): Promise<boolean> {
	if (navigating || pending) return false;
	const store = storeAt(pathname);
	if (!store || (!store.getSnapshot().dirty && !store.getSnapshot().saving && !store.getSnapshot().conflict)) { navigate(); return true; }
	navigating = true;
	try {
		if (await store.flush()) { navigate(); return true; }
		pending = { store, navigate, retrying: false }; notify(); return false;
	} finally { navigating = false; }
}

/** Lives outside pages so a failed flush never loses its recovery surface. */
export function NotesNavigationGuard() {
	const router = useRouter();
	const request = useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => pending, () => null);
	const dialog = useRef<HTMLDivElement>(null);
	const shown = request !== null;
	useEffect(() => {
		if (!shown) return;
		const previous = document.activeElement as HTMLElement | null;
		const buttons = () => [...(dialog.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
		buttons()[0]?.focus();
		const keys = (event: KeyboardEvent) => {
			if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); if (!pending?.retrying) { pending = null; notify(); } }
			else if (event.key === "Tab") {
				event.preventDefault(); event.stopImmediatePropagation();
				const items = buttons(), index = items.indexOf(document.activeElement as HTMLButtonElement);
				items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
			}
		};
		document.addEventListener("keydown", keys, true);
		return () => { document.removeEventListener("keydown", keys, true); if (previous?.isConnected) previous.focus(); };
	}, [shown]);
	useEffect(() => {
		const beforeUnload = (event: BeforeUnloadEvent) => {
			const store = storeAt(window.location.pathname);
			if (store?.getSnapshot().dirty || store?.getSnapshot().saving) { event.preventDefault(); event.returnValue = ""; }
		};
		const click = (event: MouseEvent) => {
			if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
			const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
			if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
			const url = new URL(anchor.href, window.location.href);
			if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
			const store = storeAt(window.location.pathname);
			if (!store?.getSnapshot().dirty && !store?.getSnapshot().saving && !store?.getSnapshot().conflict) return;
			event.preventDefault(); event.stopPropagation();
			void navigateAfterNotesSave(() => router.push(`${url.pathname}${url.search}${url.hash}`));
		};
		window.addEventListener("beforeunload", beforeUnload);
		document.addEventListener("click", click, true);
		return () => { window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", click, true); };
	}, [router]);

	useEffect(() => {
		// Preserve Next state while indexing app-created history entries. A
		// blocked back/forward returns to the current entry BEFORE asking the
		// learner; replay the original pop only after save/explicit Leave.
		const history = window.history;
		const push = history.pushState;
		const replace = history.replaceState;
		let index = typeof history.state?.lhNotesIndex === "number" ? history.state.lhNotesIndex : 0;
		let currentPath = window.location.pathname;
		let replay = false;
		let restore: (() => void) | undefined;
		replace.call(history, { ...history.state, lhNotesIndex: index }, "");
		history.pushState = function (data, unused, url) {
			index++;
			push.call(this, { ...data, lhNotesIndex: index }, unused, url);
			currentPath = window.location.pathname;
		};
		history.replaceState = function (data, unused, url) {
			replace.call(this, { ...data, lhNotesIndex: index }, unused, url);
			currentPath = window.location.pathname;
		};
		const pop = (event: PopStateEvent) => {
			if (restore) { event.stopImmediatePropagation(); const done = restore; restore = undefined; done(); return; }
			const target = event.state?.lhNotesIndex as number | undefined;
			const store = storeAt(currentPath);
			if (replay || typeof target !== "number" || target === index || !store || (!store.getSnapshot().dirty && !store.getSnapshot().saving && !store.getSnapshot().conflict)) {
				replay = false; if (typeof target === "number") index = target; currentPath = window.location.pathname; return;
			}
			event.stopImmediatePropagation();
			const delta = index - target;
			const from = currentPath;
			restore = () => { void navigateAfterNotesSave(() => { replay = true; history.go(-delta); }, from); };
			history.go(delta);
		};
		window.addEventListener("popstate", pop, true);
		return () => { history.pushState = push; history.replaceState = replace; window.removeEventListener("popstate", pop, true); };
	}, []);

	if (!request) return null;
	return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onKeyDown={(event) => event.stopPropagation()}>
		<div ref={dialog} role="alertdialog" aria-modal="true" aria-label="Notes could not be saved" className="w-full max-w-md rounded-lg border border-border bg-background p-5 font-ui text-sm shadow-xl">
			<h2 className="font-semibold">Notes could not be saved</h2>
			<p className="my-3">Your local text is still here. Retry saving or resolve the conflict in Notes before leaving. Unsaved text is not guaranteed to survive restart.</p>
			<div className="flex flex-wrap justify-end gap-2">
				<Button size="sm" variant="outline" disabled={request.retrying} onClick={() => { pending = null; notify(); void request.store.open(); }}>Stay and open Notes</Button>
				<Button size="sm" variant="outline" disabled={request.retrying} onClick={() => {
					pending = { ...request, retrying: true }; notify();
					void request.store.flush().then((saved) => { pending = saved ? null : { ...request, retrying: false }; notify(); if (saved) request.navigate(); });
				}}>Retry save</Button>
				<Button size="sm" variant="destructive" disabled={request.retrying} onClick={() => { pending = null; notify(); request.navigate(); }}>Leave without saving</Button>
			</div>
		</div>
	</div>;
}
