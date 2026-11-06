import katex from "katex";
import type { SideChatQuote } from "@/src/core";

/** Never reinterpret DOM-extracted text as Markdown. Only math identified at
 * capture time is typeset; legacy quotes without that identity stay literal. */
export function SideQuoteContent({ quote }: { quote: SideChatQuote }) {
	return <div className="line-clamp-3 whitespace-pre-wrap break-words font-prose text-sm">
		{quote.segments ? quote.segments.map((segment, index) => segment.kind === "text" ? segment.text : (
			<span key={index} className="whitespace-normal"
				// Only KaTeX-generated markup, never captured DOM HTML. Untrusted
				// TeX cannot opt into HTML, links, or shared macro definitions.
				dangerouslySetInnerHTML={{ __html: katex.renderToString(segment.tex, {
					displayMode: segment.display,
					throwOnError: false,
					trust: false,
				}) }} />
		)) : quote.text}
	</div>;
}
