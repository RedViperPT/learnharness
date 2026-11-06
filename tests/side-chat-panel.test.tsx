import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import type { SideChatQuote, SideChatThread } from "../src/core/index.ts";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { getSideChatStore, SideChatProvider } from "../components/side-chat-state.tsx";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const { window, document } = parseHTML("<html><body></body></html>");
let active: Element = document.body;
let available = 1200;
Object.defineProperty(document, "activeElement", { get: () => active });
// linkedom lacks the native defaultValue setter that React uses on textarea mount.
Object.defineProperty(window.HTMLTextAreaElement.prototype, "defaultValue", {
	get() { return this.textContent; },
	set(value: string) { this.textContent = value; },
});
Object.assign(document, { oninput: null });
window.HTMLElement.prototype.focus = function () { active = this; };
window.HTMLElement.prototype.getBoundingClientRect = function () {
	return { x: 0, y: 0, top: 0, left: 0, right: available, bottom: 800, width: available, height: 800, toJSON() {} };
};
const resizeCallbacks = new Set<() => void>();
class TestResizeObserver {
	constructor(private callback: () => void) { resizeCallbacks.add(callback); }
	observe() {}
	disconnect() { resizeCallbacks.delete(this.callback); }
}
Object.assign(globalThis, { window, document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, Event: window.Event, CustomEvent: window.CustomEvent, ResizeObserver: TestResizeObserver });
const { SideChatPanel, clampSideChatWidth } = await import("../components/side-chat-panel.tsx");
const originalFetch = globalThis.fetch;
const roots: { root: Root; host: HTMLElement }[] = [];
let sequence = 0;

afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => root.unmount());
		host.remove();
	}
	globalThis.fetch = originalFetch;
	available = 1200;
});

async function mount(initial: SideChatThread[] = [], obscured = false) {
	const chatId = `panel-ui-${++sequence}`;
	const store = getSideChatStore(chatId);
	const requests: { url: string; body?: Record<string, unknown> }[] = [];
	let threads = structuredClone(initial);
	globalThis.fetch = (async (url, init) => {
		const address = String(url);
		if (!address.includes(`/api/chats/${chatId}/side-chats`)) throw new Error(`Unexpected lesson request: ${address}`);
		if (!init?.method || init.method === "GET") return Response.json({ threads, answering: {} });
		const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
		requests.push({ url: address, body });
		if (init.method === "DELETE") {
			threads = threads.filter(thread => !address.endsWith(thread.id));
			return Response.json({ ok: true });
		}
		if (address.endsWith("/stop")) return Response.json({ ok: true });
		const target = threads.find(thread => thread.id === body?.threadId);
		const thread = target ? structuredClone(target) : { id: `side_ui_${sequence}`, createdAt: "2026-11-06T00:00:00Z", messages: [] } as SideChatThread;
		if (body?.retry) thread.messages = thread.messages.filter(message => message.error === undefined);
		else thread.messages.push({ id: "ui-question", role: "user", text: String(body?.text), at: "2026-11-06T00:00:01Z" });
		const accepted = structuredClone(thread);
		thread.messages.push({ id: "ui-answer", role: "assistant", text: "Recovered side answer.", at: "2026-11-06T00:00:02Z" });
		threads = [...threads.filter(item => item.id !== thread.id), thread];
		return new Response([{ type: "thread", thread: accepted }, { type: "done", thread }].map(value => JSON.stringify(value)).join("\n") + "\n");
	}) as typeof fetch;
	const host = document.createElement("div") as unknown as HTMLElement;
	host.setAttribute("data-session-shell", "");
	document.body.append(host);
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(host);
	roots.push({ root, host });
	const render = (covered = obscured) => root.render(
		<ServerEventsProvider connect={() => ({ onEvent() {}, onOpen() {}, close() {} })}>
			<SideChatProvider chatId={chatId}><SideChatPanel chatId={chatId} obscured={covered} /></SideChatProvider>
		</ServerEventsProvider>,
	);
	await act(async () => { render(); });
	await act(async () => { store.openNew(); });
	return { store, host, requests, render };
}

async function click(element: Element | null) {
	assert.ok(element);
	await act(async () => { element.dispatchEvent(new window.Event("click", { bubbles: true })); });
}
async function key(element: Element, value: string, shiftKey = false) {
	await act(async () => {
		const event = new window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(event, { key: value, shiftKey, ctrlKey: false, metaKey: false, altKey: false });
		element.dispatchEvent(event);
	});
}

test("panel observes session space, switches to overlay, and supports keyboard resize", async () => {
	const { host } = await mount();
	assert.equal(host.querySelector('[data-testid="side-chat-panel"]')?.getAttribute("data-layout"), "column");
	const divider = host.querySelector('[role="separator"]')!;
	const before = Number(divider.getAttribute("aria-valuenow"));
	await key(divider, "ArrowLeft");
	assert.equal(Number(divider.getAttribute("aria-valuenow")), clampSideChatWidth(before + 24, available));
	await key(divider, "Home");
	assert.equal(divider.getAttribute("aria-valuenow"), "320");
	await act(async () => { available = 799; for (const callback of resizeCallbacks) callback(); });
	assert.equal(host.querySelector('[data-testid="side-chat-panel"]')?.getAttribute("data-layout"), "overlay");
	assert.equal(host.querySelector('[role="separator"]'), null);
});

test("the panel claims Enter, Tab, arrows, and Space without triggering main-dock keyboard listeners", async () => {
	const { host, store, requests } = await mount();
	const seen: string[] = [];
	const mainListener = (event: Event) => seen.push((event as KeyboardEvent).key);
	document.addEventListener("keydown", mainListener);
	try {
		const textarea = host.querySelector("textarea")!;
		for (const value of ["Enter", "Tab", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " "]) await key(textarea, value);
		await key(textarea, "Enter", true);
		assert.deepEqual(seen, []);
		assert.equal(requests.length, 0, "empty Enter and Shift+Enter cannot send a lesson or side question");
		assert.equal(store.getSnapshot().panelOpen, true);
	} finally { document.removeEventListener("keydown", mainListener); }
});

test("Escape dismisses History before the panel and preserves its draft", async () => {
	const { host, store } = await mount();
	const activeKey = store.getSnapshot().activeKey!;
	await act(async () => store.setDraft(activeKey, { text: "Unsent clarification", quotes: [] }));
	await click(host.querySelector('[aria-label="Side question history"]'));
	assert.ok(host.querySelector('nav[aria-label="Side question history"]'));
	await key(host.querySelector("aside")!, "Escape");
	assert.equal(host.querySelector("nav"), null);
	assert.equal(store.getSnapshot().panelOpen, true);
	await key(host.querySelector("textarea")!, "Escape");
	assert.equal(store.getSnapshot().panelOpen, false);
	assert.equal(store.getSnapshot().entries[activeKey]?.draft?.text, "Unsent clarification");
});

test("a covering Plan overlay takes keyboard priority without closing or clearing the side panel", async () => {
	const { host, store, render } = await mount();
	await act(async () => { render(true); });
	assert.ok(host.querySelector("aside")?.hasAttribute("inert"));
	await key(document.body as unknown as Element, "Escape");
	assert.equal(store.getSnapshot().panelOpen, true);
	await act(async () => { render(false); });
	assert.equal(host.querySelector("aside")?.hasAttribute("inert"), false);
});

test("history reopens a persisted failed answer with a working explicit Retry action", async () => {
	const thread: SideChatThread = { id: "side_failed_ui", createdAt: "2026-11-06T00:00:00Z", messages: [
		{ id: "u", role: "user", text: "Saved question", at: "2026-11-06T00:00:00Z" },
		{ id: "a", role: "assistant", text: "Partial", error: "Provider failed", at: "2026-11-06T00:00:01Z" },
	] };
	const { host, requests } = await mount([thread]);
	await click(host.querySelector('[aria-label="Side question history"]'));
	const entry = [...host.querySelectorAll("nav button")].find(element => element.textContent?.includes("Saved question"))!;
	await click(entry);
	assert.equal(host.querySelectorAll('[role="alert"]').length, 1);
	assert.equal(host.querySelector('[role="alert"]')?.textContent, "The answer failed: Provider failed");
	assert.match(host.textContent!, /Partial/);
	await click(host.querySelector('[data-testid="side-chat-retry"]'));
	const body = requests[0]?.body;
	assert.equal(typeof body?.requestId, "string");
	assert.match(body!.requestId as string, /^\d{13}_[a-f0-9-]{36}$/);
	assert.deepEqual(body, { requestId: body!.requestId, threadId: "side_failed_ui", retry: true });
	assert.match(host.textContent!, /Recovered side answer/);
	assert.doesNotMatch(host.textContent!, /Provider failed/);
});

test("a streamed model failure renders once and stays retryable after refresh", async () => {
	const { host, store } = await mount();
	const key = store.getSnapshot().activeKey!;
	const accepted: SideChatThread = { id: "side_stream_failed", createdAt: "2026-11-06T00:00:00Z", messages: [
		{ id: "u", role: "user", text: "Question", at: "2026-11-06T00:00:00Z" },
	] };
	const failed: SideChatThread = { ...accepted, messages: [...accepted.messages,
		{ id: "a", role: "assistant", text: "Partial answer", error: "Stream provider failed", at: "2026-11-06T00:00:01Z" },
	] };
	globalThis.fetch = (async (_url, init) => init?.method === "POST"
		? new Response([{ type: "thread", thread: accepted }, { type: "done", thread: failed }].map(value => JSON.stringify(value)).join("\n") + "\n")
		: Response.json({ threads: [failed], answering: {} })) as typeof fetch;
	await act(async () => {
		store.setDraft(key, { text: "Question", quotes: [] });
		assert.equal(await store.ask(key), true);
	});
	assert.equal(store.getSnapshot().entries[key]?.error, undefined);
	assert.equal(host.querySelectorAll('[role="alert"]').length, 1);
	assert.equal(host.querySelector('[role="alert"]')?.textContent, "The answer failed: Stream provider failed");
	assert.match(host.textContent!, /Partial answer/);
	assert.ok(host.querySelector('[data-testid="side-chat-retry"]'));
	await act(async () => { await store.refresh(); });
	assert.equal(host.querySelectorAll('[role="alert"]').length, 1);
});

test("refresh preserves a distinct operation error alongside a persisted model failure", async () => {
	const failed: SideChatThread = { id: "side_operation_failed", createdAt: "2026-11-06T00:00:00Z", messages: [
		{ id: "u", role: "user", text: "Question", at: "2026-11-06T00:00:00Z" },
		{ id: "a", role: "assistant", text: "", error: "Provider failed", at: "2026-11-06T00:00:01Z" },
	] };
	const { host, store } = await mount([failed]);
	const fetchSaved = globalThis.fetch;
	globalThis.fetch = (async (url, init) => String(url).endsWith("/stop")
		? Response.json({ error: "Stop could not be sent." }, { status: 503 })
		: fetchSaved(url, init)) as typeof fetch;
	await act(async () => {
		store.setActive(failed.id);
		await store.stop(failed.id);
		await store.refresh();
	});
	assert.deepEqual([...host.querySelectorAll('[role="alert"]')].map(element => element.textContent), [
		"The answer failed: Provider failed",
		"Stop could not be sent.",
	]);
});

test("draft and saved quotes typeset inline and display formulas", async () => {
	const quote: SideChatQuote = {
		text: "Inline $x^2$.\n\n$$\n\\frac{1}{2}\n$$", source: { kind: "message", messageId: "msg_source" },
		segments: [
			{ kind: "text", text: "Inline " },
			{ kind: "math", tex: "x^2", display: false },
			{ kind: "text", text: ".\n\n" },
			{ kind: "math", tex: "\n\\frac{1}{2}\n", display: true },
		],
	};
	const saved: SideChatThread = { id: "side_math", createdAt: "", messages: [
		{ id: "u", role: "user", text: "Explain", quotes: [quote], at: "" },
	] };
	const { host, store } = await mount([saved]);
	await act(async () => { store.addQuote(quote); });
	const assertMath = () => {
		assert.deepEqual([...host.querySelectorAll('annotation[encoding="application/x-tex"]')].map(node => node.textContent), ["x^2", "\n\\frac{1}{2}\n"]);
		assert.ok(host.querySelector(".katex-display"));
		assert.equal(host.querySelector("button .katex"), null, "formula controls must not be nested in a navigation button");
	};
	assertMath();
	await act(async () => { store.setActive(saved.id); });
	assertMath();
});

for (const structured of [false, true]) {
	test(`draft and saved ${structured ? "structured" : "legacy"} quotes preserve literal Markdown, HTML, dollars, and whitespace`, async () => {
		const literal = "**literal** $x$ \\(x\\) <b>literal</b> & `code`\n  # heading\n[link](https://example.com)";
		const quote: SideChatQuote = {
			text: literal, source: { kind: "message", messageId: "msg_source" },
			...(structured ? { segments: [{ kind: "text" as const, text: literal }] } : {}),
		};
		const saved: SideChatThread = { id: `side_literal_${structured}`, createdAt: "", messages: [
			{ id: "u", role: "user", text: "Explain", quotes: [quote], at: "" },
		] };
		const { host, store } = await mount([saved]);
		const assertLiteral = () => {
			const chip = host.querySelector(".line-clamp-3")!;
			assert.equal(chip.textContent, literal);
			assert.equal(chip.querySelector("strong, b, a, code, h1, .katex"), null);
			assert.ok(chip.classList.contains("whitespace-pre-wrap"));
		};
		await act(async () => { store.addQuote(quote); });
		assertLiteral();
		await act(async () => { store.setActive(saved.id); });
		assertLiteral();
	});
}

test("quote removal, draft history, and confirmation-based deletion stay within the panel", async () => {
	const saved: SideChatThread = { id: "side_delete_ui", createdAt: "2026-11-06T00:00:00Z", messages: [{ id: "u", role: "user", text: "Saved to delete", at: "2026-11-06T00:00:00Z" }, { id: "a", role: "assistant", text: "An answer", at: "2026-11-06T00:00:01Z" }] };
	const { host, store, requests } = await mount([saved]);
	await act(async () => { store.addQuote({ text: "Quoted words", source: { kind: "message", messageId: "msg_source" } }); });
	assert.match(host.textContent!, /Quoted words/);
	await click(host.querySelector('[aria-label="Remove quote"]'));
	assert.doesNotMatch(host.textContent!, /Quoted words/);
	await act(async () => { store.setActive(saved.id); });
	await click([...host.querySelectorAll("button")].find(element => element.textContent?.includes("Delete conversation"))!);
	assert.ok(host.querySelector('[role="alertdialog"]'));
	assert.equal(requests.length, 0);
	await key(host.querySelector('[role="alertdialog"]')!, "Escape");
	assert.equal(host.querySelector('[role="alertdialog"]'), null);
	assert.equal(store.getSnapshot().panelOpen, true);
	await click([...host.querySelectorAll("button")].find(element => element.textContent?.includes("Delete conversation"))!);
	await click([...host.querySelectorAll('[role="alertdialog"] button')].find(element => element.textContent === "Delete")!);
	assert.equal(requests.length, 1);
	assert.ok(requests[0]!.url.endsWith("/side_delete_ui"));
	assert.equal(Object.values(store.getSnapshot().entries).some(entry => entry.thread?.id === saved.id), false);
});

for (const first of ["GET", "POST"] as const) {
	test(`${first}-first saving retains composer DOM, focus, selection, and a single history entry`, async () => {
		const { host, store } = await mount();
		const key = store.getSnapshot().activeKey!;
		const input = host.querySelector("textarea")!;
		input.focus();
		let resolvePost!: (response: Response) => void;
		const post = new Promise<Response>((resolve) => { resolvePost = resolve; });
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }));
		let saved!: SideChatThread;
		globalThis.fetch = (async (_url, init) => {
			if (init?.method === "POST") {
				saved = { id: `side_dom_${first}`, creationRequestId: JSON.parse(String(init.body)).requestId, createdAt: "2026-11-06T00:00:00Z", messages: [
					{ id: "dom-u", role: "user", text: "Submitted", at: "2026-11-06T00:00:00Z" },
				] };
				return post;
			}
			return Response.json({ threads: [saved], answering: { [saved.id]: "" } });
		}) as typeof fetch;
		let asking!: Promise<boolean>;
		await act(async () => {
			store.setDraft(key, { text: "Submitted", quotes: [] });
			asking = store.ask(key);
			if (first === "GET") await store.refresh();
			else { resolvePost(response); assert.equal(await asking, true); }
		});
		assert.equal(host.querySelector("textarea"), input);
		assert.equal(document.activeElement, input);
		assert.equal(input.value, "");
		await act(async () => {
			store.setDraft(key, { text: "Next draft", quotes: [] });
			if (first === "GET") { resolvePost(response); assert.equal(await asking, true); }
			else await store.refresh();
			controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: "thread", thread: saved }) + "\n"));
		});
		assert.equal(store.getSnapshot().activeKey, key);
		assert.equal(host.querySelector("textarea"), input);
		assert.equal(document.activeElement, input);
		assert.equal(input.value, "Next draft");
		await act(async () => {
			controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: "done", thread: saved }) + "\n"));
			controller.close();
		});
		await click(host.querySelector('[aria-label="Side question history"]'));
		assert.equal(host.querySelectorAll("nav button").length, 1, "a saved draft must not appear again as a history draft");
		await click(host.querySelector("nav button"));
		assert.equal(store.getSnapshot().activeKey, key);
		assert.equal(host.querySelector("textarea")?.value, "Next draft");
	});
}

test("an externally deleted saved thread remains selectable as a draft without changing its key", async () => {
	const saved: SideChatThread = { id: "side_external_delete", createdAt: "2026-11-06T00:00:00Z", messages: [] };
	const { store, host } = await mount([saved]);
	await act(async () => {
		store.setActive(saved.id);
		store.setDraft(saved.id, { text: "Keep this follow-up", quotes: [] });
	});
	const input = host.querySelector("textarea");
	globalThis.fetch = async () => Response.json({ threads: [], answering: {} });
	await act(async () => { await store.refresh(); });
	assert.equal(store.getSnapshot().activeKey, saved.id);
	assert.equal(host.querySelector("textarea"), input);
	assert.match(host.textContent!, /Discard draft/);
	await click(host.querySelector('[aria-label="Side question history"]'));
	const draft = [...host.querySelectorAll("nav button")].find((element) => element.textContent?.includes("Keep this follow-up"));
	assert.ok(draft);
	assert.match(draft.textContent!, /Draft/);
	await click(draft);
	assert.equal(host.querySelector("textarea")?.value, "Keep this follow-up");
});
