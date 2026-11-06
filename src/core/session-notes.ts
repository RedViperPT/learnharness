import type { SideChatQuote } from "./contracts.ts";

export const NOTES_MAX_BYTES = 512 * 1024;
export const NOTES_SAVE_DELAY_MS = 600;

export function notesByteLength(markdown: string): number {
	return new TextEncoder().encode(markdown).byteLength;
}

/** Captured prose is literal text, not newly authored Markdown or math. */
function escapeQuoteText(text: string): string {
	return text.replace(/[\\`*_\[\]<>#$|]/g, "\\$&");
}

/** Only DOM-identified math becomes TeX. Display delimiters occupy their
 * own lines so the lesson renderer preserves display/inline behavior. */
export function noteQuoteMarkdown(quote: SideChatQuote): string {
	let text = "";
	if (quote.segments) {
		for (const [index, segment] of quote.segments.entries()) {
			if (segment.kind === "text") text += escapeQuoteText(segment.text);
			else if (!segment.display) text += `$${segment.tex}$`;
			else {
				if (text && !text.endsWith("\n\n")) text += text.endsWith("\n") ? "\n" : "\n\n";
				text += `$$\n${segment.tex}\n$$`;
				if (index < quote.segments.length - 1) text += "\n\n";
			}
		}
	} else text = escapeQuoteText(quote.text);
	return text.replace(/\r\n?/g, "\n").split("\n").map((line) => line ? `> ${line}` : ">").join("\n");
}

export type NoteOrganizerEvent =
	| { type: "start"; proposalId: string; baseRevision: number; model: string }
	| { type: "text"; text: string }
	| { type: "done"; text: string }
	| { type: "error"; error: string };
