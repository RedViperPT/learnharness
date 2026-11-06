/** Cross-boundary regressions: saving side questions must not change lesson consumers. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createFauxCore, fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ChatRecord, LhMessage } from "../src/core/index.ts";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-side-isolation-"));
const originalEnv = process.env;
const originalFetch = globalThis.fetch;
process.env = { ...originalEnv, NODE_ENV: "test", LH_DATA_DIR: directory, LH_AUTH_FILE: path.join(directory, "auth.json") };
fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}");
globalThis.fetch = async () => { throw new Error("CLOSED: side-question isolation tests are offline"); };

const { chatStore } = await import("../src/store/chats.ts");
const { createSideChatService } = await import("../src/server/side-chat.ts");
const { createTeacherAgent, createPracticeAgent } = await import("../src/agent/teacher-agent.ts");
const { transcriptView } = await import("../src/agent/subagents/extraction.ts");
const {
	buildCompactionPrompt, coverageOf, measuredContextTokens, newUserMessage,
	serializeForSummary, sessionMarkdown, toLlmMessages,
} = await import("../src/core/index.ts");

after(() => {
	globalThis.fetch = originalFetch;
	process.env = originalEnv;
	fs.rmSync(directory, { recursive: true, force: true });
});

function lessonConsumers(record: ChatRecord) {
	return {
		modelMessages: toLlmMessages(record.messages),
		extraction: transcriptView(record),
		coverage: coverageOf(record.messages, [], record.id),
		compaction: buildCompactionPrompt({ spanText: serializeForSummary(record.messages), planTreeText: null, kind: record.kind === "practice" ? "practice" : "teach" }),
		export: sessionMarkdown(record.messages, { title: record.title, anchors: false }),
		contextMeter: measuredContextTokens(record.messages),
	};
}

for (const kind of [undefined, "practice"] as const) {
	test(`${kind ?? "teaching"}: side threads cannot change model requests, extraction, coverage, compaction, export, or context meter`, async () => {
		const side = createFauxCore({});
		const sideRequests: TranscriptContext[] = [];
		side.setResponses([fauxAssistantMessage("PRIVATE-SIDE-ANSWER"), fauxAssistantMessage("PRIVATE-SIDE-FOLLOWUP-ANSWER")]);
		const service = createSideChatService({
			chatStore,
			engineFor: async () => ({ model: side.getModel(), streamFn: (model, context, options) => { sideRequests.push(structuredClone(context)); return side.streamSimple(model, context, options); } }),
			instructions: () => "SIDE-ONLY-INSTRUCTIONS",
		});
		const chat = chatStore.createChat("Isolation fixture", kind);
		chatStore.saveMessages(chat.id, [
			newUserMessage("Teach me about limits."),
			{ ...fauxAssistantMessage("A limit describes an approaching value."), id: "msg_isolation_prose" } as LhMessage,
		]);
		const before = chatStore.getChat(chat.id)!;
		const consumers = lessonConsumers(before);
		chatStore.saveNotes(chat.id, "PRIVATE-NOTES: incomplete or incorrect learner shorthand", 0);
		const first = await service.ask(chat.id, {
			text: "PRIVATE-SIDE-QUESTION", quotes: [{ text: "A limit describes an approaching value.", source: { kind: "message", messageId: "msg_isolation_prose" } }],
		});
		assert.equal(first.status, 200);
		await first.text();
		let saved = chatStore.getChat(chat.id)!;
		const threadId = saved.sideChats![0]!.id;
		const followup = await service.ask(chat.id, { threadId, text: "PRIVATE-SIDE-FOLLOWUP", quotes: [] });
		assert.equal(followup.status, 200);
		await followup.text();
		saved = chatStore.getChat(chat.id)!;
		assert.deepEqual(saved.messages, before.messages, "no native marker, note, or side answer may be appended");
		assert.equal(saved.updatedAt, before.updatedAt, "side activity cannot reorder the lesson sidebar");
		assert.equal(saved.sideChats![0]!.messages.length, 4);
		assert.equal(saved.turns!.length, 2, "both side calls remain in cost accounting");
		assert.deepEqual(lessonConsumers(saved), consumers);
		assert.doesNotMatch(JSON.stringify(lessonConsumers(saved)), /PRIVATE-|SIDE-ONLY-INSTRUCTIONS/);
		assert.doesNotMatch(JSON.stringify(sideRequests), /PRIVATE-NOTES/);
		assert.equal(Object.hasOwn(chatStore.listChats().find(item => item.id === chat.id)!, "sideChats"), false);

		// Exercise actual native agent request construction for both session kinds,
		// rather than asserting only the pure message projection.
		const conversation = createFauxCore({});
		const requests: TranscriptContext[] = [];
		conversation.setResponses([(context) => { requests.push(context); return fauxAssistantMessage("Normal lesson continues."); }]);
		const opts = { engine: { model: conversation.getModel(), streamFn: conversation.streamSimple }, messages: saved.messages, tools: {} };
		const agent = kind === "practice"
			? createPracticeAgent({ chatId: chat.id, chatStore }, opts)
			: createTeacherAgent(undefined, opts);
		await agent.prompt("Continue the lesson.");
		assert.equal(requests.length, 1);
		assert.match(JSON.stringify(requests[0]), /A limit describes an approaching value/);
		assert.doesNotMatch(JSON.stringify(requests[0]), /PRIVATE-|SIDE-ONLY-INSTRUCTIONS/);

		assert.equal(service.remove(chat.id, threadId), "ok");
		const removed = chatStore.getChat(chat.id)!;
		assert.equal(removed.sideChats, undefined);
		assert.deepEqual(removed.turns, saved.turns, "deleting a thread must not erase incurred usage");
		assert.deepEqual(lessonConsumers(removed), consumers);
	});
}
