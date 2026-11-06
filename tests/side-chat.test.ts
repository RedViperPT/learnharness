import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	type AssistantMessage,
	type ToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ChatRecord, LhMessage, SideChatQuote, SideChatThread } from "../src/core/index.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { subscribe } from "../src/core/events.ts";
import {
	parseSideAskInput,
	SideChatInputError,
	sideChatModelTurns,
	sideChatLessonDocument,
	validSideQuote,
} from "../src/core/side-chat.ts";
import { newCompactionMarker } from "../src/core/compaction.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-side-chat-test-"));
process.env.LH_DATA_DIR = temp;

const [{ chatStore }, { createSideChatService }, { composeSideChatInstructions }] = await Promise.all([
	import("../src/store/chats.ts"),
	import("../src/server/side-chat.ts"),
	import("../src/agent/side-chat.ts"),
]);

after(() => fs.rmSync(temp, { recursive: true, force: true }));

let sequence = 0;
const text = (value: string) => ({ type: "text" as const, text: value });
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
	type: "toolCall",
	id,
	name,
	arguments: args as ToolCall["arguments"],
});

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): LhMessage {
	return {
		...fauxAssistantMessage("fixture"),
		id: `msg_fixture_${sequence++}`,
		content,
		stopReason,
	} as LhMessage;
}

function result(toolCallId: string, toolName: string, details: unknown = null, isError = false): LhMessage {
	return {
		role: "toolResult",
		id: `result_${sequence++}`,
		toolCallId,
		toolName,
		content: [text("ok")],
		details,
		isError,
		timestamp: Date.now(),
	} as LhMessage;
}

const quizArgs = {
	type: "check",
	nodeId: "limits",
	question: "Which limit defines the derivative?",
	details: "Use the definition, not the area rule.",
	options: [
		{ label: "Difference quotient as h→0", value: "dq" },
		{ label: "Area under the curve", value: "area" },
	],
	correctAnswer: "dq",
	explanation: "SECRET-EXPLANATION",
};

const lessonRecord = (messages: LhMessage[]): ChatRecord => ({
	id: "fixture",
	title: "Fixture",
	createdAt: "",
	updatedAt: "",
	messages,
});

interface WireLine {
	type: string;
	thread?: SideChatThread;
	text?: string;
	error?: string;
}

async function readLines(response: Response): Promise<WireLine[]> {
	return (await response.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line) as WireLine);
}

function setup(tokensPerSecond = 0) {
	const faux = createFauxCore({ tokensPerSecond });
	const contexts: TranscriptContext[] = [];
	const engine: PiEngine = {
		model: faux.getModel(),
		streamFn: ((model, context, options) => {
			contexts.push(structuredClone(context) as TranscriptContext);
			return faux.streamSimple(model, context, options);
		}) as PiEngine["streamFn"],
	};
	const service = createSideChatService({
		chatStore,
		engineFor: async () => engine,
		instructions: () => "TEST-SIDE-INSTRUCTIONS",
	});
	const chat = chatStore.createChat("Side-chat fixture");
	const prose = assistant([text("A limit describes an approaching value.")]);
	chatStore.saveMessages(chat.id, [prose]);
	return { chatId: chat.id, contexts, faux, service, prose };
}

describe("side ask parsing", () => {
	it("supports a general question without a source or quote", () => {
		assert.deepEqual(parseSideAskInput({ text: "  Why?  " }), { text: "Why?", quotes: [] });
	});

	it("accepts a sourced quote with a bounded selector", () => {
		const parsed = parseSideAskInput({
			text: "Why?",
			quotes: [{
				text: "passage",
				source: { kind: "message", messageId: "msg_1" },
				selector: { start: 0, end: 7, prefix: "", suffix: "next" },
			}],
		});
		assert.equal("quotes" in parsed && parsed.quotes[0]?.source.kind, "message");
	});

	it("preserves explicit text/math segments only when they reconstruct the canonical quote text", () => {
		const quote: SideChatQuote = {
			text: "**literal** $x$ and $$y^2$$",
			source: { kind: "message", messageId: "msg_1" },
			segments: [
				{ kind: "text", text: "**literal** $x$ and " },
				{ kind: "math", tex: "y^2", display: true },
			],
		};
		const parsed = parseSideAskInput(JSON.parse(JSON.stringify({ text: "Why?", quotes: [quote] })));
		assert.deepEqual("quotes" in parsed && parsed.quotes[0], quote);
		for (const segments of [null, {}, [], [null], [{ kind: "html", text: quote.text }],
			[{ kind: "text", text: "" }], [{ kind: "text", text: "different" }],
			[{ kind: "text", text: quote.text }, { kind: "text", text: "extra" }],
			[{ kind: "math", tex: "x", display: "false" }], [{ kind: "math", tex: "", display: false }],
			[{ kind: "math", tex: "x" }], [{ kind: "math", tex: "y^2", display: false }],
			[{ kind: "text", text: "x".repeat(8_001) }],
		]) {
			assert.throws(() => parseSideAskInput({ text: "Why?", quotes: [{ ...quote, segments }] }), SideChatInputError);
		}
	});

	it("rejects oversized input, malformed and empty quotes, excessive quotes and invalid selectors without clipping", () => {
		const source = { kind: "message", messageId: "msg_1" };
		const invalid = [
			{ text: "x".repeat(8_001) },
			{ text: "q", quotes: [{ text: "x".repeat(8_001), source }] },
			{ text: "q", quotes: [{ text: "  ", source }] },
			{ text: "q", quotes: Array.from({ length: 6 }, () => ({ text: "x", source })) },
			{ text: "q", quotes: [{ text: "x", source, selector: { start: 4, end: 4, prefix: "", suffix: "" } }] },
			{ retry: true },
		];
		for (const body of invalid) assert.throws(() => parseSideAskInput(body), SideChatInputError);
	});

	it("replays only its own thread history and carries the lesson and selected passages as references", () => {
		const thread: SideChatThread = {
			id: "side_a",
			createdAt: "",
			messages: [
				{ id: "u1", role: "user", text: "why?", quotes: [{ text: "Selected", source: { kind: "message", messageId: "msg_1" } }], at: "" },
				{ id: "a1", role: "assistant", text: "Because.", at: "" },
				{ id: "u2", role: "user", text: "again?", at: "" },
			],
		};
		const turns = sideChatModelTurns(thread, "LESSON");
		assert.deepEqual(turns.map((turn) => turn.role), ["user", "assistant", "user"]);
		assert.match(turns[0]!.text, /<lesson>\nLESSON\n<\/lesson>/);
		assert.match(turns[0]!.text, /<quote>\nSelected\n<\/quote>/);
		assert.doesNotMatch(turns[2]!.text, /LESSON|Selected/);
	});
});

describe("quote source admission (quote text is user-supplied)", () => {
	it("matches DOM selections across emphasis, code, math, and paragraph whitespace", () => {
		const prose = assistant([text("A **bold phrase** and `code_token`, with $x_1$ and $$\\frac{1}{2}$$ here. [visible link](https://hidden.example/path)\n\nSecond paragraph.")]);
		const record = lessonRecord([prose]);
		const quote = (selected: string) => ({ text: selected, source: { kind: "message" as const, messageId: prose.id } });
		assert.equal(validSideQuote(record, quote("bold phrase")), true);
		assert.equal(validSideQuote(record, quote("code_token")), true);
		assert.equal(validSideQuote(record, quote("$x_1$")), true);
		assert.equal(validSideQuote(record, quote("$\\frac{1}{2}$")), true);
		assert.equal(validSideQuote(record, quote("phrase and code_token, with $x_1$")), true);
		assert.equal(validSideQuote(record, quote("visible link")), true);
		assert.equal(validSideQuote(record, quote("My paraphrase, absent from the source")), true);
		assert.equal(validSideQuote(record, quote("visible link\nSecond paragraph")), true);
	});

	it("matches multiple text parts and preserves literal code, entities, and backslash math", () => {
		const prose = assistant([
			text("First **part** ends here."),
			text("Second part contains &amp; and `literal **stars** $x$`.\n\n```js\nconst price = '$value$';\n```\n\nLegacy \\(x_2\\) notation."),
		]);
		const record = lessonRecord([prose]);
		const quote = (selected: string) => ({ text: selected, source: { kind: "message" as const, messageId: prose.id } });
		assert.equal(validSideQuote(record, quote("part ends here.\nSecond part contains &")), true);
		assert.equal(validSideQuote(record, quote("literal **stars** $x$")), true);
		assert.equal(validSideQuote(record, quote("const price = '$value$';")), true);
		assert.equal(validSideQuote(record, quote("Legacy $x_2$ notation.")), true);
		assert.equal(validSideQuote(record, quote("literal stars $x$")), true, "quote accuracy is not server-verified");
	});

	it("accepts captured TeX regardless of source escaping", () => {
		const raw = String.raw`$\\nabla f$`;
		const displayed = String.raw`$\nabla f$`;
		const question = assistant([call("q_repaired", "quiz", { ...quizArgs, question: `Interpret ${raw}.` })]);
		assert.equal(validSideQuote(lessonRecord([question]), { text: displayed, source: { kind: "question", toolCallId: "q_repaired" } }), true);
		const problem = assistant([call("p_repaired", "problem", { statement: `Interpret ${raw}.`, modelSolution: "SECRET" })]);
		assert.equal(validSideQuote(lessonRecord([problem, result("p_repaired", "problem", null)]), { text: displayed, source: { kind: "problem", toolCallId: "p_repaired" } }), true);
		const prose = assistant([text(`Interpret ${raw}.`)]);
		assert.equal(validSideQuote(lessonRecord([prose]), { text: displayed, source: { kind: "message", messageId: prose.id } }), true);
	});

	it("rejects pending, failed, and fabricated sources", () => {
		const pending = assistant([text("Visible"), call("q_pending", "quiz", quizArgs)], "pending");
		const pendingRecord = lessonRecord([pending]);
		assert.equal(validSideQuote(pendingRecord, { text: "SECRET-EXPLANATION", source: { kind: "question", toolCallId: "q_pending" } }), false);
		const failed = assistant([text("Visible"), call("send_failed", "send_to_user", { message: "Not delivered" })], "error");
		const failedRecord = lessonRecord([failed]);
		assert.equal(validSideQuote(failedRecord, { text: "Not delivered", source: { kind: "message", messageId: failed.id } }), false);
		assert.doesNotMatch(sideChatLessonDocument([failed]), /Not delivered/);
		assert.equal(validSideQuote(failedRecord, { text: "SECRET", source: { kind: "problem", toolCallId: "ghost" } }), false);
	});

	it("accepts an open question source without verifying the supplied text", () => {
		const quiz = assistant([call("q_open", "quiz", quizArgs)]);
		const record = lessonRecord([quiz]);
		const quote = (value: string) => ({ text: value, source: { kind: "question" as const, toolCallId: "q_open" } });
		assert.equal(validSideQuote(record, quote("Which limit defines the derivative?")), true);
		assert.equal(validSideQuote(record, quote("Use the definition")), true);
		assert.equal(validSideQuote(record, quote("Difference quotient as h→0")), true);
		assert.equal(validSideQuote(record, quote("Learner-supplied words")), true);
		assert.doesNotMatch(sideChatLessonDocument(record.messages), /SECRET-EXPLANATION/);
	});

	it("accepts delivered problem sources and still hides solutions from lesson context", () => {
		const pose = assistant([call("p_quote", "problem", { statement: "Integrate $x$.", modelSolution: "SECRET-SOLUTION" })]);
		const record = lessonRecord([pose, result("p_quote", "problem")]);
		const quote = (value: string) => ({ text: value, source: { kind: "problem" as const, toolCallId: "p_quote" } });
		assert.equal(validSideQuote(record, quote("Integrate $x$")), true);
		assert.equal(validSideQuote(record, quote("Learner-supplied words")), true);
		assert.doesNotMatch(sideChatLessonDocument(record.messages), /SECRET-SOLUTION/);
		assert.equal(validSideQuote(lessonRecord([pose, result("p_quote", "problem", null, true)]), quote("Integrate $x$")), false);
	});
});

describe("lesson document disclosure", () => {
	it("renders active problem statement and saved practice thinking but hides its solution", () => {
		const pose = assistant([call("p_active", "problem", { statement: "Integrate x dx.", modelSolution: "SECRET-SOLUTION x²/2" })]);
		const active = [pose, result("p_active", "problem"), {
			role: "custom",
			id: "thinking_1",
			customType: "practice-thinking",
		details: { text: "Maybe use the power rule." },
			timestamp: Date.now(),
		} as LhMessage];
		const document = sideChatLessonDocument(active);
		assert.match(document, /OPEN problem/);
		assert.match(document, /Integrate x dx/);
		assert.match(document, /Maybe use the power rule/);
		assert.doesNotMatch(document, /SECRET-SOLUTION/);
	});

	it("renders open check options and omits keys, then shows completed assessments readably", () => {
		const open = sideChatLessonDocument([assistant([call("q_open", "quiz", quizArgs)])]);
		assert.match(open, /OPEN question/);
		assert.match(open, /Difference quotient as h→0/);
		assert.match(open, /Area under the curve/);
		assert.doesNotMatch(open, /SECRET-EXPLANATION|correctAnswer|\bdq\b/);

		const completed = sideChatLessonDocument([
			assistant([call("q_done", "quiz", quizArgs)]),
			result("q_done", "quiz", {
				kind: "quiz",
				questionText: quizArgs.question,
				options: [{ index: 0, label: "Difference quotient as h→0" }, { index: 1, label: "Area under the curve" }],
				answers: [{ index: 0, label: "Difference quotient as h→0", value: "dq" }],
				correctIndices: [0],
				correct: true,
				explanation: "The limit of secants gives the derivative.",
			}),
		]);
		assert.match(completed, /Check question \(answered\)/);
		assert.match(completed, /Verdict: correct/);
		assert.match(completed, /The limit of secants/);
	});

	it("reveals a problem solution only after a successful conclude", () => {
		const pose = assistant([call("p_done", "problem", { statement: "Integrate x dx.", modelSolution: "x²/2 + C" })]);
		const active = sideChatLessonDocument([pose, result("p_done", "problem")]);
		assert.doesNotMatch(active, /x²\/2 \+ C/);

		const complete = sideChatLessonDocument([
			pose,
			result("p_done", "problem"),
			assistant([call("conclude_1", "conclude", { outcome: "solved", verdict: "The power rule applies." })]),
			result("conclude_1", "conclude"),
		]);
		assert.match(complete, /Problem/);
		assert.match(complete, /x²\/2 \+ C/);
	});
});

describe("side-chat service", () => {
	it("persists creation correlation in list and stream payloads without replacing it on follow-up or retry", async () => {
		const { chatId, faux, service } = setup();
		const creationRequestId = `${Date.now()}_${crypto.randomUUID()}`;
		faux.appendResponses([fauxAssistantMessage("First answer.")]);
		const response = await service.ask(chatId, { requestId: creationRequestId, text: "Why?", quotes: [] });
		const listed = service.list(chatId)!.threads[0]!;
		assert.equal(listed.creationRequestId, creationRequestId);
		const first = await readLines(response);
		assert.equal(first[0]!.thread!.creationRequestId, creationRequestId);
		assert.equal(first.at(-1)!.thread!.creationRequestId, creationRequestId);
		assert.equal(chatStore.getChat(chatId)!.sideChats![0]!.creationRequestId, creationRequestId);

		faux.appendResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Try again" })]);
		await readLines(await service.ask(chatId, { requestId: `${Date.now()}_${crypto.randomUUID()}`, threadId: listed.id, text: "And?", quotes: [] }));
		faux.appendResponses([fauxAssistantMessage("Retried answer.")]);
		const retried = await readLines(await service.ask(chatId, { requestId: `${Date.now()}_${crypto.randomUUID()}`, threadId: listed.id, retry: true }));
		assert.equal(retried.at(-1)!.thread!.creationRequestId, creationRequestId);
		assert.equal(service.list(chatId)!.threads[0]!.creationRequestId, creationRequestId);
	});

	it("keeps legacy threads without creation metadata readable and usable", async () => {
		const { chatId, faux, service } = setup();
		faux.appendResponses([fauxAssistantMessage("Legacy answer.")]);
		const first = await readLines(await service.ask(chatId, { text: "Legacy question", quotes: [] }));
		const saved = first.at(-1)!.thread!;
		assert.equal(Object.hasOwn(saved, "creationRequestId"), false);
		faux.appendResponses([fauxAssistantMessage("Follow-up answer.")]);
		await readLines(await service.ask(chatId, { requestId: `${Date.now()}_${crypto.randomUUID()}`, threadId: saved.id, text: "Continue", quotes: [] }));
		assert.equal(Object.hasOwn(service.list(chatId)!.threads[0]!, "creationRequestId"), false);
	});

	for (const failed of [false, true]) {
		it(`scopes old quotes and lookup authority through the service and retains every ${failed ? "failed" : "completed"} answer step`, async () => {
			const { chatId, contexts, faux, service, prose } = setup();
			const ancient = assistant([text("ANCIENT-DEFINITION")]);
			const preceding = assistant([text("PRECEDING-EXPLANATION")]);
			const later = assistant([text("LATER-UNRELATED-EXPLANATION")]);
			chatStore.saveMessages(chatId, [ancient, preceding, prose, later]);
			faux.appendResponses([
				fauxAssistantMessage([
					call("search_earlier", "search_lesson", { query: "ANCIENT-DEFINITION" }),
					call("read_earlier", "read_lesson", { id: `message:${ancient.id}` }),
					call("read_later", "read_lesson", { id: `message:${later.id}` }),
				], { stopReason: "toolUse" }),
				fauxAssistantMessage("Answer after lookup.", failed ? { stopReason: "error", errorMessage: "provider failure" } : {}),
			]);
			const lines = await readLines(await service.ask(chatId, {
				text: "Explain the old passage.",
				quotes: [{ text: "A limit", source: { kind: "message", messageId: prose.id } }],
			}));
			assert.equal(lines.at(-1)?.type, "done");
			assert.equal(contexts.length, 2);
			assert.match(JSON.stringify(contexts[0]), /PRECEDING-EXPLANATION/);
			assert.doesNotMatch(JSON.stringify(contexts[0]), /ANCIENT-DEFINITION|LATER-UNRELATED-EXPLANATION/);
			assert.match(JSON.stringify(contexts[1]), /ANCIENT-DEFINITION/);
			assert.match(JSON.stringify(contexts[1]), /unavailable within this thread's source boundary/);
			assert.doesNotMatch(JSON.stringify(contexts[1]), /LATER-UNRELATED-EXPLANATION|Cannot read properties/);
			const saved = chatStore.getChat(chatId)!;
			const thread = saved.sideChats![0]!;
			assert.deepEqual(thread.messages[0]!.lessonContext, {
				sources: [{ kind: "message", messageId: prose.id }], throughMessageId: later.id,
			});
			assert.deepEqual(lines[0]!.thread!.messages[0]!.lessonContext, thread.messages[0]!.lessonContext);
			assert.equal(thread.messages.at(-1)?.error, failed ? "provider failure" : undefined);
			assert.equal(saved.turns?.length, 1);
			assert.equal(saved.turns[0]!.kind, "side-question");
			assert.equal(saved.turns[0]!.messageId, thread.messages.at(-1)!.id);
			assert.equal(saved.turns[0]!.steps.length, 2);
			assert.ok(saved.turns[0]!.steps.every((step) => (step.outputTokens ?? 0) > 0));
		});
	}

	for (const quoted of [false, true]) {
		it(`keeps ${quoted ? "quoted" : "free-form"} follow-ups frozen across lesson advancement until a new quote extends the scope`, async () => {
			const { chatId, contexts, faux, service, prose } = setup();
			faux.appendResponses([fauxAssistantMessage("First side answer.")]);
			await (await service.ask(chatId, {
				text: "Why?",
				quotes: quoted ? [{ text: "A limit", source: { kind: "message", messageId: prose.id } }] : [],
			})).text();
			const first = chatStore.getChat(chatId)!.sideChats![0]!;
			const savedContext = first.messages[0]!.lessonContext;
			assert.deepEqual(savedContext, { sources: [{ kind: "message", messageId: prose.id }], throughMessageId: prose.id });
			const later = assistant([text("NEW-LESSON-EXPLANATION")]);
			chatStore.saveMessages(chatId, [prose, later]);
			faux.appendResponses([fauxAssistantMessage("Follow-up answer.")]);
			await (await service.ask(chatId, { threadId: first.id, text: "Explain again.", quotes: [] })).text();
			let thread = chatStore.getChat(chatId)!.sideChats![0]!;
			assert.deepEqual(thread.messages[2]!.lessonContext, savedContext);
			assert.doesNotMatch(JSON.stringify(contexts[1]), /NEW-LESSON-EXPLANATION/);
			assert.match(JSON.stringify(contexts[1]), /First side answer/);
			faux.appendResponses([fauxAssistantMessage("Answer about the new quote.")]);
			await (await service.ask(chatId, {
				threadId: first.id, text: "And this?",
				quotes: [{ text: "NEW-LESSON-EXPLANATION", source: { kind: "message", messageId: later.id } }],
			})).text();
			thread = chatStore.getChat(chatId)!.sideChats![0]!;
			assert.deepEqual(thread.messages[0]!.lessonContext, savedContext);
			assert.deepEqual(thread.messages[4]!.lessonContext, {
				sources: [{ kind: "message", messageId: prose.id }, { kind: "message", messageId: later.id }],
				throughMessageId: later.id,
			});
			assert.match(JSON.stringify(contexts[2]), /NEW-LESSON-EXPLANATION/);
		});
	}

	it("retries a quoted open question without acquiring its later answer or later lesson content", async () => {
		const { chatId, contexts, faux, service, prose } = setup();
		const question = assistant([call("snapshot_question", "quiz", quizArgs)]);
		chatStore.saveMessages(chatId, [prose, question]);
		faux.appendResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failure" })]);
		await (await service.ask(chatId, {
			text: "Clarify the wording.",
			quotes: [{ text: quizArgs.question, source: { kind: "question", toolCallId: "snapshot_question" } }],
		})).text();
		const first = chatStore.getChat(chatId)!.sideChats![0]!;
		const later = assistant([text("LATER-LESSON-CONTENT")]);
		chatStore.saveMessages(chatId, [prose, question, result("snapshot_question", "quiz", {
			questionText: quizArgs.question, text: "LATER-ANSWER", explanation: "LATER-REVEAL",
		}), later]);
		faux.appendResponses([
			fauxAssistantMessage([call("retry_read", "read_lesson", { id: `message:${later.id}` })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Clarification only."),
		]);
		await (await service.ask(chatId, { threadId: first.id, retry: true })).text();
		const retried = chatStore.getChat(chatId)!.sideChats![0]!;
		assert.equal(retried.messages.length, 2);
		assert.deepEqual(retried.messages[0], first.messages[0]);
		assert.match(JSON.stringify(contexts[1]), /OPEN question/);
		assert.match(JSON.stringify(contexts[2]), /unavailable within this thread/);
		assert.doesNotMatch(JSON.stringify(contexts.slice(1)), /LATER-ANSWER|LATER-REVEAL|LATER-LESSON-CONTENT|SECRET-EXPLANATION/);
	});

	for (const retry of [false, true]) {
		for (const quoted of [false, true]) {
			it(`freezes missing legacy ${quoted ? "quoted" : "free-form"} boundaries on ${retry ? "retry" : "follow-up"} admission`, async () => {
				const { chatId, contexts, faux, service, prose } = setup();
				const current = assistant([text("CURRENT-LEGACY-EXPLANATION")]);
				chatStore.saveMessages(chatId, [prose, current]);
				const legacy: SideChatThread = { id: "side_legacy", createdAt: "", messages: [
					{ id: "legacy_user", role: "user", text: "Old question", at: "", ...(quoted ? {
						quotes: [{ text: "A limit", source: { kind: "message" as const, messageId: prose.id } }],
					} : {}) },
					...(!retry ? [{ id: "legacy_answer", role: "assistant" as const, text: "Old answer", at: "" }] : []),
				] };
				chatStore.updateSideChats(chatId, () => [legacy]);
				faux.appendResponses([fauxAssistantMessage("New side answer.")]);
				await (await service.ask(chatId, retry
					? { threadId: legacy.id, retry: true }
					: { threadId: legacy.id, text: "Continue.", quotes: [] })).text();
				const admitted = chatStore.getChat(chatId)!.sideChats![0]!;
				const expected = {
					sources: [{ kind: "message", messageId: quoted ? prose.id : current.id }], throughMessageId: current.id,
				};
				assert.deepEqual(admitted.messages[0]!.lessonContext, expected);
				if (!retry) assert.deepEqual(admitted.messages[2]!.lessonContext, expected);
				const later = assistant([text("LATER-LEGACY-EXPLANATION")]);
				chatStore.saveMessages(chatId, [prose, current, later]);
				faux.appendResponses([fauxAssistantMessage("Still on the frozen sources.")]);
				await (await service.ask(chatId, { threadId: legacy.id, text: "Continue again.", quotes: [] })).text();
				const continued = chatStore.getChat(chatId)!.sideChats![0]!;
				assert.deepEqual(continued.messages.at(-2)!.lessonContext, expected);
				assert.doesNotMatch(JSON.stringify(contexts[1]), /LATER-LEGACY-EXPLANATION/);
				if (quoted) assert.doesNotMatch(JSON.stringify(contexts), /CURRENT-LEGACY-EXPLANATION/);
			});
		}
	}

	it("passes user-supplied quote text through without requiring an exact source match", async () => {
		const { chatId, contexts, service, prose } = setup();
		const response = await service.ask(chatId, { text: "Why?", quotes: [
			{ text: "My paraphrase with $x^2$", source: { kind: "message", messageId: prose.id } },
		] });
		assert.equal(response.status, 200);
		await response.text();
		assert.match(JSON.stringify(contexts), /My paraphrase with \$x\^2\$/);
	});

	it("retains captured segments across request parsing, persistence, and reloading without changing model quote text", async () => {
		const { chatId, contexts, service, prose, faux } = setup();
		const quote: SideChatQuote = {
			text: "**literal** $x$ and $x^2$",
			source: { kind: "message", messageId: prose.id },
			selector: { start: 0, end: 25, prefix: "", suffix: "" },
			segments: [
				{ kind: "text", text: "**literal** $x$ and " },
				{ kind: "math", tex: "x^2", display: false },
			],
		};
		faux.appendResponses([fauxAssistantMessage("An answer.")]);
		const input = parseSideAskInput(JSON.parse(JSON.stringify({ text: "Explain", quotes: [quote] })));
		const lines = await readLines(await service.ask(chatId, input));
		assert.deepEqual(lines.at(-1)?.thread?.messages[0]?.quotes, [quote]);
		const saved = chatStore.getChat(chatId)!.sideChats![0]!;
		assert.deepEqual(saved.messages[0]?.quotes, [quote]);
		assert.deepEqual(service.list(chatId)?.threads[0]?.messages[0]?.quotes, [quote]);
		assert.match(JSON.stringify(contexts), /\*\*literal\*\* \$x\$ and \$x\^2\$/);
	});

	it("identifies an unavailable source and returns recovery guidance before saving or inference", async () => {
		const { chatId, contexts, service, prose } = setup();
		const response = await service.ask(chatId, { text: "Why?", quotes: [
			{ text: "A limit", source: { kind: "message", messageId: prose.id } },
			{ text: "invented text", source: { kind: "message", messageId: "missing_source" } },
		] });
		assert.equal(response.status, 400);
		const detail = await response.json();
		assert.equal(detail.code, "invalid_quote");
		assert.equal(detail.quoteIndex, 1);
		assert.match(detail.error, /Quote 2.*Select.*remove.*kept/);
		assert.equal(contexts.length, 0);
		assert.equal(chatStore.getChat(chatId)!.sideChats, undefined);
	});
	it("streams and persists answers without changing lesson activity, and retains usage", async () => {
		const { chatId, contexts, faux, service } = setup();
		const events: string[] = [];
		const unsubscribe = subscribe((event) => {
			if ("chatId" in event && event.chatId === chatId) events.push(event.type);
		});
		faux.appendResponses([fauxAssistantMessage("It approaches without being equal.")]);
		const before = chatStore.getChat(chatId)!;
		const lines = await readLines(await service.ask(chatId, { text: "Why approach?", quotes: [] }));
		unsubscribe();
		assert.equal(lines[0]?.type, "thread");
		assert.equal(lines.at(-1)?.type, "done");
		const saved = chatStore.getChat(chatId)!;
		assert.deepEqual(saved.messages, before.messages);
		assert.equal(saved.updatedAt, before.updatedAt);
		assert.equal(saved.sideChats?.[0]?.messages.at(-1)?.text, "It approaches without being equal.");
		assert.equal(saved.turns?.length, 1);
		assert.match(JSON.stringify(contexts[0]), /TEST-SIDE-INSTRUCTIONS/);
		assert.ok(events.includes("side-chats-changed"));
		assert.equal(events.includes("record-changed"), false, "side settlement must not wake or replace the main transcript");
	});

	it("refuses missing chats, unknown threads, provider refusals, and busy threads", async () => {
		const { chatId, faux, service } = setup();
		assert.equal((await service.ask("missing", { text: "q", quotes: [] })).status, 404);
		assert.equal((await service.ask(chatId, { threadId: "side_missing", text: "q", quotes: [] })).status, 404);
		const refusing = createSideChatService({
			chatStore,
			engineFor: async () => Response.json({ error: "No model configured" }, { status: 503 }),
			instructions: () => "",
		});
		assert.equal((await refusing.ask(chatId, { text: "q", quotes: [] })).status, 503);
		assert.equal(chatStore.getChat(chatId)?.sideChats, undefined);
		const failing = createSideChatService({
			chatStore,
			engineFor: async () => { throw new Error("Provider key unavailable"); },
			instructions: () => "",
		});
		assert.equal((await failing.ask(chatId, { text: "q", quotes: [] })).status, 503);
		assert.equal(chatStore.getChat(chatId)?.sideChats, undefined);

		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		faux.appendResponses([async () => { await gate; return fauxAssistantMessage("held"); }]);
		const response = await service.ask(chatId, { text: "first", quotes: [] });
		const threadId = chatStore.getChat(chatId)!.sideChats![0]!.id;
		assert.equal((await service.ask(chatId, { threadId, text: "second", quotes: [] })).status, 409);
		release();
		await response.text();
	});

	it("allows independent threads and continues after the stream view disconnects", async () => {
		const { chatId, faux, service } = setup();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		faux.appendResponses([
			async () => { await gate; return fauxAssistantMessage("first answer"); },
			() => fauxAssistantMessage("second answer"),
		]);
		const first = await service.ask(chatId, { text: "first", quotes: [] });
		const firstThread = chatStore.getChat(chatId)!.sideChats![0]!;
		const reader = first.body!.getReader();
		await reader.read();
		await reader.cancel();
		const second = await service.ask(chatId, { text: "independent", quotes: [] });
		await second.text();
		release();
		await service.settled(chatId, firstThread.id);
		const threads = chatStore.getChat(chatId)!.sideChats!;
		assert.equal(threads.length, 2);
		assert.equal(threads[0]?.messages.at(-1)?.text, "first answer");
		assert.equal(threads[1]?.messages.at(-1)?.text, "second answer");
	});

	it("stops partial output and retries failed answers without allowing consecutive unanswered questions", async () => {
		// Keep generation live beyond the shared snapshot flush window so the
		// stop exercises partial output, not an already-completed burst.
		const { chatId, faux, service } = setup(100);
		faux.appendResponses([fauxAssistantMessage("partial ".repeat(300))]);
		const first = await service.ask(chatId, { text: "q", quotes: [] });
		const threadId = chatStore.getChat(chatId)!.sideChats![0]!.id;
		const reader = first.body!.getReader();
		const decoder = new TextDecoder();
		let received = "";
		while (!received.includes('"type":"text"')) {
			const item = await reader.read();
			received += decoder.decode(item.value, { stream: !item.done });
			if (item.done) break;
		}
		assert.equal(service.stop(chatId, threadId), true);
		await service.settled(chatId, threadId);
		const stopped = chatStore.getChat(chatId)!.sideChats![0]!.messages.at(-1)!;
		assert.equal(stopped.stopped, true);
		assert.ok(stopped.text.length > 0 && stopped.text.length < "partial ".repeat(300).length);
		assert.equal(service.stop(chatId, threadId), false);
		await reader.cancel();

		faux.appendResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failure" })]);
		await (await service.ask(chatId, { text: "another question", quotes: [] })).text();
		const failedThread = chatStore.getChat(chatId)!.sideChats![1]!;
		assert.equal(failedThread.messages.at(-1)?.error, "provider failure");
		faux.appendResponses([fauxAssistantMessage("recovered")]);
		const retry = await service.ask(chatId, { threadId: failedThread.id, retry: true });
		await retry.text();
		assert.equal(chatStore.getChat(chatId)!.sideChats![1]!.messages.at(-1)?.text, "recovered");
		assert.equal((await service.ask(chatId, { threadId: failedThread.id, retry: true })).status, 409);
		faux.appendResponses([fauxAssistantMessage("follow-up answer")]);
		const followup = await service.ask(chatId, { threadId: failedThread.id, text: "follow up", quotes: [] });
		assert.equal(followup.status, 200);
		await followup.text();
	});

	it("deletes a running thread without resurrection and keeps its incurred usage", async () => {
		const { chatId, faux, service } = setup();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		faux.appendResponses([async () => { await gate; return fauxAssistantMessage("deleted answer"); }]);
		const response = await service.ask(chatId, { text: "q", quotes: [] });
		const threadId = chatStore.getChat(chatId)!.sideChats![0]!.id;
		assert.equal(service.remove(chatId, threadId), "ok");
		release();
		await response.text();
		await service.settled(chatId, threadId);
		const saved = chatStore.getChat(chatId)!;
		assert.equal(saved.sideChats, undefined);
		assert.equal(saved.turns?.length, 1);
		assert.equal(saved.turns[0]!.kind, "side-question");
	});

	for (const failure of ["answer", "usage", "both", "deleted-usage"] as const) {
		it(`reports incomplete settlement after ${failure} persistence failure and attempts both required writes`, async () => {
			const { chatId, faux } = setup();
			let answerAttempts = 0;
			let usageAttempts = 0;
			let settling = false;
			const service = createSideChatService({
				chatStore: {
					...chatStore,
					updateSideChats(id, update) {
						if (settling) {
							answerAttempts++;
							if (failure === "answer" || failure === "both") throw new Error("answer disk error");
						}
						return chatStore.updateSideChats(id, update);
					},
					appendTurnUsage(id, entry) {
						usageAttempts++;
						if (failure !== "answer") throw new Error("usage disk error");
						chatStore.appendTurnUsage(id, entry);
					},
				},
				engineFor: async () => ({ model: faux.getModel(), streamFn: faux.streamSimple }),
				instructions: () => "SIDE",
			});
			let release!: () => void;
			const gate = new Promise<void>(resolve => { release = resolve; });
			faux.appendResponses([async () => { await gate; return fauxAssistantMessage("Generated answer"); }]);
			const response = await service.ask(chatId, { text: "q", quotes: [] });
			const threadId = chatStore.getChat(chatId)!.sideChats![0]!.id;
			if (failure === "deleted-usage") assert.equal(service.remove(chatId, threadId), "ok");
			settling = true;
			release();
			const lines = await readLines(response);
			assert.equal(lines.at(-1)?.type, "error");
			assert.equal(lines.filter(line => line.type === "done" || line.type === "error").length, 1);
			if (failure === "answer" || failure === "both") assert.match(lines.at(-1)!.error!, /The side answer could not be saved/);
			if (failure !== "answer") assert.match(lines.at(-1)!.error!, /usage could not be saved/);
			assert.equal(answerAttempts, failure === "deleted-usage" ? 0 : 1);
			assert.equal(usageAttempts, 1);
			const saved = chatStore.getChat(chatId)!;
			assert.equal(saved.turns?.length ?? 0, failure === "answer" ? 1 : 0);
			if (failure === "usage") assert.equal(saved.sideChats![0]!.messages.at(-1)!.text, "Generated answer");
			if (failure === "deleted-usage") assert.equal(saved.sideChats, undefined);
			assert.equal(service.stop(chatId, threadId), false);
			assert.deepEqual(service.list(chatId)!.answering, {});
		});
	}

	it("a failed delete does not cancel or discard an answer that can still be saved", async () => {
		const { chatId, faux } = setup();
		let refuseDeletion = false;
		const service = createSideChatService({
			chatStore: { ...chatStore, updateSideChats(id, update) {
				if (refuseDeletion) throw new Error("simulated refused deletion");
				return chatStore.updateSideChats(id, update);
			} },
			engineFor: async () => ({ model: faux.getModel(), streamFn: faux.streamSimple }),
			instructions: () => "SIDE",
		});
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		faux.appendResponses([async () => { await gate; return fauxAssistantMessage("Saved after delete refusal"); }]);
		const response = await service.ask(chatId, { text: "q", quotes: [] });
		const threadId = chatStore.getChat(chatId)!.sideChats![0]!.id;
		refuseDeletion = true;
		assert.throws(() => service.remove(chatId, threadId), /simulated refused deletion/);
		refuseDeletion = false;
		release();
		await response.text();
		const answer = chatStore.getChat(chatId)!.sideChats![0]!.messages.at(-1)!;
		assert.equal(answer.text, "Saved after delete refusal");
		assert.equal(answer.stopped, undefined);
	});

	it("parent deletion stops its runs and cannot recreate the removed session", async () => {
		const { chatId, faux, service } = setup();
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		faux.appendResponses([async () => { await gate; return fauxAssistantMessage("Orphan answer"); }]);
		const response = await service.ask(chatId, { text: "q", quotes: [] });
		const threadId = chatStore.getChat(chatId)!.sideChats![0]!.id;
		const settled = service.settled(chatId, threadId);
		chatStore.deleteChat(chatId);
		service.stopAll(chatId);
		release();
		assert.equal((await readLines(response)).at(-1)?.type, "error");
		await settled;
		assert.equal(chatStore.getChat(chatId), null);
		assert.equal(service.list(chatId), null);
		assert.equal(service.stop(chatId, threadId), false);
	});

	it("a synchronous setup failure cannot produce a false done terminal before the view attaches", async () => {
		const { chatId, faux } = setup();
		let writes = 0;
		const service = createSideChatService({
			chatStore: { ...chatStore, updateSideChats(id, update) {
				if (++writes > 1) throw new Error("simulated synchronous settle failure");
				return chatStore.updateSideChats(id, update);
			} },
			engineFor: async () => ({ model: faux.getModel(), streamFn: faux.streamSimple }),
			instructions: () => { throw new Error("simulated instruction setup failure"); },
		});
		const lines = await readLines(await service.ask(chatId, { text: "q", quotes: [] }));
		assert.deepEqual(lines.map(line => line.type), ["thread", "error"]);
		assert.equal(chatStore.getChat(chatId)!.sideChats![0]!.messages.at(-1)?.role, "user");
	});

	it("keeps a question retryable after settlement persistence fails and refuses before inference on initial save failure", async () => {
		const { chatId, contexts, faux, service, prose } = setup();
		const original = chatStore.updateSideChats;
		let callCount = 0;
		chatStore.updateSideChats = ((id, update) => {
			callCount++;
			if (callCount === 1) throw new Error("initial disk error");
			return original(id, update);
		}) as typeof chatStore.updateSideChats;
		const refused = await service.ask(chatId, { text: "not saved", quotes: [] });
		assert.equal(refused.status, 503);
		assert.equal(chatStore.getChat(chatId)!.sideChats, undefined);
		chatStore.updateSideChats = original;

		faux.appendResponses([fauxAssistantMessage("unsaved answer")]);
		callCount = 0;
		chatStore.updateSideChats = ((id, update) => {
			callCount++;
			if (callCount === 2) throw new Error("settlement disk error");
			return original(id, update);
		}) as typeof chatStore.updateSideChats;
		const response = await service.ask(chatId, { text: "retry me", quotes: [] });
		const lines = await readLines(response);
		assert.equal(lines.at(-1)?.type, "error");
		assert.equal(chatStore.getChat(chatId)!.sideChats![0]!.messages.at(-1)?.role, "user");
		assert.equal(chatStore.getChat(chatId)!.turns?.length, 1, "usage survives a failed answer persist");
		chatStore.updateSideChats = original;
		const awaiting = chatStore.getChat(chatId)!.sideChats![0]!;
		const threadId = awaiting.id;
		const later = assistant([text("LATER-CONTENT-AFTER-SAVE-FAILURE")]);
		chatStore.saveMessages(chatId, [prose, later]);
		assert.equal((await service.ask(chatId, { threadId, text: "consecutive", quotes: [] })).status, 409);
		faux.appendResponses([fauxAssistantMessage("answered after storage recovery")]);
		const retry = await service.ask(chatId, { threadId, retry: true });
		await retry.text();
		assert.equal(chatStore.getChat(chatId)!.sideChats![0]!.messages.at(-1)?.text, "answered after storage recovery");
		assert.deepEqual(chatStore.getChat(chatId)!.sideChats![0]!.messages[0], awaiting.messages[0]);
		assert.doesNotMatch(JSON.stringify(contexts.at(-1)), /LATER-CONTENT-AFTER-SAVE-FAILURE/);
	});

	it("keeps compacted history available only through scoped context and authorized lookup", async () => {
		const { chatId, contexts, faux, service } = setup();
		const old = assistant([text("OLD-COMPACTED-CONTENT")]);
		const preceding = assistant([text("PRECEDING-TEACHING-EXCHANGE")]);
		const kept = assistant([text("LATEST-KEPT-CONTENT")]);
		const marker = newCompactionMarker("COMPACTION-SUMMARY", {
			firstKeptMessageId: kept.id,
			tokensBefore: 12,
			at: new Date().toISOString(),
		});
		chatStore.saveMessages(chatId, [old, preceding, kept, marker]);
		faux.appendResponses([
			fauxAssistantMessage([call("read_compacted", "read_lesson", { id: `message:${old.id}` })], { stopReason: "toolUse" }),
			fauxAssistantMessage("ok"),
		]);
		const response = await service.ask(chatId, { text: "explain", quotes: [] });
		await response.text();
		assert.match(JSON.stringify(contexts[0]), /PRECEDING-TEACHING-EXCHANGE/);
		assert.match(JSON.stringify(contexts[0]), /LATEST-KEPT-CONTENT/);
		assert.doesNotMatch(JSON.stringify(contexts[0]), /OLD-COMPACTED-CONTENT|COMPACTION-SUMMARY/);
		assert.match(JSON.stringify(contexts[1]), /OLD-COMPACTED-CONTENT/);
		assert.doesNotMatch(JSON.stringify(contexts[1]), /COMPACTION-SUMMARY/);
	});

	it("composes shared prompt overrides", () => {
		const prompt = composeSideChatInstructions();
		assert.match(prompt, /^# Side questions/);
		assert.match(prompt, /## Voice/);
		assert.match(prompt, /## Accuracy/);
		assert.match(prompt, /## Formatting/);
		const overridePath = path.join(temp, "prompts", "shared", "10-voice.md");
		fs.mkdirSync(path.dirname(overridePath), { recursive: true });
		fs.writeFileSync(overridePath, "## Side-only test voice override");
		assert.match(composeSideChatInstructions({ "shared/10-voice.md": true }), /Side-only test voice override/);
		assert.doesNotMatch(composeSideChatInstructions({ "shared/10-voice.md": false }), /Side-only test voice override/);
	});
});
