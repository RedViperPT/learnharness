import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ChatRecord, SideChatMessage, SideChatQuote, SideChatQuoteSegment, SideChatSource, SideChatThread } from "./contracts/chat.ts";
import {
	activeProblemOf,
	failedOutputCallIds,
	newMessageId,
	PRACTICE_CONCLUDE_TOOL,
	PRACTICE_PROBLEM_TOOL,
	questionCallsOf,
	userFacingTextOf,
	type LhMarkerMessage,
	type LhMessage,
} from "./native-messages.ts";
import { messageMarkdown } from "./session-markdown.ts";
import { normalizeOptions, type QuestionAnswerData } from "./question-core.ts";
import { QUESTION_TOOLS } from "./pending.ts";

export const SIDE_QUESTION_MAX_CHARS = 8_000;
export const SIDE_QUOTE_MAX_CHARS = 8_000;
export const SIDE_QUOTES_MAX = 5;
export class SideChatInputError extends Error {}

export type SideAskInput =
	| { requestId?: string; threadId?: string; text: string; quotes: SideChatQuote[]; retry?: false }
	| { requestId?: string; threadId: string; retry: true };

export const SIDE_REQUEST_WINDOW_MS = 5 * 60 * 1_000;

/** The timestamp bounds both admission and stop-before-admission retention. */
export function parseSideRequestId(raw: unknown): string {
	if (typeof raw !== "string" || !/^\d{13}_[A-Za-z0-9_-]{1,100}$/.test(raw)) {
		throw new SideChatInputError("requestId is invalid");
	}
	return raw;
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function parseSource(raw: unknown): SideChatSource {
	if (!raw || typeof raw !== "object") throw new SideChatInputError("quote source is invalid");
	const source = raw as Record<string, unknown>;
	if (source.kind === "message" && typeof source.messageId === "string" && ID_RE.test(source.messageId)) {
		return { kind: "message", messageId: source.messageId };
	}
	if (
		(source.kind === "question" || source.kind === "problem") &&
		typeof source.toolCallId === "string" &&
		ID_RE.test(source.toolCallId)
	) {
		return { kind: source.kind, toolCallId: source.toolCallId };
	}
	throw new SideChatInputError("quote source is invalid");
}

/** Canonical selector/model text, not Markdown source for rendering quotes. */
export function sideQuoteSegmentText(segment: SideChatQuoteSegment): string {
	if (segment.kind === "text") return segment.text;
	const delimiter = segment.display ? "$$" : "$";
	return `${delimiter}${segment.tex}${delimiter}`;
}

function parseQuoteSegments(raw: unknown, text: string): SideChatQuoteSegment[] {
	if (!Array.isArray(raw) || !raw.length || raw.length > text.length) {
		throw new SideChatInputError("quote segments are invalid");
	}
	let offset = 0;
	const segments = raw.map((value): SideChatQuoteSegment => {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new SideChatInputError("quote segment is invalid");
		const segment = value as Record<string, unknown>;
		let parsed: SideChatQuoteSegment;
		if (segment.kind === "text" && typeof segment.text === "string" && segment.text.length > 0 && segment.text.length <= text.length) {
			parsed = { kind: "text", text: segment.text };
		} else if (segment.kind === "math" && typeof segment.tex === "string" && segment.tex.length > 0 && segment.tex.length <= text.length && typeof segment.display === "boolean") {
			parsed = { kind: "math", tex: segment.tex, display: segment.display };
		} else {
			throw new SideChatInputError("quote segment is invalid");
		}
		const projected = sideQuoteSegmentText(parsed);
		if (!text.startsWith(projected, offset)) throw new SideChatInputError("quote segments must match quote text");
		offset += projected.length;
		return parsed;
	});
	if (offset !== text.length) throw new SideChatInputError("quote segments must match quote text");
	return segments;
}

export function parseSideAskInput(raw: unknown): SideAskInput {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SideChatInputError("body must be an object");
	const body = raw as Record<string, unknown>;
	const request = body.requestId === undefined ? {} : { requestId: parseSideRequestId(body.requestId) };
	if (body.retry === true) {
		if (typeof body.threadId !== "string" || !ID_RE.test(body.threadId)) {
			throw new SideChatInputError("retry needs a valid threadId");
		}
		return { ...request, threadId: body.threadId, retry: true };
	}
	if (body.retry !== undefined && body.retry !== false) throw new SideChatInputError("retry must be true or omitted");
	if (typeof body.text !== "string" || !body.text.trim()) throw new SideChatInputError("text must be a non-empty string");
	if (body.text.length > SIDE_QUESTION_MAX_CHARS) throw new SideChatInputError(`text exceeds ${SIDE_QUESTION_MAX_CHARS} characters`);
	if (body.threadId !== undefined && (typeof body.threadId !== "string" || !ID_RE.test(body.threadId))) {
		throw new SideChatInputError("threadId is invalid");
	}

	const rawQuotes = body.quotes ?? [];
	if (!Array.isArray(rawQuotes) || rawQuotes.length > SIDE_QUOTES_MAX) {
		throw new SideChatInputError(`quotes must be an array of at most ${SIDE_QUOTES_MAX}`);
	}
	const quotes = rawQuotes.map((rawQuote): SideChatQuote => {
		if (!rawQuote || typeof rawQuote !== "object" || Array.isArray(rawQuote)) throw new SideChatInputError("quote is invalid");
		const quote = rawQuote as Record<string, unknown>;
		if (typeof quote.text !== "string" || !quote.text.trim()) throw new SideChatInputError("quote text must be non-empty");
		if (quote.text.length > SIDE_QUOTE_MAX_CHARS) throw new SideChatInputError(`quote text exceeds ${SIDE_QUOTE_MAX_CHARS} characters`);
		const source = parseSource(quote.source);
		let selector: SideChatQuote["selector"];
		if (quote.selector !== undefined) {
			if (!quote.selector || typeof quote.selector !== "object" || Array.isArray(quote.selector)) {
				throw new SideChatInputError("quote selector is invalid");
			}
			const selection = quote.selector as Record<string, unknown>;
			if (
				!Number.isSafeInteger(selection.start) ||
				!Number.isSafeInteger(selection.end) ||
				(selection.start as number) < 0 ||
				(selection.end as number) <= (selection.start as number) ||
				typeof selection.prefix !== "string" ||
				typeof selection.suffix !== "string" ||
				selection.prefix.length > 32 ||
				selection.suffix.length > 32
			) {
				throw new SideChatInputError("quote selector is invalid");
			}
			selector = {
				start: selection.start as number,
				end: selection.end as number,
				prefix: selection.prefix,
				suffix: selection.suffix,
			};
		}
		const segments = quote.segments === undefined ? undefined : parseQuoteSegments(quote.segments, quote.text);
		return { text: quote.text, source, ...(selector ? { selector } : {}), ...(segments ? { segments } : {}) };
	});

	return {
		...request,
		...(body.threadId !== undefined ? { threadId: body.threadId as string } : {}),
		text: body.text.trim(),
		quotes,
	};
}

export function newSideThread(at = new Date().toISOString()): SideChatThread {
	return { id: `side_${crypto.randomUUID()}`, createdAt: at, messages: [] };
}

export function newSideQuestion(text: string, quotes: SideChatQuote[]): SideChatMessage {
	return {
		id: newMessageId(),
		role: "user",
		text,
		...(quotes.length ? { quotes } : {}),
		at: new Date().toISOString(),
	};
}

export function sideThreadAwaitsAnswer(thread: SideChatThread): boolean {
	return thread.messages.at(-1)?.role === "user";
}

function collectCalls(messages: readonly LhMessage[]): Map<string, { name: string; args: Record<string, unknown> | undefined; message: AssistantMessage }> {
	const calls = new Map<string, { name: string; args: Record<string, unknown> | undefined; message: AssistantMessage }>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const assistant = message as AssistantMessage;
		for (const block of assistant.content) {
			if (block.type === "toolCall") {
				calls.set(block.id, { name: block.name, args: block.arguments as Record<string, unknown> | undefined, message: assistant });
			}
		}
	}
	return calls;
}

function successfulResult(messages: readonly LhMessage[], toolCallId: string, toolName: string): ToolResultMessage | undefined {
	return messages.find(
		(message) => message.role === "toolResult" &&
			(message as ToolResultMessage).toolCallId === toolCallId &&
			(message as ToolResultMessage).toolName === toolName &&
			!(message as ToolResultMessage).isError,
	) as ToolResultMessage | undefined;
}

function quizHeading(answer: QuestionAnswerData, tool: string): string {
	if (tool === "probe") return "Probe";
	if (tool === "recall") return "Recall question";
	if (tool === "explain") return "Explain question";
	if (tool === "ask_user_question") return "Question to the learner";
	return answer.questionType === "predict" ? "Prediction question" : "Check question";
}

function answeredQuestionMarkdown(result: ToolResultMessage, input: Record<string, unknown> | undefined): string | null {
	const answer = result.details as QuestionAnswerData | undefined;
	if (!answer || typeof answer !== "object" || typeof answer.questionText !== "string") return null;
	const lines = [`### ${quizHeading(answer, result.toolName)} (answered)`];
	if (typeof answer.readingThinking === "string" && answer.readingThinking.trim()) {
		lines.push(`*The learner's notes while reading, before this question:* ${answer.readingThinking.trim()}`);
	}
	lines.push(`**Q:** ${answer.questionText}`);
	const details = typeof input?.details === "string" ? input.details.trim() : "";
	if (details) lines.push(details);
	if (answer.dismissed) {
		lines.push("The learner skipped this question.");
		return lines.join("\n\n");
	}
	const chosen = new Set((answer.answers ?? []).map((item) => item.index));
	const correct = new Set(answer.correctIndices ?? []);
	const isQuiz = answer.kind === "quiz";
	if (answer.options?.length) {
		lines.push(answer.options.map((option) => {
			const marks = [isQuiz && correct.has(option.index) ? "correct" : "", chosen.has(option.index) ? "chosen by the learner" : ""].filter(Boolean);
			return `- ${option.label}${marks.length ? ` *(${marks.join(", ")})*` : ""}`;
		}).join("\n"));
	}
	if (answer.other) lines.push(`The learner wrote their own option: "${answer.other}"`);
	if (answer.text) lines.push(`The learner answered: "${answer.text}"`);
	if (answer.dontKnow) lines.push('The learner answered "I don\'t know."');
	if (isQuiz && !answer.dontKnow && typeof answer.correct === "boolean") lines.push(`Verdict: ${answer.correct ? "correct" : "incorrect"}.`);
	if (typeof answer.confidence === "number") lines.push(`The learner's stated confidence: ${answer.confidence}%.`);
	const thinking = answer.thinking ?? answer.note;
	if (typeof thinking === "string" && thinking.trim()) lines.push(`*The learner's thinking:* ${thinking.trim()}`);
	if (answer.explanation) lines.push(`**Explanation shown to the learner:** ${answer.explanation}`);
	if (answer.committed) lines.push(`**The teacher's committed answer, shown to the learner:** ${answer.committed}`);
	return lines.join("\n\n");
}

function openQuestionMarkdown(tool: string, input: Record<string, unknown> | undefined): string | null {
	if (!input || typeof input.question !== "string" || !input.question.trim()) return null;
	const lines = ["### OPEN question — the learner has not answered it yet (its answer key is hidden from you)", `**Q:** ${input.question.trim()}`];
	if (typeof input.details === "string" && input.details.trim()) lines.push(input.details.trim());
	if (tool !== "explain" && tool !== "recall") {
		const options = normalizeOptions(input.options as Parameters<typeof normalizeOptions>[0]);
		if (options.length) lines.push(options.map((option) => `- ${option.label}`).join("\n"));
	}
	return lines.join("\n\n");
}

function problemMarkdown(input: Record<string, unknown> | undefined, open: boolean): string | null {
	const statement = typeof input?.statement === "string" ? input.statement.trim() : "";
	if (!statement) return null;
	return open
		? `### OPEN problem — the learner is working on it now (its solution is hidden from you)\n\n${statement}`
		: `### Problem\n\n${statement}`;
}

function thinkingText(message: LhMarkerMessage): string | null {
	if (message.customType !== "practice-thinking") return null;
	const text = (message.details as { text?: unknown } | null)?.text;
	return typeof text === "string" && text.trim() ? text.trim() : null;
}

export interface SideLessonItem {
	id: string;
	kind: "teacher" | "learner" | "question" | "problem";
	text: string;
	source?: SideChatSource;
	/** Question and saved answer are separate chronological lesson items. */
	sourceKey?: string;
	open?: boolean;
}

function sourceKey(source: SideChatSource): string {
	return source.kind === "message" ? `message:${source.messageId}` : `${source.kind}:${source.toolCallId}`;
}

/** Project saved visible items, including pre-compaction history, never raw tools or summaries. */
export function sideChatLessonItems(messages: readonly LhMessage[]): SideLessonItem[] {
	const items: SideLessonItem[] = [];
	const calls = collectCalls(messages);
	const openQuestions = new Set(questionCallsOf(messages)
		.filter((question) => question.status === "answerable")
		.map((question) => question.toolCallId));
	const activeProblem = activeProblemOf(messages)?.toolCallId ?? null;
	const failedOutputs = failedOutputCallIds(messages);

	for (const message of messages) {
		if (message.role === "user") {
			const text = userFacingTextOf(message.content).join("\n\n").trim();
			if (text) items.push({ id: `learner:${message.id}`, kind: "learner", text: `### Learner\n\n${text}` });
		} else if (message.role === "assistant") {
			const assistant = message as AssistantMessage;
			if (["pending", "error", "aborted"].includes(assistant.stopReason)) continue;
			const text = userFacingTextOf(assistant.content, failedOutputs).join("\n\n").trim();
			if (text) items.push({ id: `message:${message.id}`, kind: "teacher", text: `### Teacher\n\n${text}`, source: { kind: "message", messageId: message.id } });
			for (const block of assistant.content) {
				if (block.type !== "toolCall" || !(QUESTION_TOOLS as readonly string[]).includes(block.name)) continue;
				const call = calls.get(block.id);
				if (!openQuestions.has(block.id) && !successfulResult(messages, block.id, block.name)) continue;
				const rendered = openQuestionMarkdown(block.name, call?.args);
				if (rendered) items.push({
					id: `question:${block.id}`, kind: "question", sourceKey: `question:${block.id}`,
					source: { kind: "question", toolCallId: block.id }, open: openQuestions.has(block.id),
					text: openQuestions.has(block.id) ? rendered : rendered.replace(/^### OPEN question[^\n]*/, "### Question"),
				});
			}
		} else if (message.role === "toolResult") {
			const result = message as ToolResultMessage;
			if (result.isError) continue;
			if ((QUESTION_TOOLS as readonly string[]).includes(result.toolName)) {
				const rendered = answeredQuestionMarkdown(result, calls.get(result.toolCallId)?.args);
				if (rendered) items.push({ id: `answer:${message.id}`, kind: "learner", sourceKey: `question:${result.toolCallId}`, text: rendered });
			} else if (result.toolName === PRACTICE_PROBLEM_TOOL) {
				const rendered = problemMarkdown(calls.get(result.toolCallId)?.args, result.toolCallId === activeProblem);
				if (rendered) items.push({ id: `problem:${result.toolCallId}`, kind: "problem", text: rendered, source: { kind: "problem", toolCallId: result.toolCallId }, open: result.toolCallId === activeProblem });
			} else if (result.toolName === PRACTICE_CONCLUDE_TOOL) {
				const rendered = messageMarkdown(message, message.id, false, { messages, calls, failedOutputCalls: failedOutputs });
				if (rendered) items.push({ id: `conclude:${message.id}`, kind: "teacher", text: rendered });
			}
		} else if (message.role === "custom") {
			const thinking = thinkingText(message as LhMarkerMessage);
			if (thinking) items.push({ id: `thinking:${message.id}`, kind: "learner", text: `### Learner (thinking on the problem)\n\n${thinking}` });
		}
	}
	return items;
}

export function sideChatLessonDocument(messages: readonly LhMessage[]): string {
	return sideChatLessonItems(messages).map((item) => item.text).join("\n\n");
}

/** New quotes extend a thread's anchors; an unquoted follow-up never jumps to the lesson's present. */
export function sideQuestionContext(messages: readonly LhMessage[], thread: SideChatThread, quotes: readonly SideChatQuote[]): NonNullable<SideChatMessage["lessonContext"]> {
	const previous = thread.messages.findLast((message) => message.role === "user");
	if (!quotes.length && previous?.lessonContext) return previous.lessonContext;
	const sources = [...(previous?.lessonContext?.sources ?? thread.messages.flatMap((message) => (message.quotes ?? []).map((quote) => quote.source)))];
	for (const quote of quotes) if (!sources.some((source) => sourceKey(source) === sourceKey(quote.source))) sources.push(quote.source);
	if (!sources.length) {
		const latest = sideChatLessonItems(messages).findLast((item) => item.kind === "teacher" && item.source?.kind === "message");
		if (latest?.source) sources.push(latest.source);
	}
	return { sources, throughMessageId: messages.at(-1)?.id ?? null };
}

export interface SideLessonContext {
	document: string;
	/** The ONLY material the lookup tools may access. */
	items: SideLessonItem[];
}

/** Anchor-scoped initial context and read authority; neither depends on the compaction cut. */
export function sideThreadLessonContext(messages: readonly LhMessage[], thread: SideChatThread): SideLessonContext {
	const initial = new Map<string, SideLessonItem>();
	const available = new Map<string, SideLessonItem>();
	const full = sideChatLessonItems(messages);
	const projections = new Map<string | null, SideLessonItem[]>([[messages.at(-1)?.id ?? null, full]]);
	const explicit = new Set(thread.messages.flatMap((message) => (message.quotes ?? []).map((quote) => sourceKey(quote.source))));
	const allowed = (item: SideLessonItem) => !item.open || (item.source && explicit.has(sourceKey(item.source)));
	for (const question of thread.messages) {
		if (question.role !== "user") continue;
		// Legacy threads have no saved anchors. Resolve their quotes (or latest explanation) once on admission.
		const context = question.lessonContext ?? sideQuestionContext(messages, { ...thread, messages: [] }, question.quotes ?? []);
		const through = context.throughMessageId === null ? -1 : messages.findIndex((message) => message.id === context.throughMessageId);
		let items = projections.get(context.throughMessageId);
		if (!items) {
			items = sideChatLessonItems(messages.slice(0, through + 1));
			projections.set(context.throughMessageId, items);
		}
		let end = -1;
		for (const source of context.sources) {
			const key = sourceKey(source);
			const anchor = items.findIndex((item) => item.source && sourceKey(item.source) === key);
			if (anchor < 0) continue;
			let last = anchor;
			for (let i = anchor + 1; i < items.length; i++) if (items[i]!.sourceKey === key) last = i;
			let start = anchor;
			for (let i = anchor - 1; i >= 0; i--) {
				if (items[i]!.kind === "teacher") { start = i; break; }
			}
			for (const item of items.slice(start, last + 1)) if (allowed(item) && !initial.has(item.id)) initial.set(item.id, item);
			end = Math.max(end, last);
		}
		for (const item of items.slice(0, end + 1)) if (allowed(item) && !available.has(item.id)) available.set(item.id, item);
	}
	// Map insertion order follows questions, not necessarily lesson order (quotes can point backwards).
	const order = new Map(full.map((item, index) => [item.id, index]));
	const chronological = (values: Map<string, SideLessonItem>) => [...values.values()].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
	return {
		document: chronological(initial).map((item) => `[${item.id}]\n${item.text}`).join("\n\n"),
		items: chronological(available),
	};
}

export interface SideModelTurn { role: "user" | "assistant"; text: string }

export function sideChatModelTurns(thread: SideChatThread, lessonDocument: string): SideModelTurn[] {
	return thread.messages.map((message, index) => ({
		role: message.role,
		text: message.role === "user"
			? [
				index === 0 ? `<lesson>\n${lessonDocument || "(No lesson source is available for this side thread.)"}\n</lesson>` : "",
				...(message.quotes ?? []).map((quote) => `<quote>\n${quote.text}\n</quote>`),
				`Side question: ${message.text}`,
			].filter(Boolean).join("\n\n")
			: [message.text.trim(), message.stopped ? "(The learner stopped this answer here.)" : "", message.error ? "(This answer failed before it finished.)" : ""]
				.filter(Boolean).join("\n\n") || "(No answer was produced.)",
	}));
}

/** Check the source, not the user-supplied quote text. The browser owns selection;
 * saved lesson context still excludes unrevealed keys and solutions. */
export function validSideQuote(record: ChatRecord, quote: SideChatQuote): boolean {
	const messages = record.messages;
	const calls = collectCalls(messages);
	const source = quote.source;
	if (source.kind === "message") {
		const message = messages.find((item) => item.id === source.messageId);
		if (!message || message.role !== "assistant") return false;
		const assistant = message as AssistantMessage;
		if (["pending", "error", "aborted"].includes(assistant.stopReason)) return false;
		return userFacingTextOf(assistant.content, failedOutputCallIds(messages)).some(text => text.trim().length > 0);
	}

	const call = calls.get(source.toolCallId);
	if (!call || call.message.stopReason === "pending" || call.message.stopReason === "error" || call.message.stopReason === "aborted") return false;
	if (source.kind === "question") {
		if (!(QUESTION_TOOLS as readonly string[]).includes(call.name)) return false;
		const open = questionCallsOf(messages).some((question) => question.toolCallId === source.toolCallId && question.status === "answerable");
		const result = successfulResult(messages, source.toolCallId, call.name);
		const answer = result?.details as QuestionAnswerData | undefined;
		return open || typeof answer?.questionText === "string";
	}

	if (call.name !== PRACTICE_PROBLEM_TOOL || !successfulResult(messages, source.toolCallId, PRACTICE_PROBLEM_TOOL)) return false;
	return typeof call.args?.statement === "string" && call.args.statement.trim().length > 0;
}
