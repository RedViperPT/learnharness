import { randomUUID } from "node:crypto";
import { normalizeContext, type AssistantMessage, type Message, type Usage } from "@earendil-works/pi-ai";
import type { SideLessonItem, SideModelTurn } from "../core/side-chat.ts";
import type { PiEngine } from "./models.ts";
import { readPromptOverride, readPromptSource } from "./prompt-segments.ts";
import { providerEventObserver } from "./provider-events.ts";
import { lookupSideLesson, sideLessonTools } from "./tools/side-lesson.ts";

const SHARED_FRAGMENTS = ["shared/10-voice.md", "shared/15-accuracy.md", "shared/40-formatting.md"];

/** Compose the fixed side-question base and the shared learner-facing fragments. */
export function composeSideChatInstructions(switches: Record<string, boolean> = {}): string {
	const fragments = SHARED_FRAGMENTS.map((key) => {
		const fallback = readPromptSource(key);
		return switches[key] === true ? readPromptOverride(key) ?? fallback : fallback;
	});
	const base = readPromptSource("side-chat/00-base.md");
	return [base, ...fragments].map((fragment) => fragment.trim()).filter(Boolean).join("\n\n---\n\n");
}

export interface SideAnswerResult {
	text: string;
	usages?: Usage[];
	outcome: "done" | "aborted" | "error";
	errorMessage?: string;
}

function textOf(message: AssistantMessage): string {
	return message.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("");
}

function assistantHistoryMessage(turn: SideModelTurn, engine: PiEngine, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: turn.text }],
		api: engine.model.api,
		provider: engine.model.provider,
		model: engine.model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	} as AssistantMessage;
}

export const SIDE_CONTEXT_RESERVE_TOKENS = 16_000;
export const SIDE_LOOKUP_MAX_ROUNDS = 8;
export const SIDE_CONTEXT_ERROR = "This side conversation and its lesson references exceed the selected model's context budget. Start a new side thread, or choose a model with a larger context window. Your saved conversation has not been shortened; retrying unchanged may fail again.";
const LOOKUP_LIMIT_NOTICE = "[Lesson lookup limit reached; no further lesson material can be read for this answer.]";

export function sideContextError(message: string): string {
	return /context[_ -]?(length|window)|maximum context|too many tokens|(?:prompt|input).*(?:too long|too large)|exceed.*token/i.test(message) ? SIDE_CONTEXT_ERROR : message;
}

/** Stream a private answer with bounded, read-only lesson lookup. All model calls retain usage. */
export async function streamSideAnswer(options: {
	chatId?: string;
	engine: PiEngine;
	instructions: string;
	turns: readonly SideModelTurn[];
	lessonItems: readonly SideLessonItem[];
	signal?: AbortSignal;
	onText?: (text: string) => void;
}): Promise<SideAnswerResult> {
	const timestamp = Date.now();
	const messages: Message[] = options.turns.map((turn) =>
		turn.role === "user"
			? { role: "user", content: turn.text, timestamp }
			: assistantHistoryMessage(turn, options.engine, timestamp),
	);
	let text = "";
	let completedText = "";
	const usages: Usage[] = [];
	const sessionId = randomUUID();
	const providerEvents = options.chatId ? providerEventObserver(options.chatId, "side") : undefined;
	const result = (outcome: SideAnswerResult["outcome"], errorMessage?: string): SideAnswerResult => ({ text, usages, outcome, ...(errorMessage ? { errorMessage: sideContextError(errorMessage) } : {}) });

	try {
		for (let round = 0; round <= SIDE_LOOKUP_MAX_ROUNDS; round++) {
			if (options.signal?.aborted) return result("aborted");
			const context = normalizeContext({
				systemPrompt: round === SIDE_LOOKUP_MAX_ROUNDS ? `${options.instructions}\n\n${LOOKUP_LIMIT_NOTICE}` : options.instructions,
				messages,
				tools: round < SIDE_LOOKUP_MAX_ROUNDS ? sideLessonTools : [],
			});
			// Same chars/4 fallback used for application context estimates. Providers remain authoritative.
			const estimatedTokens = Math.ceil(JSON.stringify(context).length / 4);
			const window = options.engine.model.contextWindow;
			if (Number.isFinite(window) && window > 0 && estimatedTokens + SIDE_CONTEXT_RESERVE_TOKENS > window) return result("error", SIDE_CONTEXT_ERROR);
			const stream = options.engine.streamFn(options.engine.model, context, {
				sessionId,
				signal: options.signal,
				...(providerEvents ? { onProviderStreamEvent: providerEvents } : {}),
				reasoning: options.engine.level && options.engine.level !== "off" ? options.engine.level : undefined,
			} as never);
			let answer: AssistantMessage | undefined;
			for await (const event of stream) {
				if (event.type === "text_delta" || event.type === "text_end") {
					const next = completedText + textOf(event.partial);
					if (next !== text) { text = next; options.onText?.(text); }
				} else if (event.type === "done") {
					answer = event.message;
					usages.push(answer.usage);
					break;
				} else if (event.type === "error") {
					text = completedText + (textOf(event.error) || text.slice(completedText.length));
					usages.push(event.error.usage);
					return result(event.reason === "aborted" ? "aborted" : "error", event.reason === "aborted" ? undefined : event.error.errorMessage ?? "The model call failed.");
				}
			}
			if (!answer) return result("error", "The model stream ended without a result.");
			text = completedText + (textOf(answer) || text.slice(completedText.length));
			const calls = answer.content.filter((block) => block.type === "toolCall");
			if (!calls.length) {
				if (round === SIDE_LOOKUP_MAX_ROUNDS) text = [text, LOOKUP_LIMIT_NOTICE].filter(Boolean).join("\n\n");
				return result("done");
			}
			if (round === SIDE_LOOKUP_MAX_ROUNDS) return result("error", LOOKUP_LIMIT_NOTICE);
			messages.push(answer);
			for (const call of calls) {
				if (options.signal?.aborted) return result("aborted");
				let content: string;
				let isError = false;
				try { content = lookupSideLesson(options.lessonItems, call.name, call.arguments as Record<string, unknown>); }
				catch (error) { content = error instanceof Error ? error.message : String(error); isError = true; }
				messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: content }], isError, timestamp: Date.now() });
			}
			completedText = text ? `${text}\n\n` : "";
		}
		return result("error", LOOKUP_LIMIT_NOTICE);
	} catch (error) {
		if (options.signal?.aborted) return result("aborted");
		return result("error", error instanceof Error ? error.message : String(error));
	}
}
