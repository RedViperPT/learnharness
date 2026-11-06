import React from "react";
import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { markdownSpan, type ChatRecord, type QuestionAnswerData } from "../src/core/index.ts";
import { validSideQuote } from "../src/core/side-chat.ts";
import { SideContent } from "../components/side-content.tsx";
import { AnsweredCard } from "../components/answered-card.tsx";
import { captureSideSelection, readSideSource } from "../components/side-selection-text.ts";

(globalThis as Record<string, unknown>).React = React;
const message = (content: unknown[]) => ({
	...fauxAssistantMessage("fixture"), id: "m1", stopReason: "stop", content,
});
function record(messages: unknown[]): ChatRecord {
	return { id: "fixture", title: "Fixture", createdAt: "", updatedAt: "", messages } as ChatRecord;
}
function root(markup: string, source: object) {
	const document = parseHTML(`<html><body><div data-side-chat-source='${JSON.stringify(source)}'>${markup}</div></body></html>`).document;
	// Linkedom does not apply CSS; mirror the existing globals.css rule.
	(document.defaultView as unknown as { getComputedStyle(element: Element): object }).getComputedStyle = element => ({
		display: element.matches('[data-streamdown="code-block-header"]') ? "none" : "block", visibility: "visible", userSelect: "auto",
	});
	return document.querySelector("[data-side-chat-source]")!;
}
// Linkedom has no browser Range implementation. Use document-order intervals
// with the same node intersections as a Range, rather than stubbing capture.
function capture(element: Element, first: Node, last: Node) {
	const nodes: Node[] = [];
	const walk = (node: Node) => { nodes.push(node); for (const child of Array.from(node.childNodes)) walk(child); };
	walk(element);
	const start = nodes.indexOf(first), end = nodes.indexOf(last);
	const range = {
		startContainer: first, startOffset: 0, endContainer: last, endOffset: last.textContent!.length,
		cloneRange() { return this; },
		intersectsNode(node: Node) { return nodes.some((candidate, i) => i >= start && i <= end && (candidate === node || node.contains(candidate))); },
	};
	return captureSideSelection({ isCollapsed: false, rangeCount: 1, getRangeAt: () => range } as unknown as Selection);
}

it("renders, captures, and validates GFM tables, deletion, code, entities, and tool math through shared spans", () => {
	for (const md of ["| Alpha | Beta |\n|---|---|\n| One | Two |", "This is ~~obsolete~~ now.", "A **bold** &amp; `literal **code** $x$`.", String.raw`A $x_1$ and \(y^2\).`, "> [!IMPORTANT]\n> A **key** idea.", "[Visible link](https://hidden.example/path)\nNext line.", "```text\nconst x = 1;\n```", "First paragraph.\n\nSecond paragraph."]) {
		const span = markdownSpan("text", md, false);
		const element = root(renderToStaticMarkup(<SideContent span={span} />), { kind: "message", messageId: "m1" });
		const { text, chunks } = readSideSource(element);
		assert.ok(text.trim(), md);
		const substantive = chunks.filter(chunk => /\S/.test(text.slice(chunk.start, chunk.end)));
		const first = substantive[0]!, last = substantive.at(-1)!;
		// Formula boundaries are atomic in the capture reader.
		const quote = capture(element, first.node, last.node)?.quote;
		assert.ok(quote, md);
		assert.equal(validSideQuote(record([message([{ type: "text", text: md }])]), quote), true, md);
	}
});

it("shares answered-card fields/order, including descriptions, adjacent options and smart-quoted learner text", () => {
	const input = { question: "Choose?", options: [{ label: "First method", value: "first", description: "Visible **annotation**." }, { label: "Second method", value: "second" }] };
	const answer: QuestionAnswerData = { kind: "ask", questionText: "Choose?", options: [{ index: 1, label: "First method" }, { index: 2, label: "Second method" }], answers: [{ index: 1, label: "First method", value: "first" }], other: "custom choice", text: "my answer", dontKnow: false, answeredAt: "" };
	const source = { kind: "question", toolCallId: "q1" };
	const element = root(renderToStaticMarkup(<AnsweredCard answer={answer} input={input} />), source);
	const saved = record([message([{ type: "toolCall", id: "q1", name: "ask_user_question", arguments: input }]), {
		role: "toolResult", id: "r1", toolCallId: "q1", toolName: "ask_user_question", details: answer, content: [], isError: false, timestamp: 0,
	}]);
	const { text, chunks } = readSideSource(element);
	assert.match(text, /Visible annotation\./);
	assert.doesNotMatch(text, /chosen by|Question\n/);
	const quote = capture(element, chunks[0]!.node, chunks.at(-1)!.node)?.quote;
	assert.ok(quote);
	assert.equal(validSideQuote(saved, quote), true);
	for (const selected of ["Visible annotation.", "First method\nVisible annotation.\nSecond method", "“custom choice”", "“my answer”"]) {
		assert.equal(validSideQuote(saved, { text: selected, source: { kind: "question", toolCallId: "q1" } }), true, selected);
	}
	const label = element.querySelector("[data-testid=answered-card]")!.firstElementChild!.firstChild!;
	assert.equal(capture(element, label, label), null, "status labels are not selectable content");
});

it("captures repaired problem math without including the hidden solution or card label", () => {
	const statement = String.raw`Interpret $\\nabla f$.`;
	const span = markdownSpan("statement", statement);
	const element = root(`Problem${renderToStaticMarkup(<SideContent span={span} />)}`, { kind: "problem", toolCallId: "p1" });
	const { text, chunks } = readSideSource(element);
	assert.match(text, /Interpret \$\\nabla f\$/);
	assert.doesNotMatch(text, /Problem/);
	const quote = capture(element, chunks[0]!.node, chunks.at(-1)!.node)?.quote;
	assert.ok(quote);
	const saved = record([message([{ type: "toolCall", id: "p1", name: "problem", arguments: { statement, modelSolution: "SECRET-SOLUTION" } }]), {
		role: "toolResult", id: "r1", toolCallId: "p1", toolName: "problem", details: null, content: [], isError: false, timestamp: 0,
	}]);
	assert.equal(validSideQuote(saved, quote), true);
	// Quote text is user input; the selected source alone is verified.
	assert.equal(validSideQuote(saved, { ...quote, text: "My paraphrase" }), true);
});

it("keeps file-chip labels and revealed explain answers in the rendering model, not raw path metadata", () => {
	const answer: QuestionAnswerData = { kind: "explain", questionText: "Explain?", answers: [], dontKnow: false, answeredAt: "",
		text: "See `/home/learner/notes.txt`.", committed: "A **revealed** answer.", readingThinking: "Reading thoughts." };
	const element = root(renderToStaticMarkup(<AnsweredCard answer={answer} />), { kind: "question", toolCallId: "q1" });
	const { text } = readSideSource(element);
	assert.match(text, /“See notes\.txt\.”/);
	assert.doesNotMatch(text, /The answer:|\/home\/learner/);
});

it("accepts visible HTML selections without reconstructing Markdown on the server", () => {
	const md = "<div>Visible HTML content</div>";
	const element = root(renderToStaticMarkup(<SideContent span={markdownSpan("text", md, false)} />), { kind: "message", messageId: "m1" });
	const { text, chunks } = readSideSource(element);
	assert.equal(text, "Visible HTML content");
	const quote = capture(element, chunks[0]!.node, chunks.at(-1)!.node)?.quote;
	assert.ok(quote);
	assert.equal(validSideQuote(record([message([{ type: "text", text: md }])]), quote), true);
});

it("captures inline and display formulas as atomic TeX quotes", () => {
	const md = "Inline $x^2$.\n\n$$\n\\frac{1}{2}\n$$";
	const element = root(renderToStaticMarkup(<SideContent span={markdownSpan("text", md, false)} />), { kind: "message", messageId: "m1" });
	const { text, chunks } = readSideSource(element);
	assert.match(text, /\$x\^2\$/);
	assert.match(text, /\$\$\\frac\{1\}\{2\}\$\$/);
	assert.equal(chunks.filter(chunk => chunk.atomic).length, 2);
	for (const chunk of chunks.filter(chunk => chunk.atomic)) {
		const quote = capture(element, chunk.node, chunk.node)?.quote;
		assert.ok(quote);
		assert.equal(quote.text, text.slice(chunk.start, chunk.end));
	}
});
