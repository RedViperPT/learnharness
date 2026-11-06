/** Rendering-owned selectable content. Spans distinguish card content from chrome;
 * quote text itself is user-supplied, not reconstructed on the server. */
import type { PluggableList } from "unified";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import { repairMathForDisplay } from "../math-delims.ts";
import { answerForPresentation } from "../answer-presentation.ts";
import { parseAskInput, parseQuizInput } from "../tool-parts.ts";
import type { QuestionAnswerData } from "../question-core.ts";

// Installed in MessageResponse for all Markdown surfaces.
export const presentationRemarkPlugins: PluggableList = [remarkGfm, [remarkMath, { singleDollarTextMath: true }], remarkBreaks];
export const presentationAlertMarker = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i;

export interface SideContentSpan {
	id: string;
	kind: "markdown" | "plain" | "paths";
	content: string;
}
export const markdownSpan = (id: string, content: string, tool = true): SideContentSpan => ({
	id, kind: "markdown", content: tool ? repairMathForDisplay(content) : content,
});
export const plainSpan = (id: string, content: string, paths = false): SideContentSpan => ({ id, kind: paths ? "paths" : "plain", content });

export function questionContent(question: string, details?: string): SideContentSpan[] {
	return [markdownSpan("question", question), ...(details ? [markdownSpan("details", details)] : [])];
}

export function answeredContent(saved: QuestionAnswerData, input: unknown): SideContentSpan[] {
	const answer = answerForPresentation(saved, input);
	if (answer.dismissed) return [plainSpan("question", answer.questionText)];
	const ask = answer.kind === "ask" ? parseAskInput(input) : undefined;
	const details = ask?.details ?? (answer.kind === "quiz" ? parseQuizInput(input)?.details : undefined);
	const descriptions = new Map((ask?.options ?? []).map((option, i) => [i + 1, option.description]));
	return [
		...(answer.readingThinking ? [plainSpan("reading", answer.readingThinking, true)] : []),
		...questionContent(answer.questionText, details),
		...(answer.options ?? []).flatMap(option => [
			markdownSpan(`option:${option.index}`, option.label),
			...(descriptions.get(option.index) ? [markdownSpan(`description:${option.index}`, descriptions.get(option.index)!)] : []),
		]),
		...(answer.other ? [plainSpan("other", `“${answer.other}”`, true)] : []),
		...(answer.text ? [plainSpan("text", `“${answer.text}”`, true)] : []),
		...((answer.thinking ?? answer.note) ? [plainSpan("thinking", answer.thinking ?? answer.note ?? "", true)] : []),
		...(answer.kind === "quiz" && answer.explanation ? [markdownSpan("explanation", answer.explanation)] : []),
		...(answer.kind === "explain" && answer.committed ? [markdownSpan("committed", answer.committed)] : []),
	];
}
