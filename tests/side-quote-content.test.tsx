import React from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import katex from "katex";
import { SideQuoteContent } from "../components/side-quote-content.tsx";
import { captureSideSelection } from "../components/side-selection-text.ts";
import { parseSideAskInput } from "../src/core/side-chat.ts";
import type { SideChatQuote } from "../src/core/index.ts";

(globalThis as Record<string, unknown>).React = React;

test("renders captured literal code alongside identified math after a JSON/request round trip", () => {
	const literal = "**literal** $x$ \\(y\\) <b> & `code`\n  next line";
	const { document } = parseHTML(`<html><body><div data-side-chat-source='{"kind":"message","messageId":"m1"}'><pre><code></code></pre><p>Math: ${katex.renderToString("x")}</p></div></body></html>`);
	const source = document.querySelector("[data-side-chat-source]")!;
	source.querySelector("code")!.textContent = literal;
	const range = {
		startContainer: source, startOffset: 0, endContainer: source, endOffset: source.childNodes.length,
		cloneRange() { return this; },
		intersectsNode(node: Node) { return source.contains(node); },
	};
	const captured = captureSideSelection({ isCollapsed: false, rangeCount: 1, getRangeAt: () => range } as unknown as Selection);
	assert.ok(captured);
	const parsed = parseSideAskInput(JSON.parse(JSON.stringify({ text: "Explain", quotes: [captured.quote] })));
	assert.ok("quotes" in parsed);
	const markup = renderToStaticMarkup(<SideQuoteContent quote={parsed.quotes[0]!} />);
	const rendered = parseHTML(`<html><body>${markup}</body></html>`).document;
	const literalNodes = Array.from(rendered.querySelector("div")!.childNodes).filter(node => node.nodeType === 3);
	assert.equal(literalNodes.map(node => node.textContent).join(""), `${literal}\nMath: `);
	assert.equal(rendered.querySelector("strong, b, a, code"), null);
	assert.equal(rendered.querySelectorAll(".katex").length, 1, "literal $x$ must not turn into a second formula");
	assert.equal(rendered.querySelector('annotation[encoding="application/x-tex"]')?.textContent, "x");
});

test("typesets only KaTeX output without trusting HTML or links embedded in captured TeX", () => {
	const tex = "\\href{javascript:alert(1)}{x} + \\htmlClass{injected}{y}";
	const quote: SideChatQuote = {
		text: `$${tex}$`, source: { kind: "message", messageId: "m1" },
		segments: [{ kind: "math", tex, display: false }],
	};
	const markup = renderToStaticMarkup(<SideQuoteContent quote={quote} />);
	const rendered = parseHTML(`<html><body>${markup}</body></html>`).document;
	assert.ok(rendered.querySelector(".katex"));
	assert.equal(rendered.querySelector("a, .injected, script"), null);
});

test("invalid TeX remains visible and cannot inject markup through the error fallback", () => {
	const tex = "\\invalid{<img src=x onerror=alert(1)>}";
	const quote: SideChatQuote = {
		text: `$${tex}$`, source: { kind: "message", messageId: "m1" },
		segments: [{ kind: "math", tex, display: false }],
	};
	const markup = renderToStaticMarkup(<SideQuoteContent quote={quote} />);
	const rendered = parseHTML(`<html><body>${markup}</body></html>`).document;
	assert.match(rendered.body.textContent!, /invalid/);
	assert.equal(rendered.querySelector("img, script"), null);
});
