import { sideQuoteSegmentText, type SideChatQuote, type SideChatQuoteSegment, type SideChatSource } from "@/src/core";

export const SIDE_SOURCE_ATTRIBUTE = "data-side-chat-source";
// Streamdown's safe links are buttons, but their labels are prose. Keep
// confirmation behavior intact while treating only the label as selectable.
const EXCLUDED = "button:not([data-streamdown=link]),input,textarea,select,[role=button]:not([data-streamdown=link]),[contenteditable],[hidden],[aria-hidden=true],script,style,template,noscript,svg";
const TEX_ANNOTATION = 'annotation[encoding="application/x-tex"]';
const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DL|DT|FIGURE|FIGCAPTION|FOOTER|H[1-6]|HEADER|LI|OL|P|PRE|SECTION|TABLE|TD|TH|TR|UL)$/;

/**
 * Quote text is canonical visible DOM text: block boundaries become `\n`,
 * excluded controls and hidden markup are omitted, and each KaTeX formula is
 * one atomic `$TeX$` or `$$TeX$$` chunk (never both rendered HTML and MathML).
 */
export function encodeSideSource(source: SideChatSource): string {
	return JSON.stringify(source);
}

export function decodeSideSource(raw: string | null): SideChatSource | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as SideChatSource;
		if (value.kind === "message" && typeof value.messageId === "string") return value;
		if ((value.kind === "question" || value.kind === "problem") && typeof value.toolCallId === "string") return value;
	} catch {
		// Malformed or unsupported marker.
	}
	return null;
}

export interface SideTextChunk {
	node: Node;
	start: number;
	end: number;
	atomic?: boolean;
	math?: Extract<SideChatQuoteSegment, { kind: "math" }>;
}

function isInvisible(element: Element): boolean {
	if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return true;
	const view = element.ownerDocument.defaultView;
	const style = view && typeof view.getComputedStyle === "function" ? view.getComputedStyle(element) : null;
	return style?.display === "none" || style?.visibility === "hidden" || style?.userSelect === "none";
}

function insideFormula(element: Element): boolean {
	return element.closest(".katex") !== null;
}

function isBlockElement(element: Element): boolean {
	return BLOCK.test(element.tagName) || element.classList.contains("katex-display");
}

function isMarkupIndentation(node: Text): boolean {
	if (/\S/.test(node.data)) return false;
	const parent = node.parentElement;
	if (!parent) return false;
	return [node.previousSibling, node.nextSibling].some((sibling) =>
		sibling?.nodeType === 1 && isBlockElement(sibling as Element),
	);
}

function readSideSources(roots: readonly Element[], legacy = false): { text: string; chunks: SideTextChunk[] } {
	let text = "";
	const chunks: SideTextChunk[] = [];
	let pendingBreak = false;
	let contentOnly = false;

	const add = (node: Node, value: string, math?: SideTextChunk["math"]) => {
		if (!value) return;
		if (pendingBreak && text) text += "\n";
		pendingBreak = false;
		chunks.push({ node, start: text.length, end: text.length + value.length, ...(math ? { atomic: true, math } : {}) });
		text += value;
	};

	const visit = (node: Node) => {
		if (node.nodeType === 3) {
			const textNode = node as Text;
			if (contentOnly && !textNode.parentElement?.closest("[data-side-content]")) return;
			if (!isMarkupIndentation(textNode)) add(node, textNode.data);
			return;
		}
		if (node.nodeType !== 1) return;
		const element = node as Element;
		if (contentOnly && !element.closest("[data-side-content]") && !element.querySelector("[data-side-content]")) return;
		// KaTeX has hidden visual/MathML descendants by design. Read its TeX
		// annotation once and do not descend into either rendering tree.
		if (element.matches(".katex")) {
			const tex = element.querySelector(TEX_ANNOTATION)?.textContent;
			if (tex) {
				const math: SideTextChunk["math"] = { kind: "math", tex, display: !legacy && element.closest(".katex-display") !== null };
				add(element, sideQuoteSegmentText(math), math);
			}
			return;
		}
		if (element.matches(EXCLUDED) || isInvisible(element)) return;

		const block = isBlockElement(element) || (!legacy && element.hasAttribute("data-side-content"));
		if (block || element.tagName === "BR") pendingBreak = true;
		if (element.tagName !== "BR") {
			for (const child of Array.from(element.childNodes)) visit(child);
		}
		if (block) pendingBreak = true;
	};

	for (const root of roots) {
		contentOnly = !legacy && (root.hasAttribute("data-side-content") || root.querySelector("[data-side-content]") !== null);
		if (text) pendingBreak = true;
		visit(root);
	}
	return { text, chunks };
}

export function readSideSource(root: Element): { text: string; chunks: SideTextChunk[] } {
	return readSideSources([root]);
}

function pointOffset(chunks: SideTextChunk[], node: Node, offset: number, side: "start" | "end"): number | null {
	for (const chunk of chunks) {
		if (chunk.atomic && (chunk.node === node || chunk.node.contains(node))) {
			return side === "start" ? chunk.start : chunk.end;
		}
		if (!chunk.atomic && chunk.node === node) {
			return chunk.start + Math.min(Math.max(offset, 0), chunk.end - chunk.start);
		}
	}

	if (node.nodeType === 1) {
		const children = node.childNodes;
		if (side === "start") {
			for (let index = Math.min(offset, children.length); index < children.length; index++) {
				const child = children[index]!;
				const chunk = chunks.find((item) => child === item.node || child.contains(item.node));
				if (chunk) return chunk.start;
			}
		} else {
			for (let index = Math.min(offset, children.length) - 1; index >= 0; index--) {
				const child = children[index]!;
				const chunk = [...chunks].reverse().find((item) => child === item.node || child.contains(item.node));
				if (chunk) return chunk.end;
			}
		}
	}
	return null;
}

export interface CapturedSideSelection {
	quote: SideChatQuote;
	range: Range;
	element: Element;
}

function sameSource(left: SideChatSource, right: SideChatSource): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "message" && right.kind === "message") return left.messageId === right.messageId;
	return left.kind !== "message" && right.kind !== "message" && left.toolCallId === right.toolCallId;
}

function sourceElementsWithinRange(root: Element, source: SideChatSource, range: Range, allowedSources?: ReadonlySet<Element>): Element[] {
	return Array.from(root.querySelectorAll(`[${SIDE_SOURCE_ATTRIBUTE}]`)).filter((element) => {
		const candidate = decodeSideSource(element.getAttribute(SIDE_SOURCE_ATTRIBUTE));
		return candidate !== null && sameSource(candidate, source) && range.intersectsNode(element) &&
			(!allowedSources || allowedSources.has(element));
	});
}

export function captureSideSelection(
	selection: Selection | null,
	allowedRoot?: Element | null,
	allowedSources?: ReadonlySet<Element>,
): CapturedSideSelection | null {
	if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
	const range = selection.getRangeAt(0).cloneRange();
	const startElement = range.startContainer.nodeType === 1
		? range.startContainer as Element
		: range.startContainer.parentElement;
	const sourceElement = startElement?.closest(`[${SIDE_SOURCE_ATTRIBUTE}]`);
	if (!sourceElement || (allowedRoot && !allowedRoot.contains(sourceElement))) return null;
	const source = decodeSideSource(sourceElement.getAttribute(SIDE_SOURCE_ATTRIBUTE));
	if (!source) return null;

	const endElement = range.endContainer.nodeType === 1
		? range.endContainer as Element
		: range.endContainer.parentElement;
	const endSourceElement = endElement?.closest(`[${SIDE_SOURCE_ATTRIBUTE}]`);
	const endSource = decodeSideSource(endSourceElement?.getAttribute(SIDE_SOURCE_ATTRIBUTE) ?? null);
	if (!endSourceElement || !endSource || !sameSource(source, endSource) ||
		(allowedRoot && !allowedRoot.contains(endSourceElement))) return null;
	// Content-only cards must never turn a status label into a quote. Sources
	// without spans retain the legacy reader/navigation fallback.
	if ((sourceElement.querySelector("[data-side-content]") && !startElement?.closest("[data-side-content]")) ||
		(endSourceElement.querySelector("[data-side-content]") && !endElement?.closest("[data-side-content]"))) return null;

	const markerRoot = allowedRoot ?? sourceElement.ownerDocument.documentElement;
	if (allowedSources && (!allowedSources.has(sourceElement) || !allowedSources.has(endSourceElement))) return null;
	const sources = sourceElementsWithinRange(markerRoot, source, range, allowedSources);
	if (!sources.includes(sourceElement) || !sources.includes(endSourceElement)) return null;
	const crossedOtherSource = Array.from(markerRoot.querySelectorAll(`[${SIDE_SOURCE_ATTRIBUTE}]`)).some((element) => {
		if (!range.intersectsNode(element)) return false;
		const candidate = decodeSideSource(element.getAttribute(SIDE_SOURCE_ATTRIBUTE));
		return candidate === null || !sameSource(candidate, source);
	});
	if (crossedOtherSource) return null;

	for (const element of sources) {
		for (const descendant of Array.from(element.querySelectorAll("*"))) {
			// Internal KaTeX children are covered by the atomic `.katex` element.
			if (insideFormula(descendant)) continue;
			if ((descendant.matches(EXCLUDED) || isInvisible(descendant)) && range.intersectsNode(descendant)) return null;
		}
	}
	for (let ancestor: Element | null = sourceElement; ancestor; ancestor = ancestor.parentElement) {
		if (isInvisible(ancestor)) return null;
	}

	for (let ancestor: Element | null = endSourceElement; ancestor && ancestor !== sourceElement; ancestor = ancestor.parentElement) {
		if (isInvisible(ancestor)) return null;
	}
	const { text, chunks } = readSideSources(sources);
	const start = pointOffset(chunks, range.startContainer, range.startOffset, "start");
	const end = pointOffset(chunks, range.endContainer, range.endOffset, "end");
	if (start === null || end === null || end <= start) return null;
	const quoteText = text.slice(start, end);
	if (!quoteText.trim()) return null;
	// Preserve the DOM's math identity before flattening loses the distinction
	// between a real formula and literal dollar/Markdown syntax in code/prose.
	const segments: SideChatQuoteSegment[] = [];
	let cursor = start;
	for (const chunk of chunks) {
		if (!chunk.math || chunk.start < start || chunk.end > end) continue;
		if (cursor < chunk.start) segments.push({ kind: "text", text: text.slice(cursor, chunk.start) });
		segments.push(chunk.math);
		cursor = chunk.end;
	}
	if (cursor < end) segments.push({ kind: "text", text: text.slice(cursor, end) });
	return {
		quote: {
			text: quoteText,
			segments,
			source,
			selector: {
				start,
				end,
				prefix: text.slice(Math.max(0, start - 32), start),
				suffix: text.slice(end, end + 32),
			},
		},
		range,
		element: sourceElement,
	};
}

function selectorMatches(text: string, quote: SideChatQuote, start: number, end: number): boolean {
	if (text.slice(start, end) !== quote.text) return false;
	const selector = quote.selector;
	if (!selector) return true;
	const prefix = text.slice(Math.max(0, start - selector.prefix.length), start);
	const suffix = text.slice(end, end + selector.suffix.length);
	return prefix === selector.prefix && suffix === selector.suffix;
}

export function navigateToSideQuote(quote: SideChatQuote): boolean {
	if (typeof document === "undefined") return false;
	const matchingSources = Array.from(document.querySelectorAll(`[${SIDE_SOURCE_ATTRIBUTE}]`)).filter((element) => {
		const source = decodeSideSource(element.getAttribute(SIDE_SOURCE_ATTRIBUTE));
		return source !== null && sameSource(source, quote.source);
	});
	const candidates: { element: Element; chunks: SideTextChunk[]; start: number; end: number }[] = [];

	// Old stored selectors included card chrome. Try their original text layout
	// only if the content-only projection cannot resolve them; never choose an
	// arbitrary candidate when either projection is ambiguous.
	for (const legacy of [false, true]) {
		if (!matchingSources.length) break;
		const { text, chunks } = readSideSources(matchingSources, legacy);
		const selector = quote.selector;
		if (selector && selectorMatches(text, quote, selector.start, selector.end)) {
			candidates.push({ element: matchingSources[0]!, chunks, start: selector.start, end: selector.end });
		} else {
			let index = -1;
			while ((index = text.indexOf(quote.text, index + 1)) !== -1) {
				const end = index + quote.text.length;
				if (selectorMatches(text, quote, index, end)) candidates.push({ element: matchingSources[0]!, chunks, start: index, end });
			}
		}
		if (candidates.length) break;
	}

	// Ambiguous exact matches are unresolved; never jump to the first match.
	if (candidates.length !== 1) return false;
	const { element, chunks, start, end } = candidates[0]!;
	const first = chunks.find((chunk) => start >= chunk.start && start < chunk.end);
	const last = [...chunks].reverse().find((chunk) => end > chunk.start && end <= chunk.end);
	if (!first || !last) return false;

	const range = document.createRange();
	if (first.atomic) range.setStartBefore(first.node);
	else range.setStart(first.node, start - first.start);
	if (last.atomic) range.setEndAfter(last.node);
	else range.setEnd(last.node, end - last.start);

	const startElement = first.node.nodeType === 1 ? first.node as Element : first.node.parentElement;
	(startElement?.closest(`[${SIDE_SOURCE_ATTRIBUTE}]`) ?? element).scrollIntoView({ behavior: "smooth", block: "center" });
	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
	return true;
}
