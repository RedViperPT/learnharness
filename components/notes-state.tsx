"use client";

import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { NOTES_MAX_BYTES, NOTES_SAVE_DELAY_MS, notesByteLength, noteQuoteMarkdown, type NoteOrganizerEvent, type SessionNotesView, type SideChatQuote } from "@/src/core";
import { getSessionPanelStore } from "./session-panel-state";

export interface NoteOrganizationProposal {
	id: string;
	baseRevision: number;
	original: string;
	markdown: string;
	model: string;
	stale: boolean;
	complete: boolean;
	generating: boolean;
	error?: string;
}
export interface NotesState {
	markdown: string;
	revision: number;
	updatedAt: string | null;
	loaded: boolean;
	loading: boolean;
	saving: boolean;
	dirty: boolean;
	applying: boolean;
	preparing: boolean;
	error?: string;
	errorAction?: "refresh" | "save" | "apply";
	conflict?: SessionNotesView;
	organizer?: NoteOrganizationProposal;
	mode: "write" | "preview" | "organizer";
	organizerSource: boolean;
	comparisonTab: "original" | "proposed";
	/** Only an accepted Apply adds a full-document replacement to editor history. */
	replacement: number;
	focus?: { from: number; to: number; sequence: number };
}
const empty: NotesState = { markdown: "", revision: 0, updatedAt: null, loaded: false, loading: false, saving: false, dirty: false, applying: false, preparing: false, mode: "write", organizerSource: false, comparisonTab: "proposed", replacement: 0 };
const stores = new Map<string, NotesStateStore>();
export function getNotesStore(chatId: string): NotesStateStore {
	let store = stores.get(chatId);
	if (!store) { store = new NotesStateStore(chatId); stores.set(chatId, store); }
	return store;
}
export function existingNotesStore(chatId: string): NotesStateStore | undefined { return stores.get(chatId); }

function validNotes(value: unknown): value is SessionNotesView {
	if (!value || typeof value !== "object") return false;
	const item = value as SessionNotesView;
	return typeof item.markdown === "string" && Number.isSafeInteger(item.revision) && item.revision >= 0 && (item.updatedAt === null || typeof item.updatedAt === "string");
}
function failure(body: unknown, status: number): string {
	const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
	return typeof error === "string" ? error : `The notes request failed (${status}).`;
}

/** Session-keyed local documents and transports survive view/panel unmounts.
 * Only confirmed server writes are durable across reload/restart. */
export class NotesStateStore {
	private state: NotesState = empty;
	private listeners = new Set<() => void>();
	private timer?: ReturnType<typeof setTimeout>;
	private saveTask?: Promise<boolean>;
	private loadTask?: Promise<boolean>;
	private version = 0;
	private confirmed = "";
	private controller?: AbortController;
	private refreshSequence = 0;
	constructor(readonly chatId: string) {}
	getSnapshot = () => this.state;
	subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
	private update(patch: Partial<NotesState>) { this.state = { ...this.state, ...patch }; for (const listener of [...this.listeners]) listener(); }
	private base() { return `/api/chats/${encodeURIComponent(this.chatId)}/notes`; }
	private stale() { return this.state.organizer ? { ...this.state.organizer, stale: true } : undefined; }
	private clearTimer() { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }

	setMode(mode: NotesState["mode"]) { this.update({ mode }); }
	setOrganizerSource(organizerSource: boolean) { this.update({ organizerSource }); }
	setComparisonTab(comparisonTab: NotesState["comparisonTab"]) { this.update({ comparisonTab }); }
	retry(): Promise<boolean> {
		return this.state.errorAction === "apply" ? this.apply() : this.state.errorAction === "refresh" ? this.refresh() : this.flush();
	}
	async open(): Promise<boolean> {
		getSessionPanelStore(this.chatId).set("notes");
		return this.refresh();
	}
	close() { void this.flush(); if (getSessionPanelStore(this.chatId).getSnapshot() === "notes") getSessionPanelStore(this.chatId).set(null); }
	async ensureLoaded(): Promise<boolean> { return this.state.loaded || this.refresh(); }

	async refresh(): Promise<boolean> {
		// Apply owns canonical adoption until its acknowledgement. A focus or
		// panel-open GET could otherwise observe that write early and replace
		// the editor outside Apply's single undoable transaction.
		if (this.state.applying) return true;
		return this.refreshCanonical();
	}
	private async refreshCanonical(): Promise<boolean> {
		if (this.saveTask) await this.saveTask;
		if (this.loadTask) return this.loadTask;
		const sequence = ++this.refreshSequence;
		const version = this.version;
		const revision = this.state.revision;
		this.update({ loading: true });
		this.loadTask = (async () => {
			try {
				const response = await fetch(this.base(), { cache: "no-store" });
				const notes: unknown = await response.json();
				if (!response.ok) throw new Error(failure(notes, response.status));
				if (!validNotes(notes)) throw new Error("Invalid notes response.");
				if (sequence !== this.refreshSequence || revision !== this.state.revision) return true;
				if (this.state.dirty || version !== this.version || this.state.conflict) {
					if (notes.revision !== this.state.revision) { this.clearTimer(); this.update({ conflict: notes, organizer: this.stale() }); }
					return true;
				}
				this.confirmed = notes.markdown;
				this.update({ ...notes, loaded: true, error: undefined, organizer: notes.revision !== this.state.revision || notes.markdown !== this.state.markdown ? this.stale() : this.state.organizer });
				return true;
			} catch (error) {
				this.update({ error: error instanceof Error ? error.message : "Could not load notes.", errorAction: "refresh" }); return false;
			} finally { this.update({ loading: false }); this.loadTask = undefined; }
		})();
		return this.loadTask;
	}

	edit(markdown: string): void {
		if (!this.state.loaded || this.state.applying || markdown === this.state.markdown) return;
		this.version++;
		this.update({ markdown, dirty: markdown !== this.confirmed, organizer: this.stale(), error: undefined });
		this.clearTimer();
		if (this.state.dirty && !this.state.conflict) this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, NOTES_SAVE_DELAY_MS);
	}

	async flush(): Promise<boolean> {
		this.clearTimer();
		if (!await this.ensureLoaded()) return false;
		// A focus GET and our own PUT must not race into a false conflict
		// when the GET sees that PUT before its acknowledgement arrives.
		if (this.loadTask && !await this.loadTask) return false;
		if (this.state.conflict) return false;
		if (this.saveTask) return this.saveTask;
		if (!this.state.dirty) return true;
		this.saveTask = this.saveLoop().finally(() => { this.saveTask = undefined; });
		return this.saveTask;
	}
	private async saveLoop(): Promise<boolean> {
		this.update({ saving: true, error: undefined });
		try {
			while (this.state.dirty && !this.state.conflict) {
				const markdown = this.state.markdown;
				if (notesByteLength(markdown) > NOTES_MAX_BYTES) throw new Error("Notes exceed the 512 KiB limit. Shorten them before saving; nothing has been truncated.");
				const response = await fetch(this.base(), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ markdown, expectedRevision: this.state.revision }) });
				const body: unknown = await response.json();
				if (response.status === 409) {
					const notes = (body as { notes?: unknown })?.notes;
					if (!validNotes(notes)) throw new Error("Could not read the conflicting server version.");
					this.clearTimer(); this.update({ conflict: notes, organizer: this.stale() }); return false;
				}
				if (!response.ok) throw new Error(failure(body, response.status));
				if (!validNotes(body)) throw new Error("Invalid notes save response.");
				this.confirmed = body.markdown;
				// Do not replace edits typed while this request was in flight.
				this.update({ revision: body.revision, updatedAt: body.updatedAt, dirty: this.state.markdown !== body.markdown });
			}
			return !this.state.conflict;
		} catch (error) { this.update({ error: error instanceof Error ? error.message : "Could not save notes. Your local text has been kept.", errorAction: "save" }); return false; }
		finally { this.clearTimer(); this.update({ saving: false }); }
	}

	keepServer(): void {
		const notes = this.state.conflict;
		if (!notes || this.state.applying || this.state.saving) return;
		this.clearTimer(); this.version++; this.confirmed = notes.markdown;
		this.update({ ...notes, loaded: true, dirty: false, conflict: undefined, error: undefined, organizer: this.stale() });
	}
	async keepMine(): Promise<boolean> {
		const notes = this.state.conflict;
		if (!notes || this.state.applying || this.state.saving) return false;
		this.confirmed = notes.markdown;
		this.update({ revision: notes.revision, updatedAt: notes.updatedAt, conflict: undefined, dirty: true, error: undefined });
		return this.flush(); // another intervening save will honestly conflict again
	}

	async addQuote(quote: SideChatQuote): Promise<boolean> {
		if (!await this.ensureLoaded() || this.state.applying) return false;
		const insertion = `${this.state.markdown ? "\n\n" : ""}${noteQuoteMarkdown(quote)}`;
		const from = this.state.markdown.length;
		const markdown = this.state.markdown + insertion;
		if (notesByteLength(markdown) > NOTES_MAX_BYTES) { this.update({ error: "The quotation would exceed the 512 KiB notes limit.", errorAction: undefined }); return false; }
		this.edit(markdown);
		this.update({ mode: "write", focus: { from: from + (from ? 2 : 0), to: markdown.length, sequence: (this.state.focus?.sequence ?? 0) + 1 } });
		getSessionPanelStore(this.chatId).set("notes");
		return true;
	}

	async organize(): Promise<boolean> {
		if (this.controller || this.state.applying || this.state.preparing) return false;
		const controller = new AbortController(); this.controller = controller;
		this.update({ preparing: true, error: undefined });
		let terminal = false;
		try {
			if (!await this.flush() || !await this.refresh() || this.state.conflict || controller.signal.aborted) return false;
			if (this.state.dirty) { this.update({ error: "Your notes changed while preparing organization. Save them and try again.", errorAction: "save" }); return false; }
			const { markdown: original, revision } = this.state;
			if (!original.trim()) { this.update({ error: "Write some notes before organizing.", errorAction: undefined }); return false; }
			this.update({ mode: "organizer", organizer: { id: "", baseRevision: revision, original, markdown: "", model: "", stale: false, complete: false, generating: true } });
			const response = await fetch(`${this.base()}/organize`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision }), signal: controller.signal });
			if (!response.ok) throw new Error(failure(await response.json().catch(() => null), response.status));
			if (!response.body) throw new Error("The organizer did not return a stream.");
			const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
			const event = (line: string) => {
				if (!line.trim() || terminal) return;
				const value = JSON.parse(line) as NoteOrganizerEvent;
				const proposal = this.state.organizer;
				if (!proposal) throw new Error("Organizer preview is unavailable.");
				if (value.type === "start") {
					if (value.baseRevision !== revision) throw new Error("Invalid organizer snapshot revision.");
					this.update({ organizer: { ...proposal, id: value.proposalId, model: value.model } });
				} else if (value.type === "text") this.update({ organizer: { ...proposal, markdown: value.text } });
				else if (value.type === "done") {
					if (!value.text.trim() || notesByteLength(value.text) > NOTES_MAX_BYTES || !proposal.id) throw new Error("The organizer returned an invalid proposal.");
					terminal = true; this.update({ organizer: { ...proposal, markdown: value.text, complete: true, generating: false } });
				} else if (value.type === "error") { terminal = true; this.update({ organizer: { ...proposal, error: value.error, complete: false, generating: false } }); }
				else throw new Error("Invalid organizer event.");
			};
			try {
				while (true) {
					const part = await reader.read();
					buffer += decoder.decode(part.value, { stream: !part.done });
					const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
					for (const line of lines) event(line);
					if (part.done) { if (buffer.trim()) event(buffer); break; }
				}
			} finally { reader.releaseLock(); }
			if (!terminal) throw new Error("The organizer stream ended before completion. Partial text cannot be applied.");
			return this.state.organizer?.complete ?? false;
		} catch (error) {
			const message = controller.signal.aborted ? "Organization stopped. Partial text cannot be applied." : error instanceof Error ? error.message : "Organization failed.";
			if (this.state.organizer?.generating) this.update({ organizer: { ...this.state.organizer, error: message, complete: false, generating: false } });
			else this.update({ error: message, errorAction: undefined });
			return false;
		} finally {
			this.controller = undefined; this.update({ preparing: false });
		}
	}
	stop() { this.controller?.abort(); }
	discardProposal() { if (!this.state.preparing && !this.state.organizer?.generating) this.update({ organizer: undefined, mode: "write" }); }

	async apply(): Promise<boolean> {
		const proposal = this.state.organizer;
		if (!proposal?.complete || proposal.stale || this.state.dirty || this.state.conflict || this.state.applying || proposal.baseRevision !== this.state.revision) return false;
		this.update({ applying: true, error: undefined });
		try {
			if (!await this.flush() || !await this.refreshCanonical() || this.state.organizer?.stale || proposal.baseRevision !== this.state.revision || this.state.conflict) return false;
			const response = await fetch(this.base(), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ markdown: proposal.markdown, expectedRevision: proposal.baseRevision }) });
			const body: unknown = await response.json();
			if (response.status === 409) {
				const notes = (body as { notes?: unknown })?.notes;
				if (validNotes(notes)) this.update({ organizer: this.stale() });
				throw new Error("Your notes changed after this proposal was created. Organize the latest version again before applying it.");
			}
			if (!response.ok) throw new Error(failure(body, response.status));
			if (!validNotes(body)) throw new Error("Invalid notes save response.");
			this.version++; this.confirmed = body.markdown;
			this.update({ ...body, dirty: false, organizer: undefined, mode: "write", replacement: this.state.replacement + 1 });
			return true;
		} catch (error) { this.update({ error: error instanceof Error ? error.message : "Could not apply the proposal.", errorAction: this.state.organizer?.stale ? undefined : "apply" }); return false; }
		finally { this.update({ applying: false }); }
	}
}

const Context = createContext<NotesStateStore | null>(null);
export function NotesProvider({ chatId, children }: { chatId: string; children: ReactNode }) {
	const store = useMemo(() => getNotesStore(chatId), [chatId]);
	return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useNotesStore() { return useContext(Context); }
export function useNotesSnapshot() {
	const store = useNotesStore();
	return useSyncExternalStore(store?.subscribe ?? (() => () => {}), store?.getSnapshot ?? (() => empty), () => empty);
}
