import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { after, test } from "node:test";
import { spawnSync } from "node:child_process";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { NOTES_MAX_BYTES, noteQuoteMarkdown, toLlmMessages, projectView, coverageOf, resolveRoleSpec } from "../src/core/index.ts";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-session-notes-"));
process.env.LH_DATA_DIR = directory;
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
const { chatStore } = await import("../src/store/chats.ts");
const { subscribe } = await import("../src/core/events.ts");
const { GET, PUT } = await import("../app/api/chats/[id]/notes/route.ts");
const { GET: getChat } = await import("../app/api/chats/[id]/route.ts");
const { POST: organize } = await import("../app/api/chats/[id]/notes/organize/route.ts");
after(() => fs.rmSync(directory, { recursive: true, force: true }));
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const put = (id: string, value: unknown) => PUT(new Request("http://localhost/notes", { method: "PUT", body: JSON.stringify(value) }), params(id));

for (const kind of [undefined, "practice"] as const) {
	test(`${kind ?? "teach"}: notes persist silently without entering lesson projections`, () => {
		const chat = chatStore.createChat("Notes", kind);
		assert.deepEqual(chatStore.readNotes(chat.id), { markdown: "", revision: 0, updatedAt: null });
		const events: string[] = []; const unsubscribe = subscribe((event) => events.push(event.type));
		try {
			const first = chatStore.saveNotes(chat.id, "PRIVATE-NOTES: uncertain $x^2$", 0);
			assert.equal(typeof first, "object");
			assert.equal(chatStore.readNotes(chat.id)?.revision, 1);
			assert.equal(chatStore.getChat(chat.id)?.updatedAt, chat.updatedAt);
			assert.equal(chatStore.saveNotes(chat.id, "overwrite", 0), "conflict");
			const messages = [{ ...fauxAssistantMessage("Saved lesson text"), id: "msg_note_fixture" }];
			chatStore.saveMessages(chat.id, messages);
			chatStore.updateSideChats(chat.id, () => [{ id: "side_fixture", createdAt: "", messages: [] }]);
			const before = chatStore.getChat(chat.id)!;
			chatStore.saveNotes(chat.id, "PRIVATE-NOTES revision two", 1);
			const saved = chatStore.getChat(chat.id)!;
			assert.equal(saved.updatedAt, before.updatedAt);
			assert.deepEqual(saved.messages, before.messages);
			assert.deepEqual(saved.sideChats, before.sideChats);
			assert.deepEqual(toLlmMessages(saved.messages), toLlmMessages(before.messages));
			assert.deepEqual(projectView(saved.messages), projectView(before.messages));
			assert.deepEqual(coverageOf(saved.messages, [], chat.id), coverageOf(before.messages, [], chat.id));
			assert.equal("notes" in chatStore.listChats().find((item) => item.id === chat.id)!, false);
			assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "chats", `${chat.id}.json`), "utf8")).notes.revision, 2);
			assert.deepEqual(events, []);
		} finally { unsubscribe(); }
		assert.equal(chatStore.deleteChat(chat.id), true);
		assert.equal(chatStore.readNotes(chat.id), null);
	});
}

test("notes API normalizes absence, validates requests, enforces UTF-8 bytes, and reports canonical conflicts", async () => {
	const chat = chatStore.createChat("API notes");
	assert.deepEqual(await (await GET(new Request("http://localhost"), params(chat.id))).json(), { markdown: "", revision: 0, updatedAt: null });
	for (const malformed of [null, {}, { markdown: 1, expectedRevision: 0 }, { markdown: "x", expectedRevision: -1 }, { markdown: "x", expectedRevision: 0.5 }]) assert.equal((await put(chat.id, malformed)).status, 400);
	assert.equal((await put(chat.id, { markdown: "💡".repeat(NOTES_MAX_BYTES / 4 + 1), expectedRevision: 0 })).status, 413);
	const first = await put(chat.id, { markdown: "# Notes\n$x$", expectedRevision: 0 });
	assert.equal(first.status, 200);
	const canonical = await first.json();
	assert.equal(canonical.revision, 1);
	const conflict = await put(chat.id, { markdown: "lost", expectedRevision: 0 });
	assert.equal(conflict.status, 409);
	assert.deepEqual(await conflict.json(), { code: "notes_revision_conflict", notes: canonical });
	assert.deepEqual(await (await GET(new Request("http://localhost"), params(chat.id))).json(), canonical);
	assert.equal((await put("unknown", { markdown: "", expectedRevision: 0 })).status, 404);
	assert.equal((await GET(new Request("http://localhost"), params("unknown"))).status, 404);
	const ordinary = await (await getChat(new Request("http://localhost"), params(chat.id))).json();
	assert.equal("notes" in ordinary, false);
	assert.equal("imageSnapshots" in ordinary, false);
});

test("organizer route refuses malformed revisions and missing Cheap without falling back to Strong", async () => {
	const chat = chatStore.createChat("No model"); chatStore.saveNotes(chat.id, "Notes", 0);
	assert.equal((await organize(new Request("http://localhost", { method: "POST", body: "{}" }), params(chat.id))).status, 400);
	const response = await organize(new Request("http://localhost", { method: "POST", body: JSON.stringify({ revision: 1 }) }), params(chat.id));
	assert.equal(response.status, 503);
	assert.equal((await response.json()).code, "models_not_configured");
	assert.equal(resolveRoleSpec("noteOrganizer", { version: 1, models: { strong: { model: { provider: "a", id: "strong" } } } }), undefined);
	assert.deepEqual(resolveRoleSpec("noteOrganizer", { version: 1, models: { cheap: { model: { provider: "a", id: "cheap" } } } }), { provider: "a", id: "cheap", thinkingLevel: undefined });
	assert.deepEqual(resolveRoleSpec("noteOrganizer", { version: 1, agent: { models: { noteOrganizer: { model: { provider: "a", id: "override" }, thinkingLevel: "low" } } } }), { provider: "a", id: "override", thinkingLevel: "low" });
});

test("a second process cannot access the same chat directory", () => {
	chatStore.createChat("Own writer");
	const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "const {chatStore}=await import('./src/store/chats.ts'); chatStore.createChat('Other writer');"], { cwd: process.cwd(), env: { ...process.env, LH_DATA_DIR: directory }, encoding: "utf8" });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /one server process per data directory/);
});

test("quotations prefix every line and preserve captured TeX without rendered glyphs", () => {
	assert.equal(noteQuoteMarkdown({ text: "First\n\nSecond", source: { kind: "message", messageId: "m" } }), "> First\n>\n> Second");
	assert.equal(noteQuoteMarkdown({ text: "not authoritative rendered glyphs", source: { kind: "message", messageId: "m" }, segments: [{ kind: "text", text: "For " }, { kind: "math", tex: "x^2", display: false }, { kind: "text", text: "\n" }, { kind: "math", tex: "\\int x\\,dx", display: true }] }), "> For $x^2$\n>\n> $$\n> \\int x\\,dx\n> $$");
	assert.equal(noteQuoteMarkdown({ text: "**literal** $x$", source: { kind: "message", messageId: "m" }, segments: [{ kind: "text", text: "**literal** $x$" }] }), "> \\*\\*literal\\*\\* \\$x\\$");
});
