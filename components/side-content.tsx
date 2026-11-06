import type { SideContentSpan } from "@/src/core";
import { MessageResponse } from "@/components/ai-elements/message";
import { PathText } from "@/components/file-path-chip";

/** A semantic boundary, not a visual box. Chrome lives outside these spans. */
export function SideContent({ span, className }: { span: SideContentSpan; className?: string }) {
	return <div data-side-content={span.id} className="contents">
		{span.kind === "markdown" ? <MessageResponse className={className}>{span.content}</MessageResponse>
			: span.kind === "paths" ? <PathText text={span.content} /> : span.content}
	</div>;
}
