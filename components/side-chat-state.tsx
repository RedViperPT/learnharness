"use client";

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { SideChatQuote, SideChatThread } from "@/src/core";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { getSessionPanelStore } from "./session-panel-state";

const QUESTION_MAX_CHARS = 8_000;
const QUOTE_MAX_CHARS = 8_000;
const QUOTES_MAX = 5;
const EXTERNAL_POLL_MS = 2_500;
const EMPTY_DRAFT = Object.freeze({ text: "", quotes: Object.freeze([]) as unknown as SideChatQuote[] });

export type SideChatDraft = { text: string; quotes: SideChatQuote[] };

export type SideChatEntry = {
	thread?: SideChatThread;
	draft?: SideChatDraft;
	error?: string;
	sending: boolean;
	/** Full replacement live answer; never stored in messages until done. */
	answer?: string;
};

export type SideChatSnapshot = {
	panelOpen: boolean;
	activeKey: string | null;
	/** Keys are client identities and never change when a thread is saved. */
	entries: Record<string, SideChatEntry>;
	validationError: string;
	/** Changes only for explicit new-question/add-quote focus requests. */
	focusRevision: number;
};

export interface SideChatStore {
	getSnapshot(): SideChatSnapshot;
	subscribe(listener: () => void): () => void;
	openNew(quote?: SideChatQuote): string;
	addQuote(quote: SideChatQuote): boolean;
	setOpen(open: boolean): void;
	setActive(key: string | null): void;
	setDraft(key: string, value: SideChatDraft): void;
	setThreads(threads: SideChatThread[], answering?: Record<string, string>): void;
	patchThread(thread: SideChatThread): void;
	setAnswering(answering: Record<string, string>): void;
	ask(key: string, opts?: { retry?: boolean }): Promise<boolean>;
	stop(key: string): Promise<void>;
	remove(key: string): Promise<boolean>;
	refresh(): Promise<void>;
}

const emptySnapshot: SideChatSnapshot = {
	panelOpen: false,
	activeKey: null,
	entries: {},
	validationError: "",
	focusRevision: 0,
};

const stores = new Map<string, SideChatStateStore>();
let draftSequence = 0;

export function getSideChatStore(chatId: string): SideChatStateStore {
	let store = stores.get(chatId);
	if (!store) {
		store = new SideChatStateStore(chatId);
		stores.set(chatId, store);
	}
	return store;
}

type StreamEvent =
	| { type: "thread"; thread: SideChatThread }
	| { type: "text"; text: string }
	| { type: "done"; thread: SideChatThread }
	| { type: "error"; error: string };

function errorText(raw: unknown, status: number): string {
	if (raw && typeof raw === "object") {
		const item = raw as { error?: unknown; message?: unknown };
		if (typeof item.error === "string" && item.error.trim()) return item.error;
		if (typeof item.message === "string" && item.message.trim()) return item.message;
	}
	return status ? `The side question failed (${status}).` : "Could not reach the app server.";
}

function validDraft(draft: SideChatDraft): string {
	if (draft.text.length > QUESTION_MAX_CHARS) return `Question text must be ${QUESTION_MAX_CHARS.toLocaleString()} characters or fewer.`;
	if (draft.quotes.length > QUOTES_MAX) return `A question can include at most ${QUOTES_MAX} quotes.`;
	if (draft.quotes.some((quote) => quote.text.length > QUOTE_MAX_CHARS)) return `Quotes must be ${QUOTE_MAX_CHARS.toLocaleString()} characters or fewer.`;
	return "";
}

function lineEvents(buffer: string, final: boolean): { lines: string[]; rest: string } {
	const pieces = buffer.split("\n");
	const tail = pieces.pop() ?? "";
	const lines = pieces.filter((line) => line.trim().length > 0);
	if (final && tail.trim()) lines.push(tail);
	return { lines, rest: final ? "" : tail };
}

type SideChatAttempt = {
	requestId: string;
	firstQuestion: boolean;
	submitted?: SideChatDraft;
	acknowledged: boolean;
	transportActive: boolean;
	recoveryError?: string;
};

/** One in-memory state and transport owner per session id. */
export class SideChatStateStore implements SideChatStore {
	readonly chatId: string;
	private snapshot: SideChatSnapshot = emptySnapshot;
	private listeners = new Set<() => void>();
	private mutationRevision = 0;
	private refreshSequence = 0;
	private draftKeys = 0;
	private locallyRead = new Set<string>();
	private tombstones = new Set<string>();
	private mountCount = 0;
	private pollTimer: ReturnType<typeof setTimeout> | null = null;
	private externalRuns = new Set<string>();
	private attempts = new Map<string, SideChatAttempt>();

	constructor(chatId: string) {
		this.chatId = chatId;
		const panel = getSessionPanelStore(chatId);
		this.snapshot = { ...emptySnapshot, panelOpen: panel.getSnapshot() === "side-chat" };
		panel.subscribe(() => this.update({ panelOpen: panel.getSnapshot() === "side-chat" }));
	}

	getSnapshot = (): SideChatSnapshot => this.snapshot;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private update(patch: Partial<SideChatSnapshot>, mutation = false): void {
		if (mutation) this.mutationRevision++;
		this.snapshot = { ...this.snapshot, ...patch };
		for (const listener of [...this.listeners]) listener();
	}

	private base(): string {
		return `/api/chats/${encodeURIComponent(this.chatId)}/side-chats`;
	}

	private updateEntry(key: string, patch: Partial<SideChatEntry>, mutation = false): void {
		const entry = this.snapshot.entries[key];
		if (!entry) return;
		this.update({ entries: { ...this.snapshot.entries, [key]: { ...entry, ...patch } } }, mutation);
	}

	private keyForThread(thread: SideChatThread, entries = this.snapshot.entries): string {
		const saved = Object.keys(entries).find((key) => entries[key]?.thread?.id === thread.id);
		if (saved) return saved;
		if (thread.creationRequestId) {
			for (const [key, attempt] of this.attempts) {
				if (attempt.firstQuestion && attempt.requestId === thread.creationRequestId && entries[key] && !entries[key].thread) return key;
			}
		}
		return thread.id;
	}

	/** Acceptance is applied once, whichever transport proves it first. */
	private acknowledge(entry: SideChatEntry, attempt?: SideChatAttempt): SideChatEntry {
		if (!attempt) return entry;
		// Exact recovery may dismiss its own transport warning, not a failed stop/delete.
		if (attempt.recoveryError && entry.error === attempt.recoveryError) entry = { ...entry, error: undefined };
		if (attempt.acknowledged) return entry;
		attempt.acknowledged = true;
		const current = entry.draft;
		const sent = attempt.submitted;
		// Clear submitted fields independently, preserving admission-time edits and new quotes.
		return {
			...entry,
			...(current && sent ? { draft: {
				text: current.text === sent.text ? "" : current.text,
				quotes: current.quotes.filter((quote) => !sent.quotes.includes(quote)),
			} } : {}),
		};
	}

	private upsertThread(thread: SideChatThread): void {
		if (this.tombstones.has(thread.id)) return;
		const key = this.keyForThread(thread);
		const entry = this.acknowledge(this.snapshot.entries[key] ?? { sending: false }, this.creationAttempt(key, thread));
		this.update({ entries: { ...this.snapshot.entries, [key]: { ...entry, thread } } }, true);
	}

	private creationAttempt(key: string, thread: SideChatThread): SideChatAttempt | undefined {
		const attempt = this.attempts.get(key);
		return attempt?.firstQuestion && attempt.requestId === thread.creationRequestId ? attempt : undefined;
	}

	private newDraftKey(): string {
		return `draft:${this.chatId}:${++draftSequence}:${++this.draftKeys}`;
	}

	openNew(quote?: SideChatQuote): string {
		getSessionPanelStore(this.chatId).set("side-chat");
		const key = this.newDraftKey();
		const draft: SideChatDraft = { text: "", quotes: quote ? [quote] : [] };
		this.update({
			panelOpen: true,
			activeKey: key,
			entries: { ...this.snapshot.entries, [key]: { draft, sending: false } },
			validationError: validDraft(draft),
			focusRevision: this.snapshot.focusRevision + 1,
		});
		return key;
	}

	addQuote(quote: SideChatQuote): boolean {
		const key = this.snapshot.activeKey;
		if (!key) {
			this.openNew(quote);
			return true;
		}
		const current = this.snapshot.entries[key]?.draft ?? EMPTY_DRAFT;
		if (current.quotes.length >= QUOTES_MAX || quote.text.length > QUOTE_MAX_CHARS) {
			this.update({ validationError: current.quotes.length >= QUOTES_MAX ? `A question can include at most ${QUOTES_MAX} quotes.` : `Quotes must be ${QUOTE_MAX_CHARS.toLocaleString()} characters or fewer.` });
			return false;
		}
		this.setDraft(key, { ...current, quotes: [...current.quotes, quote] });
		this.update({ focusRevision: this.snapshot.focusRevision + 1 });
		return true;
	}

	setOpen(open: boolean): void {
		const panel = getSessionPanelStore(this.chatId);
		if (open) panel.set("side-chat");
		else if (panel.getSnapshot() === "side-chat") panel.set(null);
	}

	setActive(key: string | null): void {
		const activeKey = key && this.snapshot.entries[key] ? key : null;
		this.update({ activeKey, validationError: activeKey ? validDraft(this.snapshot.entries[activeKey]?.draft ?? EMPTY_DRAFT) : "" });
	}

	setDraft(key: string, value: SideChatDraft): void {
		this.updateEntry(key, { draft: { text: value.text, quotes: [...value.quotes] }, error: undefined });
		if (this.snapshot.activeKey === key) this.update({ validationError: validDraft(value) });
	}

	/** Compatibility seam for earlier panel integrations. */
	setThreads(threads: SideChatThread[], answering?: Record<string, string>): void {
		this.replaceThreads(threads, answering ?? Object.fromEntries(Object.values(this.snapshot.entries)
			.filter((entry) => entry.thread && entry.answer !== undefined).map((entry) => [entry.thread!.id, entry.answer!])), true);
	}

	patchThread(thread: SideChatThread): void {
		this.upsertThread(thread);
	}

	setAnswering(answering: Record<string, string>): void {
		const entries = { ...this.snapshot.entries };
		for (const [key, entry] of Object.entries(entries)) {
			if (entry.thread && !(this.locallyRead.has(entry.thread.id) && entry.answer !== undefined)) {
				entries[key] = { ...entry, answer: answering[entry.thread.id] };
			}
		}
		this.update({ entries });
	}

	private replaceThreads(threads: SideChatThread[], answering: Record<string, string>, mutation = false): void {
		const entries = { ...this.snapshot.entries };
		const visible = threads.filter((thread) => !this.tombstones.has(thread.id));
		const ids = new Set(visible.map((thread) => thread.id));
		let activeKey = this.snapshot.activeKey;
		for (const [key, entry] of Object.entries(entries)) {
			if (!entry.thread || ids.has(entry.thread.id)) continue;
			this.attempts.delete(key);
			this.locallyRead.delete(entry.thread.id);
			if (entry.draft) entries[key] = { draft: entry.draft, sending: false };
			else {
				delete entries[key];
				if (activeKey === key) activeKey = null;
			}
		}
		for (const thread of visible) {
			const key = this.keyForThread(thread, entries);
			const entry = this.acknowledge(entries[key] ?? { sending: false }, this.creationAttempt(key, thread));
			const answer = this.locallyRead.has(thread.id) && entry.answer !== undefined ? entry.answer : answering[thread.id];
			entries[key] = { ...entry, thread, answer };
			if (this.attempts.get(key)?.transportActive === false) this.attempts.delete(key);
		}
		this.update({ entries, activeKey, validationError: activeKey ? validDraft(entries[activeKey]?.draft ?? EMPTY_DRAFT) : "" }, mutation);
	}

	async ask(key: string, opts: { retry?: boolean } = {}): Promise<boolean> {
		const entry = this.snapshot.entries[key];
		if (!entry || entry.sending || entry.answer !== undefined) return false;
		const retry = opts.retry === true;
		const thread = entry.thread;
		const savedId = thread?.id;
		if (this.tombstones.has(savedId ?? "")) return false;

		const draft = entry.draft ?? EMPTY_DRAFT;
		const validation = retry ? "" : validDraft(draft);
		if (validation) {
			this.update({ validationError: validation });
			return false;
		}
		if (retry) {
			if (!thread) return false;
			const last = thread.messages.at(-1);
			const retryable = last?.role === "user" || (last?.role === "assistant" && last.error !== undefined);
			if (!retryable) return false;
		} else {
			if (!draft.text.trim()) return false;
			const last = thread?.messages.at(-1);
			if (last?.role === "user") return false;
		}

		const submitted: SideChatDraft = { text: draft.text, quotes: [...draft.quotes] };
		const requestId = `${Date.now()}_${crypto.randomUUID()}`;
		const attempt: SideChatAttempt = { requestId, firstQuestion: !thread, submitted: retry ? undefined : submitted, acknowledged: false, transportActive: true };
		this.attempts.set(key, attempt);
		this.updateEntry(key, { sending: true, error: undefined });
		this.update({ validationError: "" });
		const body = retry
			? { requestId, threadId: thread!.id, retry: true }
			: { requestId, ...(savedId ? { threadId: savedId } : {}), text: submitted.text.trim(), quotes: submitted.quotes };

		let response: Response;
		try {
			response = await fetch(this.base(), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		} catch (cause) {
			// Keep first-request correlation: the server may have saved it despite a lost response.
			attempt.transportActive = false;
			if (this.attempts.get(key) === attempt) {
				if (!attempt.acknowledged) attempt.recoveryError = errorText(cause, 0);
				this.updateEntry(key, { sending: false, ...(attempt.recoveryError ? { error: attempt.recoveryError } : {}) });
				void this.refresh();
			}
			return false;
		}

		if (response.ok && response.headers.get("Content-Type")?.includes("application/json")) {
			const detail = await response.json().catch(() => null) as { cancelled?: boolean } | null;
			if (detail?.cancelled) {
				if (this.attempts.get(key) === attempt) {
					this.attempts.delete(key);
					this.updateEntry(key, { sending: false });
				}
				return false;
			}
		}
		if (!response.ok || !response.body) {
			const detail = await response.json().catch(() => null) as unknown;
			const message = errorText(detail, response.status);
			if (this.attempts.get(key) === attempt) {
				this.attempts.delete(key);
				this.updateEntry(key, { sending: false, error: message });
			}
			void this.refresh();
			return false;
		}

		if (this.attempts.get(key) !== attempt || !this.snapshot.entries[key]) {
			void response.body.cancel();
			return false;
		}
		const accepted = this.acknowledge(this.snapshot.entries[key]!, attempt);
		this.updateEntry(key, accepted);
		if (this.snapshot.activeKey === key) this.update({ validationError: validDraft(accepted.draft ?? EMPTY_DRAFT) });
		void this.consumeStream(key, attempt, response.body);
		return true;
	}

	private async consumeStream(key: string, attempt: SideChatAttempt, body: ReadableStream<Uint8Array>): Promise<void> {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let threadId: string | null = null;
		let terminal = false;
		const current = () => this.attempts.get(key) === attempt && !!this.snapshot.entries[key];

		const apply = (event: StreamEvent): void => {
			if (!current()) return;
			if (!event || typeof event !== "object" || typeof event.type !== "string") throw new Error("Invalid event");
			if (event.type === "thread" || event.type === "done") {
				if (!event.thread || typeof event.thread.id !== "string") throw new Error("Invalid thread event");
				const incoming = event.thread;
				if (this.tombstones.has(incoming.id)) return;
				threadId = incoming.id;
				this.updateEntry(key, { thread: incoming }, true);
				if (event.type === "thread") {
					this.locallyRead.add(incoming.id);
					this.updateEntry(key, { answer: "", sending: false });
				}
				if (event.type === "done") {
					terminal = true;
					this.locallyRead.delete(incoming.id);
					this.updateEntry(key, { answer: undefined, error: undefined, sending: false });
				}
			} else if (event.type === "text") {
				if (typeof event.text !== "string" || !threadId || this.tombstones.has(threadId)) return;
				this.updateEntry(key, { answer: event.text });
			} else if (event.type === "error") {
				terminal = true;
				this.updateEntry(key, { error: event.error, answer: undefined });
			} else {
				throw new Error("Unknown event type");
			}
		};

		try {
			while (true) {
				const part = await reader.read();
				if (part.done) break;
				buffer += decoder.decode(part.value, { stream: true });
				const parsed = lineEvents(buffer, false);
				buffer = parsed.rest;
				for (const line of parsed.lines) {
					try { apply(JSON.parse(line) as StreamEvent); }
					catch { /* the canonical refresh repairs malformed or unknown frames */ }
				}
			}
			buffer += decoder.decode();
			const final = lineEvents(buffer, true);
			for (const line of final.lines) {
				try { apply(JSON.parse(line) as StreamEvent); }
				catch { /* the canonical refresh repairs malformed or unknown frames */ }
			}
		} catch {
			/* The accepted server run survives a lost client stream. */
		} finally {
			try { reader.releaseLock(); } catch { /* already released */ }
			attempt.transportActive = false;
			if (current()) {
				if (threadId) this.locallyRead.delete(threadId);
				if (!terminal) attempt.recoveryError = "The connection ended before the answer finished. Checking the saved side conversation…";
				this.updateEntry(key, { sending: false, ...(attempt.recoveryError ? { error: attempt.recoveryError } : {}) });
				if (this.snapshot.entries[key]?.thread) this.attempts.delete(key);
			}
			await this.refresh();
			this.scheduleExternalPoll();
		}
	}

	async stop(key: string): Promise<void> {
		const thread = this.snapshot.entries[key]?.thread;
		const requestId = this.attempts.get(key)?.requestId;
		if (!thread && !requestId) return;
		try {
			const response = thread
				? await fetch(`${this.base()}/${encodeURIComponent(thread.id)}/stop`, { method: "POST" })
				: await fetch(`${this.base()}/cancel`, {
					method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId }),
				});
			if (!response.ok) this.updateEntry(key, { error: errorText(await response.json().catch(() => null), response.status) });
		} catch (cause) {
			this.updateEntry(key, { error: errorText(cause, 0) });
		}
	}

	async remove(key: string): Promise<boolean> {
		const previous = this.snapshot.entries[key];
		const thread = previous?.thread;
		if (!thread) {
			this.discardDraft(key);
			return true;
		}
		const id = thread.id;
		const previousActive = this.snapshot.activeKey;
		this.tombstones.add(id);
		this.locallyRead.delete(id);
		this.discardDraft(key, true);
		try {
			const response = await fetch(`${this.base()}/${encodeURIComponent(id)}`, { method: "DELETE" });
			if (!response.ok) throw new Error(errorText(await response.json().catch(() => null), response.status));
			return true;
		} catch (cause) {
			this.tombstones.delete(id);
			this.update({
				entries: { ...this.snapshot.entries, [key]: { ...previous, sending: false, answer: undefined } },
				...(this.snapshot.activeKey === null && previousActive === key ? { activeKey: key } : {}),
			}, true);
			await this.refresh();
			this.updateEntry(key, { error: cause instanceof Error ? cause.message : "Could not delete this side question." });
			return false;
		}
	}

	private discardDraft(key: string, mutation = false): void {
		const entries = { ...this.snapshot.entries };
		delete entries[key];
		this.attempts.delete(key);
		this.update({ entries, ...(this.snapshot.activeKey === key ? { activeKey: null, validationError: "" } : {}) }, mutation);
	}

	async refresh(): Promise<void> {
		const sequence = ++this.refreshSequence;
		const revision = this.mutationRevision;
		let response: Response;
		try {
			response = await fetch(this.base(), { cache: "no-store" });
		} catch {
			this.scheduleExternalPoll();
			return;
		}
		if (!response.ok) { this.scheduleExternalPoll(); return; }
		const body = await response.json().catch(() => null) as { threads?: SideChatThread[]; answering?: Record<string, string> } | null;
		if (!body || sequence !== this.refreshSequence || revision !== this.mutationRevision) return;
		const serverThreads = Array.isArray(body.threads) ? body.threads : [];
		this.replaceThreads(serverThreads, body.answering ?? {});
		this.externalRuns = new Set(Object.values(this.snapshot.entries)
			.filter((entry) => entry.thread && entry.answer !== undefined && !this.locallyRead.has(entry.thread.id))
			.map((entry) => entry.thread!.id));
		this.scheduleExternalPoll();
	}

	private scheduleExternalPoll(): void {
		if (this.pollTimer) {
			clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}
		if (!this.mountCount || this.externalRuns.size === 0) return;
		this.pollTimer = setTimeout(() => {
			this.pollTimer = null;
			void this.refresh();
		}, EXTERNAL_POLL_MS);
	}

	/** Provider lifetime controls external-run polling. Locally read streams survive it. */
	mount(): () => void {
		this.mountCount++;
		void this.refresh();
		return () => {
			this.mountCount = Math.max(0, this.mountCount - 1);
			this.scheduleExternalPoll();
		};
	}
}

const StoreContext = createContext<SideChatStateStore | null>(null);

export function SideChatProvider({ chatId, children }: { chatId: string; children: ReactNode }) {
	const store = useMemo(() => getSideChatStore(chatId), [chatId]);
	useEffect(() => store.mount(), [store]);
	useServerEvent("side-chats-changed", (payload) => {
		if (payload.chatId === chatId) void store.refresh();
	});
	useServerResync(() => { void store.refresh(); });
	return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

/** Store access doesn't subscribe; side-chat mutations won't rerender Chat. */
export function useSideChatStore(): SideChatStateStore | null {
	return useContext(StoreContext);
}

export function useSideChatSnapshot(): SideChatSnapshot {
	const store = useContext(StoreContext);
	return useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.getSnapshot ?? getEmpty, getEmpty);
}

const noopSubscribe = () => () => {};
const getEmpty = () => emptySnapshot;
