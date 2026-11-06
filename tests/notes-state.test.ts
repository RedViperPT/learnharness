import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { NotesStateStore, getNotesStore } from "../components/notes-state.tsx";
import { SideChatStateStore } from "../components/side-chat-state.tsx";
import { getSessionPanelStore } from "../components/session-panel-state.ts";
import { navigateAfterNotesSave } from "../components/notes-navigation.tsx";
import { NOTES_MAX_BYTES, type SessionNotesView } from "../src/core/index.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
let sequence = 0;

function setup(markdown = "raw notes") {
	const id = `notes-state-${++sequence}`;
	const store = getNotesStore(id);
	let notes: SessionNotesView = { markdown, revision: 1, updatedAt: "2026-11-06T00:00:00Z" };
	const writes: { markdown: string; expectedRevision: number }[] = [];
	const calls: { url: string; method: string }[] = [];
	let modelCalls = 0;
	const fetcher: typeof fetch = async (url, init) => {
		calls.push({ url: String(url), method: init?.method ?? "GET" });
		if (String(url).endsWith("/organize")) {
			modelCalls++;
			const revision = JSON.parse(String(init?.body)).revision;
			return new Response([{ type: "start", proposalId: `proposal-${modelCalls}`, baseRevision: revision, model: "fixture:cheap" }, { type: "text", text: "# Proposed" }, { type: "done", text: "# Proposed\n\nraw notes" }].map((value) => JSON.stringify(value)).join("\n") + "\n");
		}
		if (init?.method === "PUT") {
			const body = JSON.parse(String(init.body)); writes.push(body);
			if (body.expectedRevision !== notes.revision) return Response.json({ code: "notes_revision_conflict", notes }, { status: 409 });
			notes = { markdown: body.markdown, revision: notes.revision + 1, updatedAt: new Date().toISOString() };
		}
		return Response.json(notes);
	};
	globalThis.fetch = fetcher;
	return { id, store, writes, calls, fetcher, server: () => notes, setServer: (value: SessionNotesView) => { notes = value; }, modelCalls: () => modelCalls };
}

test("fetches only when opened, retains session memory, and switches panels without losing side drafts", async () => {
	const { id, store, calls } = setup();
	assert.equal(calls.length, 0);
	const side = new SideChatStateStore(id);
	const key = side.openNew(); side.setDraft(key, { text: "side draft", quotes: [] });
	await store.open();
	assert.equal(getSessionPanelStore(id).getSnapshot(), "notes");
	assert.equal(side.getSnapshot().panelOpen, false);
	store.edit("local note");
	side.setOpen(true);
	assert.equal(getSessionPanelStore(id).getSnapshot(), "side-chat");
	assert.equal(side.getSnapshot().entries[key]?.draft?.text, "side draft");
	assert.equal(getNotesStore(id), store);
	assert.equal(store.getSnapshot().markdown, "local note");
	await store.flush();
});

test("autosave waits 600 ms and typing/insertion make no model calls", async (t) => {
	const { store, writes, modelCalls } = setup(); await store.open();
	t.mock.timers.enable({ apis: ["setTimeout"] });
	store.edit("typed");
	assert.equal(store.getSnapshot().dirty, true);
	t.mock.timers.tick(599); await tick(); assert.equal(writes.length, 0);
	t.mock.timers.tick(1); await tick();
	assert.equal(writes.length, 1);
	assert.equal(store.getSnapshot().dirty, false);
	assert.equal(await store.addQuote({ text: "Quote\n$x$", source: { kind: "message", messageId: "m" }, segments: [{ kind: "text", text: "Quote\n" }, { kind: "math", tex: "x", display: false }] }), true);
	assert.equal(store.getSnapshot().markdown, "typed\n\n> Quote\n> $x$");
	assert.deepEqual(store.getSnapshot().focus && { from: store.getSnapshot().focus!.from, to: store.getSnapshot().focus!.to }, { from: 7, to: 20 });
	await store.flush(); assert.equal(modelCalls(), 0);
});

test("save requests serialize and preserve edits made during an in-flight write", async () => {
	const { store, fetcher, writes } = setup(); await store.open();
	const accepted = deferred<void>(); const gate = deferred<void>(); let inFlight = 0; let maximum = 0;
	globalThis.fetch = async (url, init) => {
		if (init?.method === "PUT") { inFlight++; maximum = Math.max(maximum, inFlight); accepted.resolve(); await gate.promise; const result = await fetcher(url, init); inFlight--; return result; }
		return fetcher(url, init);
	};
	store.edit("first"); const saving = store.flush(); await accepted.promise;
	store.edit("second"); const second = store.flush();
	gate.resolve(); assert.equal(await saving, true); assert.equal(await second, true);
	assert.equal(maximum, 1);
	assert.deepEqual(writes.map((write) => write.expectedRevision), [1, 2]);
	assert.equal(store.getSnapshot().markdown, "second"); assert.equal(store.getSnapshot().revision, 3);
});

test("a pending focus refresh settles before autosave can race its acknowledgement", async () => {
	const { store, fetcher, writes } = setup(); await store.open();
	const gate = deferred<void>(); const started = deferred<void>();
	globalThis.fetch = async (url, init) => {
		if (!init?.method) { started.resolve(); await gate.promise; }
		return fetcher(url, init);
	};
	const refreshing = store.refresh(); await started.promise;
	store.edit("edit during focus refresh"); const saving = store.flush();
	await tick(); assert.equal(writes.length, 0);
	gate.resolve(); assert.equal(await refreshing, true); assert.equal(await saving, true);
	assert.equal(writes.length, 1); assert.equal(store.getSnapshot().conflict, undefined);
});

test("conflicts retain local text, pause autosave, and require an explicit resolution", async () => {
	const { store, setServer, writes } = setup(); await store.open();
	store.edit("mine"); setServer({ markdown: "theirs", revision: 2, updatedAt: "now" });
	assert.equal(await store.flush(), false);
	assert.equal(store.getSnapshot().markdown, "mine");
	assert.equal(store.getSnapshot().conflict?.markdown, "theirs");
	store.edit("mine revised"); assert.equal(await store.flush(), false); assert.equal(writes.length, 1);
	assert.equal(await store.keepMine(), true);
	assert.deepEqual(writes[1], { markdown: "mine revised", expectedRevision: 2 });
	store.edit("local again"); setServer({ markdown: "server again", revision: 4, updatedAt: "now" });
	await store.flush(); store.keepServer();
	assert.equal(store.getSnapshot().markdown, "server again"); assert.equal(store.getSnapshot().dirty, false);
});

test("a focus refresh preserves a dirty local document and stales proposals on external changes", async () => {
	const { store, setServer } = setup(); await store.open(); await store.organize();
	store.edit("unsaved"); setServer({ markdown: "external", revision: 2, updatedAt: "now" }); await store.refresh();
	assert.equal(store.getSnapshot().markdown, "unsaved"); assert.ok(store.getSnapshot().conflict);
	assert.equal(store.getSnapshot().organizer?.stale, true); store.keepServer();
});

test("organization flushes first, freezes the input, previews without saving, and Try again pays again", async () => {
	const { store, writes, modelCalls } = setup(); await store.open(); store.edit("updated notes");
	assert.equal(await store.organize(), true);
	assert.equal(writes.length, 1); assert.equal(modelCalls(), 1);
	assert.equal(store.getSnapshot().organizer?.original, "updated notes"); assert.equal(store.getSnapshot().organizer?.baseRevision, 2);
	assert.equal(store.getSnapshot().markdown, "updated notes");
	assert.equal(await store.organize(), true); assert.equal(modelCalls(), 2);
	store.discardProposal(); assert.equal(store.getSnapshot().organizer, undefined); assert.equal(writes.length, 1);
});

test("even an unsaved edit immediately stales a completed proposal, including after undoing that edit", async () => {
	const { store, writes } = setup(); await store.open(); await store.organize();
	store.edit("new local edit"); assert.equal(store.getSnapshot().revision, 1); assert.equal(store.getSnapshot().organizer?.stale, true);
	store.edit("raw notes"); assert.equal(store.getSnapshot().dirty, false); assert.equal(await store.apply(), false); assert.equal(writes.length, 0);
	await store.flush();
});

test("generation and comparison preferences survive panel hiding and session navigation", async () => {
	const { store, id, fetcher } = setup(); await store.open();
	const gate = deferred<void>(); const started = deferred<void>();
	globalThis.fetch = async (url, init) => {
		if (String(url).endsWith("/organize")) { started.resolve(); await gate.promise; }
		return fetcher(url, init);
	};
	const organizing = store.organize(); await started.promise;
	store.setOrganizerSource(true); store.setComparisonTab("original");
	getSessionPanelStore(id).set("side-chat"); getNotesStore("another-session");
	gate.resolve(); assert.equal(await organizing, true);
	assert.equal(getNotesStore(id).getSnapshot().organizer?.complete, true);
	assert.equal(store.getSnapshot().organizerSource, true); assert.equal(store.getSnapshot().comparisonTab, "original");
});

test("Apply revalidates, locks editing during its atomic PUT, and advances revision exactly once", async () => {
	const { store, writes, fetcher, calls } = setup(); await store.open(); await store.organize();
	const accepted = deferred<void>(); const gate = deferred<void>();
	globalThis.fetch = async (url, init) => {
		if (init?.method === "PUT") { const response = await fetcher(url, init); accepted.resolve(); await gate.promise; return response; }
		return fetcher(url, init);
	};
	const applying = store.apply(); await accepted.promise;
	assert.equal(store.getSnapshot().applying, true); store.edit("typing during Apply"); assert.equal(store.getSnapshot().markdown, "raw notes");
	const reads = calls.filter((call) => call.method === "GET").length;
	await store.refresh();
	assert.equal(calls.filter((call) => call.method === "GET").length, reads, "a reopen/focus must not adopt the already committed Apply before its acknowledgement");
	assert.equal(store.getSnapshot().markdown, "raw notes");
	gate.resolve(); assert.equal(await applying, true);
	assert.deepEqual(writes, [{ markdown: "# Proposed\n\nraw notes", expectedRevision: 1 }]);
	assert.equal(store.getSnapshot().revision, 2); assert.equal(store.getSnapshot().replacement, 1); assert.equal(store.getSnapshot().organizer, undefined);
});

test("Apply cannot overwrite an external save that occurred before revalidation", async () => {
	const { store, setServer, writes } = setup(); await store.open(); await store.organize();
	setServer({ markdown: "external newer text", revision: 2, updatedAt: "now" });
	assert.equal(await store.apply(), false); assert.equal(writes.length, 0);
	assert.equal(store.getSnapshot().markdown, "external newer text"); assert.equal(store.getSnapshot().organizer?.stale, true);
});

test("Retry after a failed Apply retries only the guarded save, not a paid model call", async () => {
	const { store, fetcher, modelCalls } = setup(); await store.open(); await store.organize();
	let fail = true;
	globalThis.fetch = async (url, init) => fail && init?.method === "PUT" ? Response.json({ error: "disk unavailable" }, { status: 503 }) : fetcher(url, init);
	assert.equal(await store.apply(), false);
	assert.equal(store.getSnapshot().markdown, "raw notes");
	assert.equal(store.getSnapshot().errorAction, "apply");
	fail = false; assert.equal(await store.retry(), true);
	assert.equal(store.getSnapshot().markdown, "# Proposed\n\nraw notes");
	assert.equal(modelCalls(), 1);
});

test("a disconnect, empty result, oversized result, or Stop never creates an applyable proposal", async () => {
	for (const mode of ["disconnect", "empty", "oversized", "stop"] as const) {
		const { store, fetcher } = setup(); await store.open();
		const started = deferred<void>();
		globalThis.fetch = async (url, init) => {
			if (!String(url).endsWith("/organize")) return fetcher(url, init);
			if (mode === "stop") { started.resolve(); return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); }
			return new Response([{ type: "start", proposalId: "p", baseRevision: 1, model: "test" }, { type: "text", text: "partial" }, ...(mode === "disconnect" ? [] : [{ type: "done", text: mode === "empty" ? "" : "x".repeat(NOTES_MAX_BYTES + 1) }])].map((value) => JSON.stringify(value)).join("\n"));
		};
		const running = store.organize();
		if (mode === "stop") { await started.promise; store.stop(); }
		assert.equal(await running, false); assert.equal(store.getSnapshot().organizer?.complete, false); assert.equal(await store.apply(), false);
		assert.equal(store.getSnapshot().markdown, "raw notes");
	}
});

test("failed navigation flush stays in place and preserves unsaved text", async () => {
	const { store, id, fetcher } = setup(); await store.open();
	store.edit("saved before leaving"); let navigations = 0;
	assert.equal(await navigateAfterNotesSave(() => { navigations++; }, `/chat/${id}`), true);
	assert.equal(navigations, 1);
	store.edit("unsaved before leaving");
	globalThis.fetch = async (url, init) => init?.method === "PUT" ? Response.json({ error: "disk unavailable" }, { status: 503 }) : fetcher(url, init);
	assert.equal(await navigateAfterNotesSave(() => { navigations++; }, `/chat/${id}`), false);
	assert.equal(navigations, 1); assert.equal(store.getSnapshot().markdown, "unsaved before leaving"); assert.equal(store.getSnapshot().dirty, true);
});

test("session stores are independent and a failed initial fetch never exposes an editable empty replacement", async () => {
	const store = new NotesStateStore("missing"); globalThis.fetch = async () => Response.json({ error: "unavailable" }, { status: 503 });
	assert.equal(await store.open(), false); store.edit("must not overwrite unknown notes"); assert.equal(store.getSnapshot().markdown, "");
});
