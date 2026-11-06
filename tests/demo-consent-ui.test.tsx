import React, { act } from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { QuestionDock } from "../components/question-dock.tsx";
import { SessionModel } from "../components/session-core.ts";
import { AnsweredCard } from "../components/answered-card.tsx";
import { DemoOutputCard } from "../components/artifacts/demo-card.tsx";
import { ChatActionsContext } from "../components/chat.tsx";
import { buildAnswer, demoOfferQuestion, type QuestionAnswerData } from "../src/core/question-core.ts";
import { newAnswerResult, type LhMessage } from "../src/core/native-messages.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });

for (const [label, value] of [["Build demo", "build"], ["Continue without demo", "skip"]] as const) {
	test(`consent dock submits ${value} without assessment controls and renders compact history`, async () => {
		let answer: QuestionAnswerData | undefined;
		const host = document.createElement("div"); document.body.append(host);
		const root = createRoot(host);
		try {
			await act(async () => root.render(<QuestionDock toolName="offer_demo" toolCallId="consent"
				input={{ title: "Oscillator", description: "Vary damping and see overshoot." }} expanded onExpand={() => {}}
				onSubmit={output => { answer = output; }} />));
			assert.match(host.textContent!, /Oscillator/);
			assert.match(host.textContent!, /Vary damping/);
			assert.equal(host.querySelectorAll("input, textarea, [role=slider]").length, 0);
			assert.doesNotMatch(host.textContent!, /confidence|thinking|Other|don't know/i);
			assert.equal(host.querySelectorAll("button").length, 2);
			const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === label)!;
			await act(async () => button.click());
			assert.equal(answer?.answers[0]?.value, value);
			assert.equal(answer?.kind, "ask");
			await act(async () => root.render(<AnsweredCard answer={answer!} />));
			assert.ok(host.querySelector('[data-testid="answered-demo-consent"]'));
			assert.equal(host.querySelector('[data-testid="answered-card"]'), null);
			assert.match(host.textContent!, value === "build" ? /approved/ : /skipped/);
		} finally { await act(async () => root.unmount()); host.remove(); }
	});
}

for (const [label, value] of [["Build demo", "build"], ["Continue without demo", "skip"]] as const) {
	test(`consent dock retries ${value} after failed recovery without duplicate submission`, async () => {
		const offer = { title: "Oscillator", description: "Vary damping and see overshoot." };
		const question: LhMessage = { ...fauxAssistantMessage([fauxToolCall("offer_demo", offer, { id: "consent" })],
			{ stopReason: "toolUse" }), id: "offer" };
		let record: LhMessage[] = [question];
		let reads = 0;
		let posts = 0;
		const posted: QuestionAnswerData[] = [];
		const model = new SessionModel({ chatId: "chat", initialMessages: record,
			fetch: async (url, options) => {
				if (String(url) === "/api/chat") {
					if (++posts === 1) throw new TypeError("Previous request failed");
					const { input } = JSON.parse(String(options?.body));
					posted.push(input.answer);
					record = [question, newAnswerResult("consent", "offer_demo", input.answer)];
					return Response.json({ ok: true });
				}
				if (String(url).endsWith("/stream")) return new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
				if (++reads === 1) throw new TypeError("Recovery offline");
				return Response.json({ messages: record, turnInFlight: false });
			} });
		await model.submitAnswer("offer_demo", "consent", buildAnswer(demoOfferQuestion("consent", offer), { values: [value] }, "offer_demo"));
		assert.equal(model.status, "error");
		const host = document.createElement("div"); document.body.append(host);
		const root = createRoot(host);
		let submission: Promise<void> | undefined;
		try {
			await act(async () => root.render(<QuestionDock toolName="offer_demo" toolCallId="consent" input={offer}
				expanded onExpand={() => {}} onSubmit={answer => { submission = model.submitAnswer("offer_demo", "consent", answer); }} />));
			const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === label)!;
			await act(async () => { button.click(); await submission; });
			assert.equal(model.status, "error");
			assert.equal(model.getState().error?.message, "Recovery offline");
			assert.equal(posted.length, 0);
			assert.equal(posts, 1, "failed recovery must not POST the answer");
			assert.equal(model.getState().nativeMessages.length, 1);
			await act(async () => {
				button.click();
				const retry = submission;
				button.click();
				await retry;
				await submission;
			});
			assert.equal(posted.length, 1, "the same mounted dock retries, and SessionModel guards rapid clicks");
			assert.equal(posts, 2);
			assert.equal(posted[0]?.answers[0]?.value, value);
			assert.equal(model.status, "ready");
			assert.deepEqual(model.getState().nativeMessages, record);
		} finally { model.stop(); await act(async () => root.unmount()); host.remove(); }
	});
}

test("legacy demos start expanded and persisted collapsed demos render no iframe", () => {
	const output = { title: "Oscillator", html: "<p>Interactive instrument</p>", tested: true };
	assert.match(renderToStaticMarkup(<DemoOutputCard output={output} />), /<iframe/);
	const collapsed = renderToStaticMarkup(<DemoOutputCard output={output} initialCollapsed />);
	assert.doesNotMatch(collapsed, /<iframe/);
	assert.match(collapsed, /Oscillator/);
	assert.match(collapsed, /Show demo/);
});

test("Show mounts, Hide unmounts, and inversion persists independently across collapse", async () => {
	const requests: { url: string; input: Record<string, unknown> }[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (url, options) => {
		requests.push({ url: String(url), input: JSON.parse(String(options?.body)).input });
		return Response.json({ ok: true });
	}) as typeof fetch;
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	const render = (collapsed: boolean) => <ChatActionsContext.Provider value={{ chatId: "chat", syncFromServer: async () => {}, sendText: () => {}, openSetup: () => {} }}>
		<DemoOutputCard output={{ title: "Oscillator", html: "<p>Demo</p>", tested: true }} messageId="steer" initialCollapsed={collapsed} />
	</ChatActionsContext.Provider>;
	try {
		await act(async () => root.render(render(true)));
		assert.equal(host.querySelector("iframe"), null);
		await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Show demo"]')!.click());
		assert.ok(host.querySelector("iframe"));
		const invert = host.querySelector<HTMLButtonElement>('[data-testid="toggle-invert-demo-brightness"]')!;
		assert.ok(invert);
		await act(async () => invert.click());
		assert.match(host.querySelector("iframe")!.getAttribute("style")!, /invert\(1\)/);
		await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Hide demo"]')!.click());
		assert.equal(host.querySelector("iframe"), null);
		await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Show demo"]')!.click());
		assert.match(host.querySelector("iframe")!.getAttribute("style")!, /invert\(1\)/);
		await act(async () => invert.click());
		assert.doesNotMatch(host.querySelector("iframe")!.getAttribute("style")!, /invert\(1\)/);
		assert.deepEqual(requests.map(r => r.input), [
			{ messageId: "steer", collapsed: false }, { messageId: "steer", inverted: true },
			{ messageId: "steer", collapsed: true }, { messageId: "steer", collapsed: false },
			{ messageId: "steer", inverted: false },
		]);
		assert.ok(requests.every(r => r.url === "/api/chats/chat/artifact-ui"));
	} finally {
		await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch;
	}
});
