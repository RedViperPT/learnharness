import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import katex from "katex";
import {
	captureSideSelection,
	decodeSideSource,
	encodeSideSource,
	navigateToSideQuote,
	readSideSource,
} from "../components/side-selection-text.ts";
import { SideSelectionActions, submitSideSelectionAction } from "../components/side-selection.tsx";
import type { SideChatSnapshot, SideChatStore } from "../components/side-chat-state.tsx";
import type { SideChatQuote } from "../src/core/index.ts";

function sourceDocument(markup: string) {
	return parseHTML(`<html><body>${markup}</body></html>`).document;
}

function makeSelection(range: object): Selection {
	return {
		isCollapsed: false,
		rangeCount: 1,
		getRangeAt: () => range,
	} as unknown as Selection;
}

function fakeRange(startContainer: Node, startOffset: number, endContainer: Node, endOffset: number) {
	return {
		startContainer,
		startOffset,
		endContainer,
		endOffset,
		cloneRange() { return this; },
		intersectsNode(node: Node) {
			const startRoot = startContainer.parentElement;
			const endRoot = endContainer.parentElement;
			return node === startContainer || node === endContainer ||
				!!(startRoot && node.contains(startRoot)) || !!(endRoot && node.contains(endRoot)) ||
				!!(startRoot && startRoot.contains(node)) || !!(endRoot && endRoot.contains(node));
		},
	};
}

it("accepts only the supported, well-formed source marker identities", () => {
	const source = { kind: "question" as const, toolCallId: "tool-1" };
	assert.deepEqual(decodeSideSource(encodeSideSource(source)), source);
	assert.equal(decodeSideSource('{"kind":"message","messageId":3}'), null);
	assert.equal(decodeSideSource('{"kind":"answer","id":"secret"}'), null);
});

it("quotes real KaTeX markup atomically, ignoring its hidden visual and MathML descendants", () => {
	const document = sourceDocument(`<div data-side-chat-source='{"kind":"message","messageId":"m1"}'>
		<p>Explain <span class="katex"><span class="katex-html" aria-hidden="true"><span>x+1</span></span><span class="katex-mathml" aria-hidden="true"><math><semantics><annotation encoding="application/x-tex">x+1</annotation></semantics></math></span></span> now.</p>
	</div>`);
	const source = document.querySelector("[data-side-chat-source]")!;
	const result = readSideSource(source);
	assert.equal(result.text, "Explain $x+1$ now.");
	assert.equal(result.chunks.filter((chunk) => chunk.atomic).length, 1);

	const visualText = source.querySelector(".katex-html span")!.firstChild!;
	const range = fakeRange(visualText, 1, visualText, 2);
	const captured = captureSideSelection(makeSelection(range));
	assert.equal(captured?.quote.text, "$x+1$");
	assert.deepEqual(captured?.quote.segments, [{ kind: "math", tex: "x+1", display: false }]);
});

it("retains literal code and DOM-identified math as distinct segments without changing quote offsets", () => {
	const literal = "**literal** $x$ \\(y\\) <b> & `code`";
	const document = sourceDocument(`<div data-side-chat-source='{"kind":"message","messageId":"m1"}'><pre><code></code></pre><p>Then ${katex.renderToString("x^2")}.</p>${katex.renderToString("\\frac{1}{2}", { displayMode: true })}</div>`);
	const source = document.querySelector("[data-side-chat-source]")!;
	source.querySelector("code")!.textContent = literal;
	const captured = captureSideSelection(makeSelection(fakeRange(source as unknown as Node, 0, source as unknown as Node, source.childNodes.length)));
	assert.ok(captured);
	assert.equal(captured.quote.text, `${literal}\nThen $x^2$.\n$$\\frac{1}{2}$$`);
	assert.deepEqual(captured.quote.segments, [
		{ kind: "text", text: `${literal}\nThen ` },
		{ kind: "math", tex: "x^2", display: false },
		{ kind: "text", text: ".\n" },
		{ kind: "math", tex: "\\frac{1}{2}", display: true },
	]);
	assert.deepEqual(captured.quote.selector, { start: 0, end: captured.quote.text.length, prefix: "", suffix: "" });
});

it("captures partial code and inline-code dollar syntax only as literal text", () => {
	for (const tag of ["pre", "p"]) {
		const document = sourceDocument(`<div data-side-chat-source='{"kind":"message","messageId":"m1"}'><${tag}><code>before **literal** $x$ after</code></${tag}></div>`);
		const node = document.querySelector("code")!.firstChild!;
		const captured = captureSideSelection(makeSelection(fakeRange(node, 7, node, 22)));
		assert.equal(captured?.quote.text, "**literal** $x$");
		assert.deepEqual(captured?.quote.segments, [{ kind: "text", text: "**literal** $x$" }]);
	}
});

it("uses stable visible text for multi-paragraph prose and omits copy controls and hidden descendants", () => {
	const document = sourceDocument(`<div data-side-chat-source='{"kind":"message","messageId":"m1"}'>
		<p>First paragraph.</p><p>Second <em>paragraph</em>.</p>
		<div><pre><code>const x = 1;</code><button aria-label="Copy code">Copy</button></pre></div>
		<span hidden>hidden attribute</span><span style="display:none">display hidden</span>
	</div>`);
	const source = document.querySelector("[data-side-chat-source]")!;
	const view = document.defaultView as unknown as { getComputedStyle(element: Element): { display: string; visibility: string; userSelect: string } };
	view.getComputedStyle = (element) => ({
		display: (element as HTMLElement).style?.display ?? "block",
		visibility: (element as HTMLElement).style?.visibility ?? "visible",
		userSelect: "auto",
	});
	const result = readSideSource(source);
	assert.match(result.text, /^First paragraph\.\nSecond paragraph\./);
	assert.match(result.text, /const x = 1;/);
	assert.doesNotMatch(result.text, /Copy|hidden attribute|display hidden/);

	const first = source.querySelector("p")!.firstChild!;
	const second = source.querySelectorAll("p")[1]!.querySelector("em")!.firstChild!;
	const paragraphQuote = captureSideSelection(makeSelection(fakeRange(first, 0, second, 9)));
	assert.equal(paragraphQuote?.quote.text, "First paragraph.\nSecond paragraph");
	const code = source.querySelector("code")!.firstChild!;
	const codeQuote = captureSideSelection(makeSelection(fakeRange(code, 0, code, (code as Text).data.length)));
	assert.equal(codeQuote?.quote.text, "const x = 1;");
});

it("rejects selections crossing sources, through controls, or through hidden content", () => {
	const document = sourceDocument(`
		<div data-side-chat-source='{"kind":"message","messageId":"m1"}'>teacher <button>copy</button> words <span style="display:none">secret</span></div>
		<div data-side-chat-source='{"kind":"message","messageId":"m2"}'>other source</div>
	`);
	const sources = Array.from(document.querySelectorAll("[data-side-chat-source]"));
	const first = sources[0]!;
	const second = sources[1]!;
	const teacher = first.firstChild!;
	const other = second.firstChild!;
	const copyButton = first.querySelector("button")!;
	const hidden = first.querySelector("[style]")!;

	assert.equal(captureSideSelection(makeSelection(fakeRange(teacher, 0, other, 5))), null);
	assert.equal(captureSideSelection(makeSelection(fakeRange(teacher, 0, copyButton.firstChild!, 4))), null);
	assert.equal(captureSideSelection(makeSelection(fakeRange(teacher, 0, hidden.firstChild!, 3))), null);
});

it("allows a same-message selection across separately marked text parts but rejects another message", () => {
	const document = sourceDocument(`
		<div data-side-chat-source='{"kind":"message","messageId":"m1"}'>first part</div>
		<div data-side-chat-source='{"kind":"message","messageId":"m1"}'>second part</div>
		<div data-side-chat-source='{"kind":"message","messageId":"m2"}'>different message</div>
	`);
	const sources = Array.from(document.querySelectorAll("[data-side-chat-source]"));
	const first = sources[0]!;
	const second = sources[1]!;
	const third = sources[2]!;
	const allowed = new Set([first, second]);
	const range = fakeRange(first.firstChild!, 0, second.firstChild!, 11);
	const captured = captureSideSelection(makeSelection(range), null, allowed);
	assert.equal(captured?.quote.text, "first part\nsecond part");
	assert.equal(captureSideSelection(makeSelection(fakeRange(first.firstChild!, 0, third.firstChild!, 8)), null, allowed), null);
});

it("renders Ask alone without an active thread and both actions when a thread is active", () => {
	const labels = (active: boolean) => renderToStaticMarkup(
		<SideSelectionActions active={active} onAction={() => {}} />,
	);
	assert.match(labels(false), />Ask privately</);
	assert.doesNotMatch(labels(false), /New question|Add to current thread/);
	const active = labels(true);
	assert.match(active, /New question/);
	assert.match(active, /Add to current thread/);
});

it("keeps rejected quotes available to the caller instead of treating refusal as success", () => {
	const quote: SideChatQuote = {
		text: "quoted text",
		source: { kind: "message", messageId: "m1" },
	};
	let opened: SideChatQuote | undefined;
	const store = {
		openNew: (value?: SideChatQuote) => { opened = value; },
		addQuote: () => {},
		getSnapshot: () => ({
			panelOpen: true,
			activeKey: "draft:1",
			entries: { "draft:1": { draft: { text: "", quotes: [] }, sending: false } },
			validationError: "Quotes must be 8,000 characters or fewer.",
			focusRevision: 0,
		}),
	} as unknown as SideChatStore;
	assert.equal(submitSideSelectionAction(store, "ask", quote), false);
	assert.equal(opened, quote);
});

it("offers Add to notes beside private questions without changing active-thread actions", () => {
	for (const active of [false, true]) {
		const markup = renderToStaticMarkup(<SideSelectionActions active={active} onAction={() => {}} onAddToNotes={() => {}} />);
		assert.match(markup, /Add to notes/);
		assert.equal((markup.match(/<button/g) ?? []).length, active ? 3 : 2);
		if (!active) assert(markup.indexOf("Ask privately") < markup.indexOf("Add to notes"));
	}
});

it("dispatches New question and Add to current thread to their distinct store methods", () => {
	const quote: SideChatQuote = {
		text: "quoted text",
		source: { kind: "message", messageId: "m1" },
	};
	let snapshot: SideChatSnapshot = {
		panelOpen: true,
		activeKey: "draft:1",
		entries: { "draft:1": { draft: { text: "", quotes: [] }, sending: false } },
		validationError: "",
		focusRevision: 0,
	};
	let opened = 0;
	let added = 0;
	const store = {
		openNew: (value?: SideChatQuote) => {
			opened++;
			snapshot = { ...snapshot, activeKey: "draft:2", entries: { ...snapshot.entries, "draft:2": { draft: { text: "", quotes: value ? [value] : [] }, sending: false } } };
		},
		addQuote: (value: SideChatQuote) => {
			added++;
			const activeKey = snapshot.activeKey!;
			const entry = snapshot.entries[activeKey]!;
			const current = entry.draft!;
			snapshot = { ...snapshot, entries: { ...snapshot.entries, [activeKey]: { ...entry, draft: { ...current, quotes: [...current.quotes, value] } } } };
		},
		getSnapshot: () => snapshot as unknown as ReturnType<SideChatStore["getSnapshot"]>,
	} as unknown as SideChatStore;

	assert.equal(submitSideSelectionAction(store, "new", quote), true);
	assert.equal(opened, 1);
	assert.equal(added, 0);
	assert.equal(submitSideSelectionAction(store, "add", quote), true);
	assert.equal(opened, 1);
	assert.equal(added, 1);
});

it("relocates by selector context, handles an atomic formula endpoint, and refuses ambiguity", () => {
	const document = sourceDocument(`
		<div data-side-chat-source='{"kind":"problem","toolCallId":"p1"}'>start target middle target end</div>
		<div data-side-chat-source='{"kind":"question","toolCallId":"q1"}'>before <span class="katex"><span class="katex-html" aria-hidden="true">x</span><span class="katex-mathml" aria-hidden="true"><math><semantics><annotation encoding="application/x-tex">x</annotation></semantics></math></span></span> after</div>
	`);
	const [problem, question] = Array.from(document.querySelectorAll("[data-side-chat-source]"));
	let startOffset = -1;
	let endAfter: Node | null = null;
	let selected = 0;
	(problem as Element & { scrollIntoView: () => void }).scrollIntoView = () => {};
	(question as Element & { scrollIntoView: () => void }).scrollIntoView = () => {};
	(document as unknown as { createRange: () => object }).createRange = () => ({
		setStart: (_node: Node, offset: number) => { startOffset = offset; },
		setEnd: () => {},
		setStartBefore: () => {},
		setEndAfter: (node: Node) => { endAfter = node; },
	});
	const oldDocument = globalThis.document;
	const oldWindow = globalThis.window;
	Object.defineProperty(globalThis, "document", { configurable: true, value: document });
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { getSelection: () => ({ removeAllRanges: () => {}, addRange: () => { selected++; } }) },
	});
	try {
		const relocated: SideChatQuote = {
			text: "target",
			source: { kind: "problem", toolCallId: "p1" },
			selector: { start: 0, end: 6, prefix: "middle ", suffix: " end" },
		};
		assert.equal(navigateToSideQuote(relocated), true);
		assert.equal(startOffset, 20);
		const formula: SideChatQuote = {
			text: "$x$",
			source: { kind: "question", toolCallId: "q1" },
			selector: { start: 7, end: 10, prefix: "before ", suffix: " after" },
		};
		assert.equal(navigateToSideQuote(formula), true);
		assert.equal(endAfter, question!.querySelector(".katex"));
		assert.equal(selected, 2);
		// Older display-formula quotes used single dollars; new ones retain display math.
		const formulaNode = question!.querySelector(".katex")!;
		const display = document.createElement("span");
		display.className = "katex-display";
		formulaNode.replaceWith(display);
		display.appendChild(formulaNode);
		assert.equal(navigateToSideQuote({ text: "$$x$$", source: formula.source }), true);
		assert.equal(navigateToSideQuote({ text: "$x$", source: formula.source }), true);
		// A saved selector can still include the pre-content-only card label.
		const legacySource = document.createElement("div");
		legacySource.setAttribute("data-side-chat-source", '{"kind":"question","toolCallId":"legacy"}');
		legacySource.innerHTML = '<span>Check</span><div data-side-content="question"><p>Saved passage.</p></div>';
		(legacySource as Element & { scrollIntoView: () => void }).scrollIntoView = () => {};
		document.body.appendChild(legacySource);
		assert.equal(navigateToSideQuote({ text: "Saved passage.", source: { kind: "question", toolCallId: "legacy" },
			selector: { start: 6, end: 20, prefix: "Check\n", suffix: "" } }), true);

		const duplicate = problem!.cloneNode(true) as Element;
		problem!.parentElement!.appendChild(duplicate);
		assert.equal(navigateToSideQuote(relocated), false);
	} finally {
		Object.defineProperty(globalThis, "document", { configurable: true, value: oldDocument });
		Object.defineProperty(globalThis, "window", { configurable: true, value: oldWindow });
	}
});
