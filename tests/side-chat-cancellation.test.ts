import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { PiEngine } from "../src/agent/models.ts";
import { SIDE_REQUEST_WINDOW_MS } from "../src/core/side-chat.ts";

const tempRoot = process.platform === "win32" ? path.join(os.tmpdir(), "opencode") : os.tmpdir();
fs.mkdirSync(tempRoot, { recursive: true });
const temp = fs.mkdtempSync(path.join(tempRoot, "lh-side-cancellation-"));
process.env.LH_DATA_DIR = temp;
const [{ chatStore }, { createSideChatService }] = await Promise.all([
	import("../src/store/chats.ts"),
	import("../src/server/side-chat.ts"),
]);
after(() => fs.rmSync(temp, { recursive: true, force: true }));

function setup() {
	const stream = new AssistantMessageEventStream();
	let signal: AbortSignal | undefined;
	const engine: PiEngine = {
		model: createFauxCore({}).getModel(),
		streamFn: (_model, _context, options) => {
			signal = options?.signal;
			return stream;
		},
	};
	const service = createSideChatService({ chatStore, engineFor: async () => engine, instructions: () => "TEST" });
	const chatId = chatStore.createChat("Side cancellation").id;
	const requestId = `${Date.now()}_${crypto.randomUUID()}`;
	return { service, chatId, requestId, stream, engine, signal: () => signal };
}

for (const age of [SIDE_REQUEST_WINDOW_MS, SIDE_REQUEST_WINDOW_MS + 1]) {
	it(`cancels a running answer at request age ${age}ms without admitting stale requests`, async (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
		const run = setup();
		const response = await run.service.ask(run.chatId, { requestId: run.requestId, text: "Explain?", quotes: [] });
		const threadId = run.service.list(run.chatId)!.threads[0]!.id;
		const partial = fauxAssistantMessage("Partial answer");
		run.stream.push({ type: "text_delta", contentIndex: 0, delta: "Partial answer", partial });
		await new Promise<void>((resolve) => setImmediate(resolve));
		t.mock.timers.tick(age);

		const otherChatId = chatStore.createChat("Other chat").id;
		assert.equal(run.service.cancel(otherChatId, run.requestId), false);
		assert.equal(run.service.cancel(run.chatId, `${Date.now() - age}_${crypto.randomUUID()}`), false);
		assert.equal(run.signal()?.aborted, false);
		assert.equal(run.service.cancel(run.chatId, run.requestId), true);
		assert.equal(run.signal()?.aborted, true);
		run.stream.push({ type: "error", reason: "aborted", error: fauxAssistantMessage("Partial answer", { stopReason: "aborted" }) });
		await response.text();
		await run.service.settled(run.chatId, threadId);

		const answer = run.service.list(run.chatId)!.threads[0]!.messages.at(-1)!;
		assert.equal(answer.stopped, true);
		assert.equal(answer.text, "Partial answer");
		assert.deepEqual(run.service.list(run.chatId)!.answering, {});
		assert.equal(run.service.cancel(run.chatId, run.requestId), false);
		assert.equal((await run.service.ask(run.chatId, { requestId: run.requestId, text: "Stale replay", quotes: [] })).status, 409);
	});
}

it("cancels an expired attempt still awaiting model resolution without creating a thread", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
	const run = setup();
	let resolveEngine!: (engine: PiEngine) => void;
	const engine = new Promise<PiEngine>((resolve) => { resolveEngine = resolve; });
	const service = createSideChatService({ chatStore, engineFor: () => engine, instructions: () => "TEST" });
	const asking = service.ask(run.chatId, { requestId: run.requestId, text: "Still waiting", quotes: [] });
	t.mock.timers.tick(SIDE_REQUEST_WINDOW_MS + 1);
	assert.equal(service.cancel(run.chatId, run.requestId), true);
	assert.deepEqual(await (await asking).json(), { cancelled: true });
	resolveEngine(run.engine);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(run.signal(), undefined);
	assert.deepEqual(service.list(run.chatId)!.threads, []);
	assert.equal(service.cancel(run.chatId, run.requestId), false);
});

it("retains fresh stop-before-admission tombstones and rejects expired or future requests", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
	const run = setup();
	assert.equal(run.service.cancel(run.chatId, run.requestId), true);
	assert.deepEqual(await (await run.service.ask(run.chatId, { requestId: run.requestId, text: "Cancelled", quotes: [] })).json(), { cancelled: true });
	assert.equal(run.signal(), undefined);
	t.mock.timers.tick(SIDE_REQUEST_WINDOW_MS);
	for (const requestId of [run.requestId, `${Date.now() + 1}_${crypto.randomUUID()}`, "invalid"]) {
		assert.equal(run.service.cancel(run.chatId, requestId), false);
		assert.equal((await run.service.ask(run.chatId, { requestId, text: "Not admitted", quotes: [] })).status, 409);
	}
	assert.deepEqual(run.service.list(run.chatId)!.threads, []);
});

it("retains the cancellation tombstone after a fresh active attempt settles", async () => {
	const run = setup();
	const response = await run.service.ask(run.chatId, { requestId: run.requestId, text: "Explain?", quotes: [] });
	assert.equal(run.service.cancel(run.chatId, run.requestId), true);
	assert.equal(run.signal()?.aborted, true);
	run.stream.push({ type: "error", reason: "aborted", error: fauxAssistantMessage("", { stopReason: "aborted" }) });
	await response.text();
	assert.deepEqual(await (await run.service.ask(run.chatId, { requestId: run.requestId, text: "Replay", quotes: [] })).json(), { cancelled: true });
	assert.equal(run.service.list(run.chatId)!.threads.length, 1);
});
