import { emit } from "../core/events.ts";
import type { ChatRecord, SideChatMessage, SideChatThread } from "../core/contracts.ts";
import type { ChatStore } from "../core/ports.ts";
import { newMessageId } from "../core/native-messages.ts";
import {
	newSideQuestion,
	newSideThread,
	sideChatModelTurns,
	sideQuestionContext,
	sideThreadAwaitsAnswer,
	sideThreadLessonContext,
	validSideQuote,
	SIDE_REQUEST_WINDOW_MS,
	type SideAskInput,
	type SideLessonItem,
} from "../core/side-chat.ts";
import { composeSideChatInstructions, streamSideAnswer, type SideAnswerResult } from "../agent/side-chat.ts";
import { isSubscriptionProvider } from "../agent/subscription-connections.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { resolveConversationSpec } from "../core/settings-resolution.ts";
import { modelsNotConfigured, providerKeyMissing as missingKey } from "../core/settings.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { providerKeyPresent } from "./keys.ts";
import { refreshConnectionCatalog } from "./model-catalog.ts";
import { createLatestValueCoalescer } from "./latest-value-coalescer.ts";

export type SideStreamEvent =
	| { type: "thread"; thread: SideChatThread }
	| { type: "text"; text: string }
	| { type: "done"; thread: SideChatThread }
	| { type: "error"; error: string };

export interface SideChatDeps {
	chatStore: ChatStore;
	engineFor: (record: ChatRecord) => Promise<PiEngine | Response>;
	instructions: () => string;
}

interface SideRun {
	controller: AbortController;
	text: string;
	listeners: Set<(event: SideStreamEvent) => void>;
	settled: Promise<void>;
	deleted: boolean;
	terminal?: SideStreamEvent;
}

export interface SideChatService {
	list(chatId: string): { threads: SideChatThread[]; answering: Record<string, string> } | null;
	ask(chatId: string, input: SideAskInput): Promise<Response>;
	remove(chatId: string, threadId: string): "ok" | "unknown-chat" | "unknown-thread";
	stop(chatId: string, threadId: string): boolean;
	cancel(chatId: string, requestId: string): boolean;
	stopAll(chatId: string): void;
	settled(chatId: string, threadId: string): Promise<void>;
}

const keyFor = (chatId: string, threadId: string) => `${chatId}\0${threadId}`;

function jsonError(message: string, status = 400): Response {
	return Response.json({ error: message }, { status });
}

export function createSideChatService(deps: SideChatDeps): SideChatService {
	const runs = new Map<string, SideRun>();
	const attempts = new Map<string, { controller: AbortController; threadId?: string; run?: SideRun }>();
	const cancelled = new Map<string, number>();
	function pruneCancelled(): void {
		for (const [key, expires] of cancelled) if (expires <= Date.now()) cancelled.delete(key);
	}
	function requestExpires(requestId: string): number {
		return Number(requestId.split("_", 1)[0]) + SIDE_REQUEST_WINDOW_MS;
	}
	const cancelledResponse = () => Response.json({ cancelled: true });

	function cancel(chatId: string, requestId: string): boolean {
		pruneCancelled();
		const key = keyFor(chatId, requestId);
		const attempt = attempts.get(key);
		const expires = requestExpires(requestId);
		const now = Date.now();
		// Expiry bounds admission and tombstone retention, not an existing attempt's lifetime.
		if (Number.isFinite(expires) && expires > now && expires <= now + SIDE_REQUEST_WINDOW_MS) cancelled.set(key, expires);
		else if (!attempt) return false;
		attempt?.controller.abort();
		return true;
	}

	function announce(chatId: string): void {
		emit("side-chats-changed", { chatId });
	}

	function list(chatId: string): { threads: SideChatThread[]; answering: Record<string, string> } | null {
		const record = deps.chatStore.getChat(chatId);
		if (!record) return null;
		const answering: Record<string, string> = {};
		for (const thread of record.sideChats ?? []) {
			const run = runs.get(keyFor(chatId, thread.id));
			if (run) answering[thread.id] = run.text;
		}
		return { threads: record.sideChats ?? [], answering };
	}

	async function ask(chatId: string, input: SideAskInput): Promise<Response> {
		const initial = deps.chatStore.getChat(chatId);
		if (!initial) return jsonError("Unknown chat", 404);
		pruneCancelled();
		const requestKey = input.requestId ? keyFor(chatId, input.requestId) : undefined;
		if (input.requestId) {
			const expires = requestExpires(input.requestId);
			if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + SIDE_REQUEST_WINDOW_MS) {
				return jsonError("The side question request expired. Please send it again.", 409);
			}
			if (cancelled.has(requestKey!)) return cancelledResponse();
			if (attempts.has(requestKey!)) return jsonError("This side question request is already running", 409);
		}
		const attempt: { controller: AbortController; threadId?: string; run?: SideRun } = {
			controller: new AbortController(), threadId: input.threadId,
		};
		if (requestKey) attempts.set(requestKey, attempt);
		try {
			return await admit(chatId, input, initial, attempt);
		} finally {
			if (requestKey) {
				if (attempt.run) void attempt.run.settled.then(() => attempts.delete(requestKey));
				else attempts.delete(requestKey);
			}
		}
	}

	async function admit(chatId: string, input: SideAskInput, initial: ChatRecord, attempt: { controller: AbortController; threadId?: string; run?: SideRun }): Promise<Response> {
		const { signal } = attempt.controller;
		let onAbort = () => {};
		const aborted = new Promise<null>((resolve) => {
			onAbort = () => resolve(null);
			signal.addEventListener("abort", onAbort, { once: true });
		});

		let engine: PiEngine | Response;
		try {
			const resolved = await Promise.race([deps.engineFor(initial), aborted]);
			if (!resolved || signal.aborted) return cancelledResponse();
			engine = resolved;
		} catch (error) {
			if (signal.aborted) return cancelledResponse();
			return jsonError(error instanceof Error ? error.message : "Model unavailable", 503);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
		if (engine instanceof Response) return engine;

		// Re-read after resolving the engine so lesson content and quote checks are current.
		const record = deps.chatStore.getChat(chatId);
		if (!record) return jsonError("Unknown chat", 404);
		const invalidQuote = !input.retry ? input.quotes.findIndex((quote) => !validSideQuote(record, quote)) : -1;
		if (invalidQuote >= 0) {
			return Response.json({
				error: `Quote ${invalidQuote + 1} refers to an unavailable source in this session. Select a passage again, or remove the quote and resend. Your question and quotes have been kept.`,
				code: "invalid_quote",
				quoteIndex: invalidQuote,
			}, { status: 400 });
		}

		const threads = record.sideChats ?? [];
		let target = input.threadId ? threads.find((thread) => thread.id === input.threadId) : undefined;
		if (input.threadId && !target) return jsonError("Unknown side thread", 404);
		if (!input.threadId) {
			if (input.retry) return jsonError("Retry needs a side thread", 400);
			target = { ...newSideThread(), ...(input.requestId ? { creationRequestId: input.requestId } : {}) };
		}
		if (!target) return jsonError("Could not resolve side thread");

		const key = keyFor(chatId, target.id);
		if (runs.has(key)) return jsonError("This side question is still being answered", 409);

		// Freeze legacy questions using the same fallback as the scoped projection,
		// so later requests cannot resolve their missing boundaries against a newer lesson.
		const legacyThread = { ...target, messages: [] };
		target = { ...target, messages: target.messages.map((message) => message.role === "user" && !message.lessonContext
			? { ...message, lessonContext: sideQuestionContext(record.messages, legacyThread, message.quotes ?? []) }
			: message) };

		let thread: SideChatThread;
		if (input.retry) {
			const last = target.messages.at(-1);
			const failedAnswer = last?.role === "assistant" && last.error !== undefined;
			if (!failedAnswer && !sideThreadAwaitsAnswer(target)) return jsonError("Nothing to retry in this side thread", 409);
			thread = { ...target, messages: failedAnswer ? target.messages.slice(0, -1) : target.messages };
		} else {
			if (sideThreadAwaitsAnswer(target)) return jsonError("Answer the previous side question before asking another", 409);
			const question = {
				...newSideQuestion(input.text, input.quotes),
				lessonContext: sideQuestionContext(record.messages, target, input.quotes),
			};
			thread = { ...target, messages: [...target.messages, question] };
		}

		const lessonContext = sideThreadLessonContext(record.messages, thread);
		const turns = sideChatModelTurns(thread, lessonContext.document);
		let stored: SideChatThread[] | null;
		try {
			stored = deps.chatStore.updateSideChats(chatId, (current) => current.some((item) => item.id === thread.id)
				? current.map((item) => item.id === thread.id ? thread : item)
				: [...current, thread]);
		} catch (error) {
			console.error(`[chat ${chatId}] side question could not be saved:`, error);
			return jsonError("The side question could not be saved. Please try again.", 503);
		}
		if (!stored) return jsonError("Unknown chat", 404);

		const run: SideRun = {
			controller: attempt.controller,
			text: "",
			listeners: new Set(),
			settled: Promise.resolve(),
			deleted: false,
		};
		attempt.run = run;
		runs.set(key, run);
		announce(chatId);

		const model = `${engine.model.provider}:${engine.model.id}`;
		const broadcast = (event: SideStreamEvent) => {
			for (const listener of [...run.listeners]) {
				try {
					listener(event);
				} catch {
					// A disconnected view must not interrupt the server-owned generation.
				}
			}
		};

		run.settled = settleRun({
			chatId,
			deps,
			engine,
			inputTurns: turns,
			lessonItems: lessonContext.items,
			model,
			run,
			thread,
			key,
			broadcast,
			instructions: deps.instructions,
			announce,
			runs,
		});

		return ndjsonResponse({ run, thread });
	}

	function remove(chatId: string, threadId: string): "ok" | "unknown-chat" | "unknown-thread" {
		const run = runs.get(keyFor(chatId, threadId));
		let existed = false;
		const stored = deps.chatStore.updateSideChats(chatId, (current) => {
			existed = current.some((thread) => thread.id === threadId);
			return current.filter((thread) => thread.id !== threadId);
		});
		// Do not cancel or discard the partial answer if deleting the file
		// failed. This synchronous write precedes the next provider event.
		if (run) {
			run.deleted = true;
			run.controller.abort();
		}
		if (!stored) return "unknown-chat";
		if (!existed) return "unknown-thread";
		announce(chatId);
		return "ok";
	}

	function stop(chatId: string, threadId: string): boolean {
		const run = runs.get(keyFor(chatId, threadId));
		if (!run) {
			let stopped = false;
			for (const [key, attempt] of attempts) {
				if (key.startsWith(`${chatId}\0`) && attempt.threadId === threadId) {
					attempt.controller.abort();
					stopped = true;
				}
			}
			return stopped;
		}
		run.controller.abort();
		return true;
	}

	function stopAll(chatId: string): void {
		const prefix = `${chatId}\0`;
		for (const [key, attempt] of attempts) if (key.startsWith(prefix)) attempt.controller.abort();
		for (const [key, run] of runs) {
			if (!key.startsWith(prefix)) continue;
			run.deleted = true;
			run.controller.abort();
		}
	}

	function settled(chatId: string, threadId: string): Promise<void> {
		return runs.get(keyFor(chatId, threadId))?.settled ?? Promise.resolve();
	}

	return { list, ask, remove, stop, cancel, stopAll, settled };
}

async function settleRun(options: {
	chatId: string;
	deps: SideChatDeps;
	engine: PiEngine;
	inputTurns: ReturnType<typeof sideChatModelTurns>;
	lessonItems: readonly SideLessonItem[];
	model: string;
	run: SideRun;
	thread: SideChatThread;
	key: string;
	broadcast: (event: SideStreamEvent) => void;
	instructions: () => string;
	announce: (chatId: string) => void;
	runs: Map<string, SideRun>;
}): Promise<void> {
	const { chatId, deps, engine, inputTurns, model, run, thread, key, broadcast } = options;
	const updates = createLatestValueCoalescer<SideStreamEvent>((batch) => {
		for (const event of batch) broadcast(event);
	});
	const onText = (text: string) => {
		// Reconnect/list state stays current even while live fan-out is coalesced.
		run.text = text;
		updates.queue("text", { type: "text", text });
	};
	let outcome: SideAnswerResult;
	try {
		outcome = await streamSideAnswer({
			engine,
			instructions: options.instructions(),
			turns: inputTurns,
			lessonItems: options.lessonItems,
			signal: run.controller.signal,
			onText,
		});
	} catch (error) {
		outcome = {
			text: run.text,
			outcome: "error",
			errorMessage: error instanceof Error ? error.message : String(error),
		};
	}

	// The final provider message (or lookup-limit notice) may revise the last
	// partial. Deliver that authoritative replacement before either terminal.
	if (outcome.text !== run.text) onText(outcome.text);
	updates.flush();
	run.terminal = settleSideAnswer({
		chatStore: deps.chatStore, chatId, threadId: thread.id, model, outcome, deleted: run.deleted,
	});
	options.runs.delete(key);
	options.announce(chatId);
	broadcast(run.terminal);
	run.listeners.clear();
}

/** Own both persistence attempts and report partial failure, without losing spend
 * when the answer cannot be saved or its thread has been deleted. */
function settleSideAnswer(options: {
	chatStore: ChatStore;
	chatId: string;
	threadId: string;
	model: string;
	outcome: SideAnswerResult;
	deleted: boolean;
}): SideStreamEvent {
	const { chatStore, chatId, threadId, model, outcome, deleted } = options;
	const at = new Date().toISOString();
	const answer: SideChatMessage = {
		id: newMessageId(),
		role: "assistant",
		text: outcome.text,
		at,
		model,
		...(outcome.outcome === "aborted" ? { stopped: true } : {}),
		...(outcome.outcome === "error" ? { error: outcome.errorMessage ?? "The model call failed." } : {}),
	};
	let settledThread: SideChatThread | undefined;
	const failures: string[] = [];
	if (!deleted) {
		try {
			const saved = chatStore.updateSideChats(chatId, (current) => current.map((currentThread) =>
				currentThread.id === threadId
					? { ...currentThread, messages: [...currentThread.messages, answer] }
					: currentThread));
			settledThread = saved?.find((currentThread) => currentThread.id === threadId);
		} catch (error) {
			console.error(`[chat ${chatId}] side answer could not be saved:`, error);
		}
		if (!settledThread) failures.push("The side answer could not be saved.");
	}

	// Deleting a thread does not erase model spend; parent-chat deletion does.
	if (outcome.usages?.length) {
		try {
			if (chatStore.getChat(chatId)) chatStore.appendTurnUsage(chatId, {
				id: crypto.randomUUID(),
				kind: "side-question",
				messageId: answer.id,
				at,
				model,
				steps: outcome.usages.map((usage) => ({
					inputTokens: usage.input,
					outputTokens: usage.output,
					cacheReadTokens: usage.cacheRead,
					cacheWriteTokens: usage.cacheWrite,
					cacheWrite1hTokens: usage.cacheWrite1h ?? 0,
					reasoningTokens: usage.reasoning ?? 0,
				})),
			});
		} catch (error) {
			console.error(`[chat ${chatId}] side answer usage could not be saved:`, error);
			failures.push("The side answer usage could not be saved.");
		}
	}

	if (deleted) failures.unshift("The side thread is gone.");
	return failures.length
		? { type: "error", error: failures.join(" ") }
		: { type: "done", thread: settledThread! };
}

function ndjsonResponse(options: {
	run: SideRun;
	thread: SideChatThread;
}): Response {
	const encoder = new TextEncoder();
	let detach = () => {};
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			const write = (event: SideStreamEvent) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
				} catch {
					// Stream has been cancelled or its consumer disconnected.
				}
			};
			const close = () => {
				if (closed) return;
				closed = true;
				try {
					controller.close();
				} catch {
					// Already closed by the consumer.
				}
			};
			const listener = (event: SideStreamEvent) => {
				write(event);
				if (event.type === "done" || event.type === "error") {
					options.run.listeners.delete(listener);
					close();
				}
			};
			write({ type: "thread", thread: options.thread });
			options.run.listeners.add(listener);
			detach = () => {
				closed = true;
				options.run.listeners.delete(listener);
			};

			// Covers the settle-before-listener registration race without duplicating a terminal event.
			void options.run.settled.then(() => {
				if (closed) return;
				write(options.run.terminal ?? { type: "error", error: "The side answer did not finish saving." });
				close();
			});
		},
		cancel() {
			// A disconnected view detaches; the server-owned generation continues.
			detach();
		},
	});
	return new Response(body, {
		headers: {
			"Content-Type": "application/x-ndjson; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
		},
	});
}

async function productionEngine(record: ChatRecord): Promise<PiEngine | Response> {
	const settings = effectiveSettings();
	const spec = resolveConversationSpec(record.settings, settings.models.strong);
	if (!spec) return Response.json(modelsNotConfigured(["strong"]), { status: 503 });
	if (isSubscriptionProvider(spec.provider)) await refreshConnectionCatalog(spec.provider);
	if (!providerKeyPresent(spec.provider)) return Response.json(missingKey(spec.provider, ["strong"]), { status: 503 });

	const strongRetention = () => stores.settingsStore.readSettings()?.models?.strong?.cacheRetention;
	try {
		return piEngineForSpec(spec, false, undefined, strongRetention);
	} catch {
		return Response.json({ error: "The selected model is unavailable." }, { status: 503 });
	}
}

interface SideChatGlobal {
	__lhSideChatService?: SideChatService;
}

export const sideChats: SideChatService = ((globalThis as typeof globalThis & SideChatGlobal).__lhSideChatService ??=
	createSideChatService({
		chatStore: stores.chatStore,
		engineFor: productionEngine,
		instructions: () => composeSideChatInstructions(effectiveSettings().agent.prompts),
	}));
