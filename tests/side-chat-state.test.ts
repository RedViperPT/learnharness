import test from "node:test";
import assert from "node:assert/strict";
import { getSideChatStore, SideChatProvider, SideChatStateStore } from "../components/side-chat-state";
import type { SideChatQuote, SideChatThread } from "../src/core/contracts/chat";

const quote: SideChatQuote = {
	text: "a quoted idea",
	source: { kind: "message", messageId: "message-1" },
};

function thread(id: string, messages: SideChatThread["messages"] = []): SideChatThread {
	return { id, createdAt: "2026-11-06T10:00:00.000Z", messages };
}

function userMessage(text: string) {
	return { id: "user-1", role: "user" as const, text, at: "2026-11-06T10:00:01.000Z" };
}

function assistantMessage(text: string, error?: string) {
	return { id: "assistant-1", role: "assistant" as const, text, at: "2026-11-06T10:00:02.000Z", ...(error ? { error } : {}) };
}

function streamResponse() {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
	const encoder = new TextEncoder();
	return {
		response: new Response(body, { status: 200 }),
		write(value: string) { controller.enqueue(encoder.encode(value)); },
		close() { controller.close(); },
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

function event(value: unknown, newline = true) {
	return `${JSON.stringify(value)}${newline ? "\n" : ""}`;
}

async function settleStream() {
	for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function withFetch(fake: typeof fetch, run: () => Promise<void>) {
	const previous = globalThis.fetch;
	globalThis.fetch = fake;
	try { await run(); }
	finally { globalThis.fetch = previous; }
}

function makeStore(name: string) {
	return new SideChatStateStore(`side-state-${name}-${Math.random().toString(36).slice(2)}`);
}

function savedThreads(store: SideChatStateStore) {
	return Object.values(store.getSnapshot().entries).flatMap((entry) => entry.thread ? [entry.thread] : []);
}

function assertRequest(body: Record<string, unknown> | undefined, expected: Record<string, unknown>) {
	assert.ok(body);
	assert.equal(typeof body.requestId, "string");
	assert.match(body.requestId as string, /^\d{13}_[a-f0-9-]{36}$/);
	assert.ok(Math.abs(Number((body.requestId as string).split("_")[0]) - Date.now()) < 10_000);
	const { requestId: _requestId, ...payload } = body;
	assert.deepEqual(payload, expected);
}

test("exports the shared provider/store API and retains independent per-chat memory", () => {
	assert.equal(typeof SideChatProvider, "function");
	const first = getSideChatStore("side-state-retained-a");
	const second = getSideChatStore("side-state-retained-b");
	const key = first.openNew(quote);
	first.setDraft(key, { text: "remember this", quotes: [quote] });
	first.setOpen(false);
	second.openNew();
	assert.equal(getSideChatStore("side-state-retained-a").getSnapshot().entries[key]?.draft?.text, "remember this");
	assert.equal(first.getSnapshot().entries[key]?.draft?.quotes[0]?.text, quote.text);
	assert.notEqual(second.getSnapshot().activeKey, key);
});

test("openNew keeps oversized quote text intact; addQuote refuses limits and exposes validation", () => {
	const store = makeStore("quote-validation");
	const huge = { ...quote, text: "x".repeat(8_001) };
	const key = store.openNew(huge);
	assert.equal(store.getSnapshot().entries[key]?.draft?.quotes[0]?.text.length, 8_001);
	assert.match(store.getSnapshot().validationError, /8,000/);
	store.setDraft(key, { text: "", quotes: [] });
	assert.equal(store.getSnapshot().validationError, "");
	for (let i = 0; i < 5; i++) assert.equal(store.addQuote({ ...quote, text: `quote ${i}` }), true);
	const before = store.getSnapshot().entries[key]?.draft?.quotes.length;
	assert.equal(store.addQuote(quote), false);
	assert.equal(store.getSnapshot().entries[key]?.draft?.quotes.length, before);
	assert.match(store.getSnapshot().validationError, /at most 5/);
});

test("HTTP refusals preserve the draft and store a human-readable error", async () => {
	const store = makeStore("refusal");
	const key = store.openNew();
	store.setDraft(key, { text: "Do not lose me", quotes: [quote] });
	await withFetch(async (_input, init) => {
		assert.equal(JSON.parse(String(init?.body)).text, "Do not lose me");
		return Response.json({ code: "invalid_quote", error: "A quote is unavailable in this lesson." }, { status: 400 });
	}, async () => {
		assert.equal(await store.ask(key), false);
	});
	assert.equal(store.getSnapshot().entries[key]?.draft?.text, "Do not lose me");
	assert.equal(store.getSnapshot().entries[key]?.draft?.quotes[0]?.text, quote.text);
	assert.equal(store.getSnapshot().entries[key]?.error, "A quote is unavailable in this lesson.");
	assert.equal(store.getSnapshot().entries[key]?.sending, false);
});

test("saving retains the client entry and changed draft without taking active navigation", async () => {
	const store = makeStore("promotion");
	const key = store.openNew(quote);
	store.setDraft(key, { text: "Submitted", quotes: [quote] });
	let resolvePost!: (response: Response) => void;
	const pendingPost = new Promise<Response>((resolve) => { resolvePost = resolve; });
	let sentBody: Record<string, unknown> | undefined;
	await withFetch(async (_input, init) => {
		sentBody = JSON.parse(String(init?.body));
		return pendingPost;
	}, async () => {
		const asking = store.ask(key);
		store.setDraft(key, { text: "Typed while waiting", quotes: [{ ...quote, text: "new quote" }] });
		const other = store.openNew();
		store.setActive(other);
		const stream = streamResponse();
		resolvePost(stream.response);
		assert.equal(await asking, true);
		stream.write(event({ type: "thread", thread: thread("promoted-1", [userMessage("Submitted")]) }));
		await settleStream();
		assertRequest(sentBody, { text: "Submitted", quotes: [quote] });
		const snapshot = store.getSnapshot();
		assert.equal(snapshot.activeKey, other, "promotion must not steal a later selection");
		assert.equal(snapshot.entries[key]?.thread?.id, "promoted-1");
		assert.equal(snapshot.entries[key]?.draft?.text, "Typed while waiting");
		assert.equal(snapshot.entries[key]?.draft?.quotes[0]?.text, "new quote");
		assert.equal(snapshot.entries["promoted-1"], undefined, "server identity must not become a second entry");
		stream.close();
		await settleStream();
	});
});

test("retry consumes streamed replacements, preserves the next draft, and keeps persisted failure retryable", async () => {
	const store = makeStore("retry");
	const failed = thread("retry-1", [userMessage("Original"), assistantMessage("partial", "provider refused")]);
	store.setThreads([failed]);
	store.setDraft(failed.id, { text: "Next question draft", quotes: [quote] });
	const stream = streamResponse();
	let sentBody: Record<string, unknown> | undefined;
	await withFetch(async (_input, init) => {
		sentBody = JSON.parse(String(init?.body));
		return stream.response;
	}, async () => {
		assert.equal(await store.ask(failed.id, { retry: true }), true);
		stream.write(event({ type: "thread", thread: thread(failed.id, [userMessage("Original")]) }));
		stream.write(event({ type: "text", text: "first" }));
		stream.write(event({ type: "text", text: "complete replacement" }));
		await settleStream();
		assert.equal(store.getSnapshot().entries[failed.id]?.answer, "complete replacement");
		stream.write(event({ type: "done", thread: thread(failed.id, [userMessage("Original"), assistantMessage("still failed", "retry failed")]) }));
		stream.close();
		await settleStream();
	});
	assertRequest(sentBody, { threadId: failed.id, retry: true });
	assert.equal(store.getSnapshot().entries[failed.id]?.draft?.text, "Next question draft");
	assert.equal(store.getSnapshot().entries[failed.id]?.error, undefined);
	assert.equal(savedThreads(store)[0]?.messages.at(-1)?.error, "retry failed");
	assert.equal(savedThreads(store)[0]?.messages.at(-1)?.text, "still failed");
	const secondStream = streamResponse();
	await withFetch(async (_input, init) => {
		assertRequest(JSON.parse(String(init?.body)), { threadId: failed.id, retry: true });
		return secondStream.response;
	}, async () => {
		assert.equal(await store.ask(failed.id, { retry: true }), true);
		secondStream.write(event({ type: "thread", thread: thread(failed.id, [userMessage("Original")]) }));
		secondStream.write(event({ type: "done", thread: thread(failed.id, [userMessage("Original"), assistantMessage("recovered")]) }));
		secondStream.close();
		await settleStream();
	});
	assert.equal(store.getSnapshot().entries[failed.id]?.error, undefined);
});

test("different thread answers can stream independently", async () => {
	const store = makeStore("parallel-streams");
	const first = thread("parallel-1", [userMessage("one"), assistantMessage("answer one")]);
	const second = thread("parallel-2", [userMessage("two"), assistantMessage("answer two")]);
	store.setThreads([first, second]);
	store.setDraft(first.id, { text: "follow-up one", quotes: [] });
	store.setDraft(second.id, { text: "follow-up two", quotes: [] });
	const streams = new Map([[first.id, streamResponse()], [second.id, streamResponse()]]);
	await withFetch(async (_input, init) => {
		const body = JSON.parse(String(init?.body)) as { threadId: string };
		return streams.get(body.threadId)!.response;
	}, async () => {
		assert.deepEqual(await Promise.all([store.ask(first.id), store.ask(second.id)]), [true, true]);
		streams.get(first.id)!.write(event({ type: "thread", thread: first }));
		streams.get(second.id)!.write(event({ type: "thread", thread: second }));
		streams.get(first.id)!.write(event({ type: "text", text: "one answer" }));
		streams.get(second.id)!.write(event({ type: "text", text: "two answer" }));
		await settleStream();
		assert.equal(store.getSnapshot().entries[first.id]?.answer, "one answer");
		assert.equal(store.getSnapshot().entries[second.id]?.answer, "two answer");
		streams.get(first.id)!.close();
		streams.get(second.id)!.close();
		await settleStream();
	});
});

test("split chunks, malformed lines and unterminated final NDJSON heal through canonical refresh", async () => {
	const store = makeStore("ndjson");
	const key = store.openNew();
	store.setDraft(key, { text: "Question", quotes: [] });
	const stream = streamResponse();
	let refreshes = 0;
	await withFetch(async (input, init) => {
		if (init?.method === "POST") return stream.response;
		refreshes++;
		return Response.json({ threads: [thread("ndjson-1", [userMessage("Question"), assistantMessage("canonical")])], answering: {} });
	}, async () => {
		assert.equal(await store.ask(key), true);
		const line = event({ type: "thread", thread: thread("ndjson-1", [userMessage("Question")]) }, false);
		stream.write("{bad json}\n" + line.slice(0, 19));
		stream.write(line.slice(19));
		stream.close();
		await settleStream();
	});
	assert.ok(refreshes >= 1);
	assert.equal(savedThreads(store).find((item) => item.id === "ndjson-1")?.messages.at(-1)?.text, "canonical");
	assert.equal(store.getSnapshot().entries[key]?.answer, undefined);
});

test("local live answer survives a stale GET and switching threads during a stream", async () => {
	const store = makeStore("switch-live");
	const key = store.openNew();
	store.setDraft(key, { text: "First", quotes: [] });
	let resolveGet!: (response: Response) => void;
	let getPromise: Promise<Response> | undefined;
	const stream = streamResponse();
	await withFetch(async (_input, init) => {
		if (init?.method === "POST") return stream.response;
		getPromise ??= new Promise<Response>((resolve) => { resolveGet = resolve; });
		return getPromise;
	}, async () => {
		const stale = store.refresh();
		assert.equal(await store.ask(key), true);
		stream.write(event({ type: "thread", thread: thread("live-1", [userMessage("First")]) }));
		stream.write(event({ type: "text", text: "full local answer" }));
		await settleStream();
		const second = store.openNew();
		store.setDraft(second, { text: "Second", quotes: [] });
		assert.equal(store.getSnapshot().activeKey, second);
		resolveGet!(Response.json({ threads: [], answering: { "live-1": "" } }));
		await stale;
		assert.equal(store.getSnapshot().entries[key]?.answer, "full local answer");
		assert.equal(store.getSnapshot().activeKey, second);
		stream.close();
		await settleStream();
	});
});

test("delete tombstone blocks late stream and refresh resurrection", async () => {
	const store = makeStore("delete-tombstone");
	const saved = thread("deleted-1", [userMessage("Question")]);
	store.setThreads([saved]);
	const stream = streamResponse();
	let deleteStarted!: () => void;
	const started = new Promise<void>((resolve) => { deleteStarted = resolve; });
	let resolveDelete!: (response: Response) => void;
	const deleteResponse = new Promise<Response>((resolve) => { resolveDelete = resolve; });
	await withFetch(async (_input, init) => {
		if (init?.method === "DELETE") { deleteStarted(); return deleteResponse; }
		if (init?.method === "POST") return stream.response;
		return Response.json({ threads: [saved], answering: {} });
	}, async () => {
		// A retry can have a live stream when a saved thread is removed.
		const retry = store.ask(saved.id, { retry: true });
		await settleStream();
		stream.write(event({ type: "thread", thread: saved }));
		await settleStream();
		const removing = store.remove(saved.id);
		await started;
		stream.write(event({ type: "done", thread: thread(saved.id, [userMessage("Question"), assistantMessage("late")]) }));
		stream.close();
		resolveDelete(Response.json({ ok: true }));
		assert.equal(await removing, true);
		assert.equal(await retry, true);
		await settleStream();
	});
	assert.equal(savedThreads(store).some((item) => item.id === saved.id), false);
});

test("external empty-answering snapshots count as busy and are adoptable", async () => {
	const store = makeStore("external");
	await withFetch(async () => Response.json({ threads: [thread("external-1", [userMessage("Original")])], answering: { "external-1": "" } }), async () => {
		await store.refresh();
	});
	assert.equal(store.getSnapshot().entries["external-1"]?.answer, "");
	store.setDraft("external-1", { text: "Follow up", quotes: [] });
	await withFetch(async (_input, init) => {
		assert.equal(init?.method, "POST");
		return Response.json({ error: "still answering" }, { status: 409 });
	}, async () => {
		assert.equal(await store.ask("external-1"), false);
	});
	assert.equal(store.getSnapshot().entries["external-1"]?.draft?.text, "Follow up");
});

test("refresh clears a selected thread deleted elsewhere and refuses its stale key", async () => {
	const store = makeStore("external-delete-active");
	const saved = thread("external-delete-active-1", [userMessage("Original")]);
	store.setThreads([saved]);
	store.setActive(saved.id);
	let posts = 0;
	await withFetch(async (_input, init) => {
		if (init?.method === "POST") posts++;
		return init?.method === "POST"
			? Response.json({ error: "Unexpected send" }, { status: 400 })
			: Response.json({ threads: [], answering: {} });
	}, async () => {
		await store.refresh();
		assert.equal(savedThreads(store).length, 0);
		assert.equal(store.getSnapshot().activeKey, null);
		assert.equal(await store.ask(saved.id), false);
	});
	assert.equal(posts, 0, "a missing saved thread must not be silently created as a new one");
});

test("refresh preserves a deleted thread's follow-up draft as a selectable new-question draft", async () => {
	const store = makeStore("external-delete-draft");
	const saved = thread("external-delete-draft-1", [userMessage("Original")]);
	store.setThreads([saved]);
	store.setActive(saved.id);
	store.setDraft(saved.id, { text: "Unsent follow-up", quotes: [quote] });
	await withFetch(async () => Response.json({ threads: [], answering: {} }), async () => {
		await store.refresh();
	});
	const activeKey = store.getSnapshot().activeKey;
	assert.equal(activeKey, saved.id, "external deletion must not re-key the surviving composer");
	assert.deepEqual(store.getSnapshot().entries[activeKey!]?.draft, { text: "Unsent follow-up", quotes: [quote] });
	assert.equal(store.getSnapshot().entries[activeKey!]?.thread, undefined);
	const posts: Record<string, unknown>[] = [];
	await withFetch(async (_input, init) => {
		if (init?.method === "POST") posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
		return Response.json({ error: "Expected test refusal" }, { status: 400 });
	}, async () => {
		assert.equal(await store.ask(activeKey!), false);
	});
	assert.equal(posts.length, 1);
	assertRequest(posts[0], { text: "Unsent follow-up", quotes: [quote] });
});

test("failed DELETE restores canonical thread and returns false without an unhandled rejection", async () => {
	const store = makeStore("delete-failure");
	const saved = thread("failed-delete", [userMessage("Question")]);
	store.setThreads([saved]);
	await withFetch(async (_input, init) => {
		if (init?.method === "DELETE") return Response.json({ error: "Could not delete." }, { status: 500 });
		return Response.json({ threads: [saved], answering: {} });
	}, async () => {
		assert.equal(await store.remove(saved.id), false);
	});
	assert.equal(savedThreads(store).some((item) => item.id === saved.id), true);
	assert.equal(store.getSnapshot().entries[saved.id]?.error, "Could not delete.");
});

test("stop awaits and reports transport failures for only the selected thread", async () => {
	const store = makeStore("stop");
	const saved = thread("stop-1", [userMessage("Question")]);
	store.setThreads([saved]);
	await withFetch(async (input, init) => {
		assert.equal(String(input), `/api/chats/${encodeURIComponent(store.chatId)}/side-chats/${saved.id}/stop`);
		assert.equal(init?.method, "POST");
		return Response.json({ error: "Stop could not be sent." }, { status: 503 });
	}, async () => { await store.stop(saved.id); });
	assert.equal(store.getSnapshot().entries[saved.id]?.error, "Stop could not be sent.");
});

test("typing and opening a draft cannot starve the initial saved-history fetch", async () => {
	const store = makeStore("history-while-typing");
	let resolve!: (response: Response) => void;
	const response = new Promise<Response>(done => { resolve = done; });
	await withFetch(async () => response, async () => {
		const refreshing = store.refresh();
		const key = store.openNew();
		store.setDraft(key, { text: "Typed before the history loaded", quotes: [quote] });
		resolve(Response.json({ threads: [thread("existing-history", [userMessage("Earlier question"), assistantMessage("Earlier answer")])], answering: {} }));
		await refreshing;
		assert.equal(savedThreads(store)[0]?.id, "existing-history");
		assert.equal(store.getSnapshot().entries[key]?.draft?.text, "Typed before the history loaded");
		assert.equal(store.getSnapshot().activeKey, key);
	});
});

test("a refused deletion restores its unsent next question and selected conversation", async () => {
	const store = makeStore("delete-draft-rollback");
	const saved = thread("delete-draft", [userMessage("Original"), assistantMessage("Original answer")]);
	store.setThreads([saved]);
	store.setActive(saved.id);
	store.setDraft(saved.id, { text: "Do not discard this draft", quotes: [quote] });
	await withFetch(async (_input, init) => init?.method === "DELETE"
		? Response.json({ error: "Disk unavailable" }, { status: 500 })
		: Response.json({ threads: [saved], answering: {} }), async () => {
		assert.equal(await store.remove(saved.id), false);
	});
	assert.equal(store.getSnapshot().activeKey, saved.id);
	assert.deepEqual(store.getSnapshot().entries[saved.id]?.draft, { text: "Do not discard this draft", quotes: [quote] });
});

test("validation follows the selected draft instead of appearing on unrelated threads", () => {
	const store = makeStore("scoped-validation");
	const invalid = store.openNew({ ...quote, text: "x".repeat(8001) });
	const valid = store.openNew();
	assert.equal(store.getSnapshot().validationError, "");
	store.setActive(invalid);
	assert.match(store.getSnapshot().validationError, /8,000/);
	store.setActive(valid);
	assert.equal(store.getSnapshot().validationError, "");
});

test("a lost first stream never guesses between identical new saved questions", async () => {
	const store = makeStore("ambiguous-first-save");
	const key = store.openNew();
	store.setDraft(key, { text: "Same question", quotes: [] });
	const stream = streamResponse();
	await withFetch(async (_input, init) => init?.method === "POST" ? stream.response : Response.json({
		threads: [thread("candidate-a", [userMessage("Same question")]), thread("candidate-b", [userMessage("Same question")])], answering: {},
	}), async () => {
		assert.equal(await store.ask(key), true);
		stream.close();
		await settleStream();
	});
	assert.equal(store.getSnapshot().activeKey, key);
	assert.equal(store.getSnapshot().entries[key]?.thread, undefined);
	assert.equal(savedThreads(store).length, 2);
});

for (const first of ["GET", "POST"] as const) {
	test(`${first}-first acceptance keeps one stable entry and clears submitted fields only once`, async () => {
		const store = makeStore(`ordering-${first}`);
		const key = store.openNew(quote);
		store.setDraft(key, { text: "Submitted", quotes: [quote] });
		const post = deferred<Response>();
		const stream = streamResponse();
		let saved!: SideChatThread;
		await withFetch(async (_input, init) => {
			if (init?.method === "POST") {
				const body = JSON.parse(String(init.body));
				assertRequest(body, { text: "Submitted", quotes: [quote] });
				saved = { ...thread(`saved-${first}`, [userMessage("Submitted")]), creationRequestId: body.requestId };
				return post.promise;
			}
			return Response.json({ threads: [saved], answering: { [saved.id]: "" } });
		}, async () => {
			const asking = store.ask(key);
			if (first === "GET") await store.refresh();
			else { post.resolve(stream.response); assert.equal(await asking, true); }
			assert.deepEqual(store.getSnapshot().entries[key]?.draft, { text: "", quotes: [] });
			assert.equal(store.getSnapshot().activeKey, key);

			// Re-typing the same text and re-adding the very same quote is a new draft.
			store.setDraft(key, { text: "Submitted", quotes: [quote] });
			if (first === "GET") { post.resolve(stream.response); assert.equal(await asking, true); }
			else await store.refresh();
			stream.write(event({ type: "thread", thread: saved }));
			await settleStream();
			assert.equal(Object.keys(store.getSnapshot().entries).length, 1);
			assert.equal(store.getSnapshot().entries[key]?.thread?.id, saved.id);
			assert.deepEqual(store.getSnapshot().entries[key]?.draft, { text: "Submitted", quotes: [quote] });
			assert.equal(store.getSnapshot().activeKey, key);
			stream.write(event({ type: "done", thread: { ...saved, messages: [...saved.messages, assistantMessage("Answer")] } }));
			stream.close();
			await settleStream();
		});
	});
}

for (const edit of ["text", "quotes"] as const) {
	test(`GET-first acceptance preserves new ${edit} while removing the other submitted fields`, async () => {
		const store = makeStore(`admission-edit-${edit}`);
		const key = store.openNew(quote);
		store.setDraft(key, { text: "Submitted", quotes: [quote] });
		const post = deferred<Response>();
		const stream = streamResponse();
		const added = { ...quote, text: "Added during admission" };
		let saved!: SideChatThread;
		await withFetch(async (_input, init) => {
			if (init?.method === "POST") {
				saved = { ...thread(`edit-${edit}`, [userMessage("Submitted")]), creationRequestId: JSON.parse(String(init.body)).requestId };
				return post.promise;
			}
			return Response.json({ threads: [saved], answering: {} });
		}, async () => {
			const asking = store.ask(key);
			store.setDraft(key, edit === "text" ? { text: "Next question", quotes: [quote] } : { text: "Submitted", quotes: [quote, added] });
			await store.refresh();
			const expected = edit === "text" ? { text: "Next question", quotes: [] } : { text: "", quotes: [added] };
			assert.deepEqual(store.getSnapshot().entries[key]?.draft, expected);
			post.resolve(stream.response);
			assert.equal(await asking, true);
			stream.write(event({ type: "done", thread: saved }));
			stream.close();
			await settleStream();
			assert.deepEqual(store.getSnapshot().entries[key]?.draft, expected);
		});
	});
}

test("identical simultaneous questions bind by creation request even when GET returns reverse order", async () => {
	const store = makeStore("identical-correlated");
	const first = store.openNew(quote);
	const second = store.openNew(quote);
	for (const key of [first, second]) store.setDraft(key, { text: "Same question", quotes: [quote] });
	const posts = [deferred<Response>(), deferred<Response>()];
	const streams = [streamResponse(), streamResponse()];
	const saved: SideChatThread[] = [];
	await withFetch(async (_input, init) => {
		if (init?.method === "POST") {
			const index = saved.length;
			saved.push({ ...thread(`same-${index}`, [userMessage("Same question")]), creationRequestId: JSON.parse(String(init.body)).requestId });
			return posts[index]!.promise;
		}
		return Response.json({ threads: [...saved].reverse(), answering: {} });
	}, async () => {
		const asking = [store.ask(first), store.ask(second)];
		await store.refresh();
		assert.equal(Object.keys(store.getSnapshot().entries).length, 2);
		assert.equal(store.getSnapshot().entries[first]?.thread?.id, "same-0");
		assert.equal(store.getSnapshot().entries[second]?.thread?.id, "same-1");
		assert.equal(store.getSnapshot().activeKey, second);
		for (let index = 0; index < 2; index++) {
			posts[index]!.resolve(streams[index]!.response);
			assert.equal(await asking[index], true);
			streams[index]!.write(event({ type: "done", thread: saved[index] }));
			streams[index]!.close();
		}
		await settleStream();
		assert.equal(Object.keys(store.getSnapshot().entries).length, 2);
	});
});

for (const correlation of [undefined, "another-client-request"]) {
	test(`a unique identical foreign thread with ${correlation ? "different" : "no"} correlation cannot claim a draft`, async () => {
		const store = makeStore("foreign-content");
		const key = store.openNew();
		store.setDraft(key, { text: "Same question", quotes: [] });
		const post = deferred<Response>();
		const foreign = { ...thread("foreign-thread", [userMessage("Same question")]), ...(correlation ? { creationRequestId: correlation } : {}) };
		await withFetch(async (_input, init) => init?.method === "POST" ? post.promise : Response.json({ threads: [foreign], answering: {} }), async () => {
			const asking = store.ask(key);
			await store.refresh();
			assert.equal(store.getSnapshot().entries[key]?.thread, undefined);
			assert.equal(store.getSnapshot().entries[key]?.draft?.text, "Same question");
			assert.equal(store.getSnapshot().activeKey, key);
			assert.equal(savedThreads(store).length, 1);
			post.resolve(Response.json({ error: "Not admitted" }, { status: 503 }));
			assert.equal(await asking, false);
		});
	});
}

test("a lost POST response retains correlation for a later saved-thread refresh", async () => {
	const store = makeStore("lost-post-recovery");
	const key = store.openNew(quote);
	store.setDraft(key, { text: "Saved despite disconnection", quotes: [quote] });
	let saved!: SideChatThread;
	let discover = false;
	await withFetch(async (input, init) => {
		if (init?.method === "POST") {
			if (String(input).endsWith("/stop")) return Response.json({ ok: true });
			saved = { ...thread("lost-post", [userMessage("Saved despite disconnection")]), creationRequestId: JSON.parse(String(init.body)).requestId };
			throw new Error("Disconnected");
		}
		return Response.json({ threads: discover ? [saved] : [], answering: discover ? { [saved.id]: "External partial answer" } : {} });
	}, async () => {
		assert.equal(await store.ask(key), false);
		await settleStream();
		assert.equal(store.getSnapshot().entries[key]?.draft?.text, "Saved despite disconnection");
		assert.ok(store.getSnapshot().entries[key]?.error);
		discover = true;
		await store.refresh();
		assert.equal(Object.keys(store.getSnapshot().entries).length, 1);
		assert.equal(store.getSnapshot().entries[key]?.thread?.id, saved.id);
		assert.deepEqual(store.getSnapshot().entries[key]?.draft, { text: "", quotes: [] });
		assert.equal(store.getSnapshot().entries[key]?.error, undefined);
		assert.equal(store.getSnapshot().entries[key]?.sending, false);
		assert.equal(store.getSnapshot().entries[key]?.answer, "External partial answer");
		await store.stop(key);
	});
});

test("a lost first stream attaches by request without erasing the next draft", async () => {
	const store = makeStore("lost-stream-correlated");
	const key = store.openNew();
	store.setDraft(key, { text: "Submitted", quotes: [] });
	const stream = streamResponse();
	let saved!: SideChatThread;
	await withFetch(async (_input, init) => {
		if (init?.method === "POST") {
			saved = { ...thread("lost-stream", [userMessage("Submitted")]), creationRequestId: JSON.parse(String(init.body)).requestId };
			return stream.response;
		}
		return Response.json({ threads: [saved], answering: { [saved.id]: "" } });
	}, async () => {
		assert.equal(await store.ask(key), true);
		store.setDraft(key, { text: "Next question", quotes: [quote] });
		stream.close();
		await settleStream();
		assert.equal(Object.keys(store.getSnapshot().entries).length, 1);
		assert.equal(store.getSnapshot().entries[key]?.thread?.id, saved.id);
		assert.deepEqual(store.getSnapshot().entries[key]?.draft, { text: "Next question", quotes: [quote] });
		assert.equal(store.getSnapshot().activeKey, key);
	});
});

test("a refresh of an existing thread cannot acknowledge a still-pending follow-up", async () => {
	const store = makeStore("follow-up-admission");
	const saved = { ...thread("follow-up", [userMessage("Original"), assistantMessage("Answer")]), creationRequestId: "old-creation" };
	store.setThreads([saved]);
	store.setDraft(saved.id, { text: "Not accepted yet", quotes: [quote] });
	const post = deferred<Response>();
	await withFetch(async (_input, init) => init?.method === "POST" ? post.promise : Response.json({ threads: [saved], answering: {} }), async () => {
		const asking = store.ask(saved.id);
		await store.refresh();
		assert.deepEqual(store.getSnapshot().entries[saved.id]?.draft, { text: "Not accepted yet", quotes: [quote] });
		post.resolve(Response.json({ error: "Refused" }, { status: 400 }));
		assert.equal(await asking, false);
		assert.deepEqual(store.getSnapshot().entries[saved.id]?.draft, { text: "Not accepted yet", quotes: [quote] });
	});
});

test("stopping switches from request cancellation to thread stopping after GET discovers the thread", async () => {
	const store = makeStore("cancel-stable-key");
	const key = store.openNew();
	store.setDraft(key, { text: "Cancel me", quotes: [] });
	const post = deferred<Response>();
	const requests: string[] = [];
	let saved!: SideChatThread;
	await withFetch(async (input, init) => {
		if (String(input).endsWith("/cancel")) {
			const { requestId } = JSON.parse(String(init?.body));
			requests.push("cancel");
			assert.equal(requestId, saved.creationRequestId);
			return Response.json({ ok: true });
		}
		if (String(input).endsWith("/stop")) {
			requests.push("stop");
			assert.equal(String(input), `/api/chats/${encodeURIComponent(store.chatId)}/side-chats/${saved.id}/stop`);
			assert.equal(init?.method, "POST");
			return Response.json({ ok: true });
		}
		if (init?.method === "POST") {
			saved = { ...thread("cancel-saved", [userMessage("Cancel me")]), creationRequestId: JSON.parse(String(init.body)).requestId };
			return post.promise;
		}
		return Response.json({ threads: [saved], answering: {} });
	}, async () => {
		const asking = store.ask(key);
		await store.stop(key);
		await store.refresh();
		await store.stop(key);
		assert.deepEqual(requests, ["cancel", "stop"]);
		assert.equal(store.getSnapshot().activeKey, key);
		post.resolve(Response.json({ cancelled: true }));
		assert.equal(await asking, false);
		assert.equal(store.getSnapshot().entries[key]?.sending, false);
	});
});

test("a locally streaming answer uses thread stopping after its request expires", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
	const store = makeStore("stop-expired-stream");
	const key = store.openNew();
	store.setDraft(key, { text: "Explain?", quotes: [] });
	const stream = streamResponse();
	let saved!: SideChatThread;
	let stops = 0;
	await withFetch(async (input, init) => {
		if (String(input).endsWith("/stop")) {
			assert.equal(String(input), `/api/chats/${encodeURIComponent(store.chatId)}/side-chats/${saved.id}/stop`);
			assert.equal(init?.method, "POST");
			stops++;
			return Response.json({ ok: true });
		}
		if (init?.method === "POST") {
			assert.equal(String(input).endsWith("/cancel"), false);
			saved = { ...thread("long-running", [userMessage("Explain?")]), creationRequestId: JSON.parse(String(init.body)).requestId };
			return stream.response;
		}
		return Response.json({ threads: [saved], answering: {} });
	}, async () => {
		assert.equal(await store.ask(key), true);
		stream.write(event({ type: "thread", thread: saved }));
		stream.write(event({ type: "text", text: "Partial answer" }));
		await settleStream();
		t.mock.timers.tick(5 * 60 * 1_000 + 1);
		await store.stop(key);
		assert.equal(stops, 1);
		assert.equal(store.getSnapshot().entries[key]?.error, undefined);
		saved = { ...saved, messages: [...saved.messages, { ...assistantMessage("Partial answer"), stopped: true }] };
		stream.write(event({ type: "done", thread: saved }));
		stream.close();
		await settleStream();
		assert.equal(store.getSnapshot().entries[key]?.thread?.messages.at(-1)?.stopped, true);
	});
});

test("failed deletion restores the original client key, composer, and selection after saving", async () => {
	const store = makeStore("stable-delete-rollback");
	const key = store.openNew();
	store.setDraft(key, { text: "Original", quotes: [] });
	let saved!: SideChatThread;
	await withFetch(async (_input, init) => {
		if (init?.method === "DELETE") return Response.json({ error: "Disk unavailable" }, { status: 503 });
		if (init?.method === "POST") {
			saved = { ...thread("stable-delete-saved", [userMessage("Original"), assistantMessage("Answer")]), creationRequestId: JSON.parse(String(init.body)).requestId };
			return new Response(event({ type: "done", thread: saved }));
		}
		return Response.json({ threads: [saved], answering: {} });
	}, async () => {
		assert.equal(await store.ask(key), true);
		await settleStream();
		store.setDraft(key, { text: "Keep next question", quotes: [quote] });
		assert.equal(await store.remove(key), false);
		assert.equal(Object.keys(store.getSnapshot().entries).length, 1);
		assert.equal(store.getSnapshot().activeKey, key);
		assert.equal(store.getSnapshot().entries[key]?.thread?.id, saved.id);
		assert.deepEqual(store.getSnapshot().entries[key]?.draft, { text: "Keep next question", quotes: [quote] });
		assert.equal(store.getSnapshot().entries[key]?.error, "Disk unavailable");
	});
});

test("deleting a GET-discovered entry before POST returns blocks its late response and resurrection", async () => {
	const store = makeStore("stable-delete-before-post");
	const key = store.openNew();
	store.setDraft(key, { text: "Original", quotes: [] });
	const post = deferred<Response>();
	let saved!: SideChatThread;
	await withFetch(async (_input, init) => {
		if (init?.method === "DELETE") return Response.json({ ok: true });
		if (init?.method === "POST") {
			saved = { ...thread("delete-before-post", [userMessage("Original")]), creationRequestId: JSON.parse(String(init.body)).requestId };
			return post.promise;
		}
		return Response.json({ threads: [saved], answering: {} });
	}, async () => {
		const asking = store.ask(key);
		await store.refresh();
		assert.equal(await store.remove(key), true);
		post.resolve(new Response(event({ type: "done", thread: saved })));
		assert.equal(await asking, false);
		await store.refresh();
		assert.deepEqual(store.getSnapshot().entries, {});
		assert.equal(store.getSnapshot().activeKey, null);
	});
});

test("follow-up and retry address the saved server ID while retaining the original entry key", async () => {
	const store = makeStore("stable-follow-up-retry");
	const key = store.openNew();
	store.setDraft(key, { text: "Original", quotes: [] });
	const bodies: Record<string, unknown>[] = [];
	let saved!: SideChatThread;
	await withFetch(async (_input, init) => {
		if (init?.method !== "POST") return Response.json({ threads: [saved], answering: {} });
		const body = JSON.parse(String(init.body));
		bodies.push(body);
		if (bodies.length === 1) {
			saved = { ...thread("stable-server-id", [userMessage("Original"), assistantMessage("Answer")]), creationRequestId: body.requestId };
		} else if (body.retry) {
			saved = { ...saved, messages: [...saved.messages.slice(0, -1), assistantMessage("Recovered")] };
		} else {
			saved = { ...saved, messages: [...saved.messages, userMessage("Follow-up"), assistantMessage("Partial", "Failed")] };
		}
		return new Response(event({ type: "done", thread: saved }));
	}, async () => {
		assert.equal(await store.ask(key), true);
		await settleStream();
		store.setDraft(key, { text: "Follow-up", quotes: [] });
		assert.equal(await store.ask(key), true);
		await settleStream();
		store.setDraft(key, { text: "Unsent next question", quotes: [quote] });
		assert.equal(await store.ask(key, { retry: true }), true);
		await settleStream();
		assertRequest(bodies[0], { text: "Original", quotes: [] });
		assertRequest(bodies[1], { threadId: saved.id, text: "Follow-up", quotes: [] });
		assertRequest(bodies[2], { threadId: saved.id, retry: true });
		assert.equal(new Set(bodies.map((body) => body.requestId)).size, 3);
		assert.equal(Object.keys(store.getSnapshot().entries).length, 1);
		assert.equal(store.getSnapshot().activeKey, key);
		assert.equal(store.getSnapshot().entries[key]?.thread?.messages.at(-1)?.text, "Recovered");
		assert.deepEqual(store.getSnapshot().entries[key]?.draft, { text: "Unsent next question", quotes: [quote] });
	});
});

test("cancelling before admission preserves the question and quotes under their stable key", async () => {
	const store = makeStore("cancel-before-admission");
	const key = store.openNew(quote);
	store.setDraft(key, { text: "Not admitted", quotes: [quote] });
	const post = deferred<Response>();
	let requestId: string;
	await withFetch(async (input, init) => {
		const body = JSON.parse(String(init?.body));
		if (String(input).endsWith("/cancel")) {
			assert.equal(body.requestId, requestId);
			post.resolve(Response.json({ cancelled: true }));
			return Response.json({ ok: true });
		}
		requestId = body.requestId;
		return post.promise;
	}, async () => {
		const asking = store.ask(key);
		await store.stop(key);
		assert.equal(await asking, false);
		assert.equal(store.getSnapshot().activeKey, key);
		assert.equal(store.getSnapshot().entries[key]?.thread, undefined);
		assert.equal(store.getSnapshot().entries[key]?.sending, false);
		assert.deepEqual(store.getSnapshot().entries[key]?.draft, { text: "Not admitted", quotes: [quote] });
	});
});

test("acceptance does not dismiss a distinct cancellation error raised while POST was pending", async () => {
	const store = makeStore("pending-cancel-error");
	const key = store.openNew();
	store.setDraft(key, { text: "Original", quotes: [] });
	const post = deferred<Response>();
	const stream = streamResponse();
	let saved!: SideChatThread;
	await withFetch(async (input, init) => {
		if (String(input).endsWith("/cancel")) return Response.json({ error: "Cancel could not be sent" }, { status: 503 });
		if (init?.method === "POST") {
			saved = { ...thread("pending-error-saved", [userMessage("Original")]), creationRequestId: JSON.parse(String(init.body)).requestId };
			return post.promise;
		}
		return Response.json({ threads: [saved], answering: {} });
	}, async () => {
		const asking = store.ask(key);
		await store.stop(key);
		await store.refresh();
		assert.equal(store.getSnapshot().entries[key]?.error, "Cancel could not be sent");
		post.resolve(stream.response);
		assert.equal(await asking, true);
		assert.equal(store.getSnapshot().entries[key]?.error, "Cancel could not be sent");
		stream.write(event({ type: "done", thread: saved }));
		stream.close();
		await settleStream();
	});
});
