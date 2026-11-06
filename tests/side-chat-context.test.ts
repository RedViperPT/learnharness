import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFauxCore, fauxAssistantMessage, type AssistantMessage, type ToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ChatRecord, SideChatMessage, SideChatQuote, SideChatThread } from "../src/core/contracts/chat.ts";
import { newUserMessage, type LhMessage } from "../src/core/native-messages.ts";
import { newCompactionMarker } from "../src/core/compaction.ts";
import { sideChatModelTurns, sideQuestionContext, sideThreadLessonContext, validSideQuote, type SideLessonItem } from "../src/core/side-chat.ts";
import { SIDE_CONTEXT_ERROR, SIDE_LOOKUP_MAX_ROUNDS, streamSideAnswer } from "../src/agent/side-chat.ts";
import { lookupSideLesson, SIDE_LESSON_PAGE_CHARS } from "../src/agent/tools/side-lesson.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { providerEventsDir, type ProviderEventObserver } from "../src/agent/provider-events.ts";

const text = (value: string) => ({ type: "text" as const, text: value });
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ type: "toolCall", id, name, arguments: args as ToolCall["arguments"] });
function teacher(id: string, value: string, calls: ToolCall[] = []): LhMessage {
	return { ...fauxAssistantMessage("fixture"), id, content: [...(value ? [text(value)] : []), ...calls] } as LhMessage;
}
function answer(id: string, toolCallId: string, toolName: string, details: unknown): LhMessage {
	return { id, role: "toolResult", toolCallId, toolName, details, content: [text("ok")], isError: false, timestamp: Date.now() } as LhMessage;
}
function fixture() {
	const question = { type: "check", nodeId: "fixture", question: "QUESTION-3", details: "VISIBLE-DETAILS", options: [{ label: "OPTION-A", value: "a" }, { label: "OPTION-B", value: "b" }], correctAnswer: "a", explanation: "SECRET-EXPLANATION" };
	const messages = [
		{ ...newUserMessage("USER-1"), id: "u1" },
		teacher("t2", "EXPLANATION-2", [call("q3", "quiz", question)]),
		answer("u4", "q3", "quiz", { kind: "quiz", questionText: "QUESTION-3", text: "RESPONSE-4", explanation: "REVEALED-FEEDBACK", correct: true }),
		teacher("t5", "EXPLANATION-5", [call("q6", "quiz", { ...question, question: "CURRENT-QUESTION-6" })]),
	];
	const quote: SideChatQuote = { text: "EXPLANATION-5", source: { kind: "message", messageId: "t5" } };
	return { messages, quote };
}
function addQuestion(messages: readonly LhMessage[], quotes: SideChatQuote[] = [], previous?: SideChatThread): SideChatThread {
	const thread = previous ?? { id: "side_test", createdAt: "", messages: [] };
	const question: SideChatMessage = { id: `side_user_${thread.messages.length}`, role: "user", text: "Why?", at: "", quotes, lessonContext: sideQuestionContext(messages, thread, quotes) };
	return { ...thread, messages: [...thread.messages, question] };
}

describe("local side-chat lesson context", () => {
	for (const mode of ["quoted", "free-form"] as const) {
		it(`${mode} includes 2, 3, 4, 5 in order, not 1 or current question 6`, () => {
			const { messages, quote } = fixture();
			const context = sideThreadLessonContext(messages, addQuestion(messages, mode === "quoted" ? [quote] : []));
			assert.match(context.document, /EXPLANATION-2[\s\S]*QUESTION-3[\s\S]*RESPONSE-4[\s\S]*EXPLANATION-5/);
			assert.doesNotMatch(context.document, /USER-1|CURRENT-QUESTION-6|SECRET-KEY|SECRET-EXPLANATION/);
			assert.doesNotMatch(JSON.stringify(context.items), /CURRENT-QUESTION-6|SECRET-KEY|SECRET-EXPLANATION/);
			assert.equal(context.document.match(/EXPLANATION-5/g)?.length, 1);
		});
	}

	it("old quotes exclude later explanations from both initial context and lookup authority", () => {
		const { messages } = fixture();
		const quote: SideChatQuote = { text: "EXPLANATION-2", source: { kind: "message", messageId: "t2" } };
		const context = sideThreadLessonContext(messages, addQuestion(messages, [quote]));
		assert.match(context.document, /EXPLANATION-2/);
		assert.doesNotMatch(context.document, /USER-1|QUESTION-3|RESPONSE-4|EXPLANATION-5|CURRENT-QUESTION-6/);
		assert.equal(lookupSideLesson(context.items, "search_lesson", { query: "EXPLANATION-5" }), "No matching earlier lesson items.");
		assert.throws(() => lookupSideLesson(context.items, "read_lesson", { id: "message:t5" }), /unavailable/);
	});

	it("combines multiple quoted sources chronologically without duplicate reference text", () => {
		const { messages, quote } = fixture();
		const quotes: SideChatQuote[] = [quote, { text: "EXPLANATION-2", source: { kind: "message", messageId: "t2" } }, quote];
		const context = sideThreadLessonContext(messages, addQuestion(messages, quotes));
		assert.match(context.document, /EXPLANATION-2[\s\S]*RESPONSE-4[\s\S]*EXPLANATION-5/);
		assert.equal(context.document.match(/EXPLANATION-2/g)?.length, 1);
		assert.equal(context.document.match(/EXPLANATION-5/g)?.length, 1);
		assert.doesNotMatch(context.document, /CURRENT-QUESTION-6/);
	});

	it("allows explicitly quoted open questions with visible details/options, but no hidden answers", () => {
		const { messages } = fixture();
		const quote: SideChatQuote = { text: "CURRENT-QUESTION-6", source: { kind: "question", toolCallId: "q6" } };
		const context = sideThreadLessonContext(messages, addQuestion(messages, [quote]));
		assert.match(context.document, /OPEN question[\s\S]*CURRENT-QUESTION-6[\s\S]*VISIBLE-DETAILS[\s\S]*OPTION-A/);
		assert.doesNotMatch(JSON.stringify(context), /SECRET-KEY|SECRET-EXPLANATION/);
	});

	it("allows quoted active problems but neither initial context nor lookup reveals their solution", () => {
		const { messages } = fixture();
		messages.push(teacher("problem_call", "", [call("p1", "problem", { statement: "ACTIVE-PROBLEM", modelSolution: "HIDDEN-SOLUTION" })]), answer("problem_ack", "p1", "problem", null));
		const quote: SideChatQuote = { text: "ACTIVE-PROBLEM", source: { kind: "problem", toolCallId: "p1" } };
		const context = sideThreadLessonContext(messages, addQuestion(messages, [quote]));
		assert.match(context.document, /OPEN problem[\s\S]*ACTIVE-PROBLEM/);
		assert.doesNotMatch(JSON.stringify(context), /HIDDEN-SOLUTION|CURRENT-QUESTION-6/);
		assert.equal(lookupSideLesson(context.items, "search_lesson", { query: "HIDDEN-SOLUTION" }), "No matching earlier lesson items.");
	});

	it("free-form chat without a teacher explanation starts with no lesson reference or lookup authority", () => {
		const messages = [newUserMessage("ONLY-USER-TEXT"), teacher("question_only", "", [call("q", "quiz", { question: "OPEN-QUESTION", options: ["yes", "no"] })])];
		assert.deepEqual(sideThreadLessonContext(messages, addQuestion(messages)), { document: "", items: [] });
	});

	it("saved free-form anchors survive lesson advancement, JSON round trips, and unquoted follow-ups", () => {
		const { messages } = fixture();
		const first = addQuestion(messages);
		const expected = sideThreadLessonContext(messages, first);
		const advanced = [...messages, answer("u7", "q6", "quiz", { questionText: "CURRENT-QUESTION-6", text: "LATER-ANSWER" }), teacher("t8", "LATER-EXPLANATION")];
		const restored = JSON.parse(JSON.stringify(first)) as SideChatThread;
		const continued = addQuestion(advanced, [], restored);
		assert.deepEqual(continued.messages.at(-1)?.lessonContext, first.messages[0]?.lessonContext);
		assert.deepEqual(sideThreadLessonContext(advanced, continued), expected);
	});

	it("a quoted open question cannot acquire an answer revealed after its saved boundary", () => {
		const { messages } = fixture();
		const first = addQuestion(messages, [{ text: "CURRENT-QUESTION-6", source: { kind: "question", toolCallId: "q6" } }]);
		const advanced = [...messages, answer("u7", "q6", "quiz", { questionText: "CURRENT-QUESTION-6", text: "LATER-ANSWER", explanation: "LATER-REVEAL" })];
		const context = sideThreadLessonContext(advanced, first);
		assert.match(context.document, /OPEN question/);
		assert.doesNotMatch(JSON.stringify(context), /LATER-ANSWER|LATER-REVEAL/);
	});

	it("new quotes extend existing thread anchors and lookup authority without moving old source snapshots", () => {
		const { messages, quote } = fixture();
		const old = addQuestion(messages, [{ text: "EXPLANATION-2", source: { kind: "message", messageId: "t2" } }]);
		const context = sideThreadLessonContext(messages, addQuestion(messages, [quote], old));
		assert.match(context.document, /EXPLANATION-2[\s\S]*EXPLANATION-5/);
		assert.doesNotMatch(JSON.stringify(context), /CURRENT-QUESTION-6/);
	});

	it("can quote and look up saved material before compaction without injecting the summary or entire lesson", () => {
		const { messages, quote } = fixture();
		const marker = newCompactionMarker("SUMMARY-WITH-LATER-DETAILS", { firstKeptMessageId: "t5", tokensBefore: 150_000, at: "" });
		const before = teacher("ancient", "ANCIENT-DEFINITION");
		const all = [before, ...messages, marker];
		const record: ChatRecord = { id: "test", title: "", createdAt: "", updatedAt: "", messages: all };
		assert.equal(validSideQuote(record, { text: "ANCIENT-DEFINITION", source: { kind: "message", messageId: "ancient" } }), true);
		const context = sideThreadLessonContext(all, addQuestion(all, [quote]));
		assert.doesNotMatch(context.document, /SUMMARY-WITH-LATER-DETAILS|ANCIENT-DEFINITION|CURRENT-QUESTION-6/);
		assert.match(lookupSideLesson(context.items, "search_lesson", { query: "ANCIENT-DEFINITION" }), /ANCIENT-DEFINITION/);
	});

	it("never exposes aborted/pending sources, reasoning, raw tools, or summary markers", () => {
		const { messages } = fixture();
		const hidden = teacher("hidden", "ABORTED-PROSE");
		(hidden as AssistantMessage).stopReason = "aborted";
		messages.unshift(hidden, teacher("tool_only", "", [call("secret", "read", { path: "SECRET-PATH" })]));
		const context = sideThreadLessonContext(messages, addQuestion(messages));
		assert.doesNotMatch(JSON.stringify(context), /ABORTED-PROSE|SECRET-PATH/);
	});

	it("does not attach a huge older lesson to a small current source", () => {
		const { messages, quote } = fixture();
		const all = [teacher("huge_old_source", "HUGE-OLD-SOURCE " + "x".repeat(2_000_000)), ...messages];
		const context = sideThreadLessonContext(all, addQuestion(all, [quote]));
		assert.ok(context.document.length < 2_000);
		assert.doesNotMatch(context.document, /HUGE-OLD-SOURCE/);
		const lookup = lookupSideLesson(context.items, "read_lesson", { id: "message:huge_old_source" });
		assert.ok(lookup.length <= SIDE_LESSON_PAGE_CHARS);
		assert.match(lookup, /More content/);
	});
});

describe("bounded side lesson tools", () => {
	it("pages complete items with explicit offsets without dumping them", () => {
		const items: SideLessonItem[] = [{ id: "message:long", kind: "teacher", text: "x".repeat(24_000) + "TAIL" }];
		let offset = 0;
		let pages = 0;
		while (true) {
			const page = lookupSideLesson(items, "read_lesson", { id: items[0]!.id, offset });
			assert.ok(page.length <= SIDE_LESSON_PAGE_CHARS);
			pages++;
			const next = /, offset=(\d+)\./.exec(page);
			if (!next) { assert.match(page, /TAIL/); break; }
			assert.ok(Number(next[1]) > offset);
			offset = Number(next[1]);
		}
		assert.equal(pages, 4);
		assert.throws(() => lookupSideLesson(items, "read_lesson", { id: "message:long", offset: -1 }), /offset/);
		assert.throws(() => lookupSideLesson(items, "read_lesson", { id: "message:long", offset: 0.5 }), /offset/);
	});

	it("returns at most five bounded literal search excerpts", () => {
		const items: SideLessonItem[] = Array.from({ length: 10 }, (_, i) => ({ id: `message:${i}`, kind: "teacher", text: `LITERAL [x] ${"a".repeat(8_000)}` }));
		const hits = lookupSideLesson(items, "search_lesson", { query: "literal [x]" });
		assert.ok(hits.length <= SIDE_LESSON_PAGE_CHARS);
		assert.equal(hits.match(/\[message:/g)?.length, 5);
		assert.match(hits, /5 of 10/);
		assert.throws(() => lookupSideLesson(items, "search_lesson", { query: " " }), /non-empty/);
		assert.throws(() => lookupSideLesson(items, "read", { path: "anything" }), /Unknown side-chat tool/);
	});
});

function streamingSetup(contextWindow?: number) {
	const faux = createFauxCore({ tokensPerSecond: 0 });
	const contexts: TranscriptContext[] = [];
	const sessions: unknown[] = [];
	const model = { ...faux.getModel(), ...(contextWindow !== undefined ? { contextWindow } : {}) };
	const engine: PiEngine = { model, streamFn: ((model, context, options) => {
		contexts.push(structuredClone(context));
		sessions.push((options as { sessionId?: string })?.sessionId);
		return faux.streamSimple(model, context, options);
	}) as PiEngine["streamFn"] };
	return { faux, contexts, sessions, engine };
}

describe("side answer lesson lookup loop", () => {
	for (const enabled of [false, true]) {
		it(`provider recording ${enabled ? "captures every lookup round under the chat with side context" : "stays disabled"}`, async (t) => {
			const previousEnv = process.env.LH_PROVIDER_EVENTS;
			const previousDir = providerEventsDir.current;
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-side-events-"));
			providerEventsDir.current = dir;
			if (enabled) process.env.LH_PROVIDER_EVENTS = "1";
			else delete process.env.LH_PROVIDER_EVENTS;
			t.after(() => {
				if (previousEnv === undefined) delete process.env.LH_PROVIDER_EVENTS;
				else process.env.LH_PROVIDER_EVENTS = previousEnv;
				providerEventsDir.current = previousDir;
				fs.rmSync(dir, { recursive: true, force: true });
			});
			const { faux, engine } = streamingSetup();
			faux.appendResponses([
				fauxAssistantMessage([call("lookup", "search_lesson", { query: "definition" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("Answer after lookup."),
			]);
			const delegate = engine.streamFn;
			let rounds = 0;
			let firstObserver: ProviderEventObserver | undefined;
			engine.streamFn = (model, context, options) => {
				const observer = (options as { onProviderStreamEvent?: ProviderEventObserver })?.onProviderStreamEvent;
				assert.equal(typeof observer, enabled ? "function" : "undefined");
				if (rounds === 0) firstObserver = observer;
				else assert.equal(observer, firstObserver);
				rounds++;
				observer?.({ type: "fixture_raw", round: rounds }, model);
				return delegate(model, context, options);
			};
			const result = await streamSideAnswer({ chatId: "chat_side_trace", engine, instructions: "TEST", turns: [{ role: "user", text: "Explain?" }], lessonItems: [] });
			assert.equal(result.outcome, "done");
			assert.equal(rounds, 2);
			if (enabled) {
				const lines = fs.readFileSync(path.join(dir, "chat_side_trace.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
				assert.deepEqual(lines.map(({ t: timestamp, ...line }) => { assert.equal(typeof timestamp, "number"); return line; }), [1, 2].map(round => ({ ctx: "side", provider: engine.model.provider, model: engine.model.id, event: { type: "fixture_raw", round } })));
			} else assert.deepEqual(fs.readdirSync(dir), []);
		});
	}

	it("looks up missing context, streams the answer, and retains every model call's usage", async () => {
		const { faux, contexts, sessions, engine } = streamingSetup();
		const lookup = fauxAssistantMessage([call("lookup", "search_lesson", { query: "definition" })], { stopReason: "toolUse" });
		faux.appendResponses([lookup, fauxAssistantMessage("The definition explains it.")]);
		const updates: string[] = [];
		const result = await streamSideAnswer({ engine, instructions: "TEST", turns: [{ role: "user", text: "Explain?" }], lessonItems: [{ id: "message:old", kind: "teacher", text: "Earlier definition." }], onText: (text) => updates.push(text) });
		assert.equal(result.outcome, "done");
		assert.equal(result.text, "The definition explains it.");
		assert.equal(result.usages?.length, 2);
		assert.equal(contexts.length, 2);
		assert.match(JSON.stringify(contexts[1]), /Earlier definition/);
		assert.equal(sessions[0], sessions[1]);
		assert.ok(updates.includes("The definition explains it."));
	});

	it("denies direct reads outside the authorized scope even if the model guesses the ID", async () => {
		const { faux, contexts, engine } = streamingSetup();
		faux.appendResponses([fauxAssistantMessage([call("lookup", "read_lesson", { id: "message:later" })], { stopReason: "toolUse" }), fauxAssistantMessage("I cannot see that later explanation.")]);
		const result = await streamSideAnswer({ engine, instructions: "TEST", turns: [{ role: "user", text: "Explain?" }], lessonItems: [] });
		assert.equal(result.outcome, "done");
		assert.match(JSON.stringify(contexts[1]), /unavailable within this thread/);
		assert.equal(result.usages?.length, 2);
	});

	it("refuses oversized combined context before dispatch, without truncating the supplied history", async () => {
		const { contexts, engine } = streamingSetup(18_000);
		const turns = [{ role: "user" as const, text: "x".repeat(10_000) }];
		const before = structuredClone(turns);
		const result = await streamSideAnswer({ engine, instructions: "TEST", turns, lessonItems: [] });
		assert.equal(result.outcome, "error");
		assert.equal(result.errorMessage, SIDE_CONTEXT_ERROR);
		assert.equal(contexts.length, 0);
		assert.deepEqual(turns, before);
	});

	it("checks again after tool output grows context and retains usage from the first call", async () => {
		const { faux, contexts, engine } = streamingSetup(18_000);
		faux.appendResponses([fauxAssistantMessage([call("lookup", "read_lesson", { id: "message:big" })], { stopReason: "toolUse" })]);
		const result = await streamSideAnswer({ engine, instructions: "TEST", turns: [{ role: "user", text: "x".repeat(1_000) }], lessonItems: [{ id: "message:big", kind: "teacher", text: "x".repeat(20_000) }] });
		assert.equal(result.errorMessage, SIDE_CONTEXT_ERROR);
		assert.equal(contexts.length, 1);
		assert.equal(result.usages?.length, 1);
	});

	it("maps provider context failures to actionable guidance, including with an unknown window", async () => {
		const { faux, contexts, engine } = streamingSetup(0);
		faux.appendResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "context_length_exceeded: maximum context length" })]);
		const result = await streamSideAnswer({ engine, instructions: "TEST", turns: [{ role: "user", text: "why" }], lessonItems: [] });
		assert.equal(contexts.length, 1);
		assert.equal(result.errorMessage, SIDE_CONTEXT_ERROR);
	});

	it("stops after eight lookup rounds, removes tools, and displays an explicit limit notice", async () => {
		const { faux, contexts, engine } = streamingSetup();
		faux.appendResponses([
			...Array.from({ length: SIDE_LOOKUP_MAX_ROUNDS }, (_, i) => fauxAssistantMessage([call(`lookup_${i}`, "search_lesson", { query: "definition" })], { stopReason: "toolUse" })),
			fauxAssistantMessage("Based on the available lesson material."),
		]);
		const result = await streamSideAnswer({ engine, instructions: "TEST", turns: [{ role: "user", text: "why" }], lessonItems: [] });
		assert.equal(contexts.length, SIDE_LOOKUP_MAX_ROUNDS + 1);
		assert.equal(result.usages?.length, SIDE_LOOKUP_MAX_ROUNDS + 1);
		assert.match(result.text, /Lesson lookup limit reached/);
		assert.doesNotMatch(JSON.stringify(contexts.at(-1)?.messages[0]), /toolsAdded/);
	});

	it("does not dispatch when already aborted", async () => {
		const { contexts, engine } = streamingSetup();
		const controller = new AbortController();
		controller.abort();
		const result = await streamSideAnswer({ engine, instructions: "TEST", turns: [], lessonItems: [], signal: controller.signal });
		assert.equal(result.outcome, "aborted");
		assert.equal(contexts.length, 0);
	});

	it("keeps all existing side messages and quotes in model history", () => {
		const { messages, quote } = fixture();
		const thread = addQuestion(messages, [quote]);
		thread.messages.push({ id: "a", role: "assistant", text: "Old answer", at: "" });
		const continued = addQuestion(messages, [], thread);
		const turns = sideChatModelTurns(continued, sideThreadLessonContext(messages, continued).document);
		assert.equal(turns.length, 3);
		assert.match(turns[0]!.text, /<quote>\nEXPLANATION-5/);
		assert.equal(turns[1]!.text, "Old answer");
	});
});
