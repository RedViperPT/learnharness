import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { PiEngine } from "../src/agent/models.ts";
import type { SideStreamEvent } from "../src/server/side-chat.ts";

const tempRoot = process.platform === "win32" ? path.join(os.tmpdir(), "opencode") : os.tmpdir();
fs.mkdirSync(tempRoot, { recursive: true });
const temp = fs.mkdtempSync(path.join(tempRoot, "lh-side-stream-"));
process.env.LH_DATA_DIR = temp;
const [{ chatStore }, { createSideChatService }, { SIDE_LOOKUP_MAX_ROUNDS }] = await Promise.all([
	import("../src/store/chats.ts"),
	import("../src/server/side-chat.ts"),
	import("../src/agent/side-chat.ts"),
]);
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const partial = (text: string) => fauxAssistantMessage(text);

async function setup(failSave = false) {
	const stream = new AssistantMessageEventStream();
	let signal: AbortSignal | undefined;
	const engine: PiEngine = {
		model: createFauxCore({}).getModel(),
		streamFn: (_model, _context, options) => {
			signal = options?.signal;
			return stream;
		},
	};
	let writes = 0;
	const service = createSideChatService({
		chatStore: { ...chatStore, updateSideChats(id, update) {
			if (++writes > 1 && failSave) throw new Error("simulated answer save failure");
			return chatStore.updateSideChats(id, update);
		} },
		engineFor: async () => engine,
		instructions: () => "TEST",
	});
	const chatId = chatStore.createChat("Coalesced side stream").id;
	const response = await service.ask(chatId, { text: "Explain?", quotes: [] });
	const threadId = service.list(chatId)!.threads[0]!.id;
	const pushText = (text: string) => stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: partial(text) });
	const lines = async () => (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as SideStreamEvent);
	return { stream, signal, service, chatId, threadId, pushText, response, lines };
}

it("coalesces 1,000 provider updates into one complete replacement before done", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const run = await setup();
	const answer = "x".repeat(20_000);
	for (let i = 1; i <= 1_000; i++) run.pushText(answer.slice(0, i * 20));
	run.stream.push({ type: "done", reason: "stop", message: partial(answer) });
	const events = await run.lines();
	assert.deepEqual(events.map((event) => event.type), ["thread", "text", "done"]);
	assert.deepEqual(events[1], { type: "text", text: answer });
	assert.equal(chatStore.getChat(run.chatId)!.sideChats![0]!.messages.at(-1)!.text, answer);
	t.mock.timers.tick(1_000);
	assert.equal(run.service.stop(run.chatId, run.threadId), false);
});

it("keeps list state current immediately and emits full replacements once per live window", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const run = await setup();
	const reader = run.response.body!.getReader();
	await reader.read(); // thread
	let emitted = false;
	const first = reader.read().then((value) => { emitted = true; return value; });
	run.pushText("old");
	run.pushText("revised");
	await turn();
	assert.equal(run.service.list(run.chatId)!.answering[run.threadId], "revised");
	assert.equal(emitted, false);
	t.mock.timers.tick(99);
	await turn();
	assert.equal(emitted, false);
	t.mock.timers.tick(1);
	assert.deepEqual(JSON.parse(new TextDecoder().decode((await first).value)), { type: "text", text: "revised" });
	run.pushText("replacement, not a delta");
	run.stream.push({ type: "done", reason: "stop", message: partial("replacement, not a delta") });
	const finalText = await reader.read();
	assert.deepEqual(JSON.parse(new TextDecoder().decode(finalText.value)), { type: "text", text: "replacement, not a delta" });
	assert.equal(JSON.parse(new TextDecoder().decode((await reader.read()).value)).type, "done");
	assert.equal((await reader.read()).done, true);
});

for (const ending of ["done", "error", "aborted", "end", "save-error"] as const) {
	it(`flushes authoritative final text before settlement (${ending})`, async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const run = await setup(ending === "save-error");
		run.pushText("partial");
		await turn();
		const finalText = ending === "end" ? "partial" : "final revision";
		if (ending === "end") {
			run.stream.end();
		} else if (ending === "error" || ending === "aborted") {
			if (ending === "aborted") {
				assert.equal(run.service.stop(run.chatId, run.threadId), true);
				assert.equal(run.signal?.aborted, true);
			}
			run.stream.push({ type: "error", reason: ending, error: fauxAssistantMessage(finalText, { stopReason: ending, errorMessage: "provider failure" }) });
		} else {
			run.stream.push({ type: "done", reason: "stop", message: partial(finalText) });
		}
		const events = await run.lines();
		assert.deepEqual(events.map((event) => event.type), ["thread", "text", ending === "save-error" ? "error" : "done"]);
		assert.deepEqual(events[1], { type: "text", text: finalText });
		if (ending !== "save-error") {
			const saved = chatStore.getChat(run.chatId)!.sideChats![0]!.messages.at(-1)!;
			assert.equal(saved.text, finalText);
			if (ending === "aborted") assert.equal(saved.stopped, true);
			if (ending === "error") assert.equal(saved.error, "provider failure");
		}
		assert.deepEqual(run.service.list(run.chatId)!.answering, {});
		t.mock.timers.tick(1_000);
	});
}

it("delivers text present only in the final provider message", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const run = await setup();
	run.stream.push({ type: "done", reason: "stop", message: partial("final-only text") });
	const events = await run.lines();
	assert.deepEqual(events.map((event) => event.type), ["thread", "text", "done"]);
	assert.deepEqual(events[1], { type: "text", text: "final-only text" });
});

it("flushes the lookup-limit notice as part of the final replacement", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const faux = createFauxCore({ tokensPerSecond: 0 });
	faux.appendResponses([
		...Array.from({ length: SIDE_LOOKUP_MAX_ROUNDS }, (_, i) => fauxAssistantMessage([
			{ type: "toolCall", id: `lookup_${i}`, name: "search_lesson", arguments: { query: "definition" } },
		], { stopReason: "toolUse" })),
		fauxAssistantMessage("Based on the available material."),
	]);
	const service = createSideChatService({
		chatStore,
		engineFor: async () => ({ model: faux.getModel(), streamFn: faux.streamSimple }),
		instructions: () => "TEST",
	});
	const chatId = chatStore.createChat("Lookup-limit stream").id;
	const response = await service.ask(chatId, { text: "Explain?", quotes: [] });
	const events: SideStreamEvent[] = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(events.map((event) => event.type), ["thread", "text", "done"]);
	const finalText = chatStore.getChat(chatId)!.sideChats![0]!.messages.at(-1)!.text;
	assert.match(finalText, /Based on the available material\.[\s\S]*Lesson lookup limit reached/);
	assert.deepEqual(events[1], { type: "text", text: finalText });
});

it("a disconnected view with pending text does not cancel generation or settlement", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const run = await setup();
	run.pushText("pending");
	await turn();
	await run.response.body!.cancel();
	assert.equal(run.signal?.aborted, false);
	t.mock.timers.tick(100);
	run.stream.push({ type: "done", reason: "stop", message: partial("saved after disconnect") });
	await run.service.settled(run.chatId, run.threadId);
	assert.equal(chatStore.getChat(run.chatId)!.sideChats![0]!.messages.at(-1)!.text, "saved after disconnect");
	t.mock.timers.tick(1_000);
});
