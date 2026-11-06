"use client";

import { useSyncExternalStore } from "react";

export type SessionPanel = "side-chat" | "notes" | null;
const stores = new Map<string, SessionPanelStore>();

export class SessionPanelStore {
	private panel: SessionPanel = null;
	private listeners = new Set<() => void>();
	getSnapshot = () => this.panel;
	subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
	set(panel: SessionPanel) {
		if (panel === this.panel) return;
		this.panel = panel;
		for (const listener of [...this.listeners]) listener();
	}
}

export function getSessionPanelStore(chatId: string): SessionPanelStore {
	let store = stores.get(chatId);
	if (!store) { store = new SessionPanelStore(); stores.set(chatId, store); }
	return store;
}

export function useSessionPanel(chatId: string): SessionPanel {
	const store = getSessionPanelStore(chatId);
	return useSyncExternalStore(store.subscribe, store.getSnapshot, () => null);
}
