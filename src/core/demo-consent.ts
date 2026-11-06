import type { LhMessage } from "./native-messages.ts";
import type { QuestionAnswerData } from "./question-core.ts";
import { parseDemoOfferInput } from "./tool-parts.ts";

/** Resolve only a native, successful learner decision; prose never grants permission. */
export function approvedDemoTitle(messages: readonly LhMessage[], consentCallId: string): string {
	const missing = () => new Error(`No approved demo offer exists for consentCallId "${consentCallId}"`);
	let title: string | undefined;
	let approved = false;
	let declined = false;
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const call of message.content) {
				if (call.type !== "toolCall" || call.id !== consentCallId) continue;
				// Reused ids cannot inherit a prior occurrence's authority.
				title = undefined;
				approved = declined = false;
				if (call.name !== "offer_demo" || call.argumentsError ||
					["error", "aborted", "pending", "length"].includes(message.stopReason)) continue;
				title = parseDemoOfferInput(call.arguments)?.title;
			}
		}
		if (message.role !== "toolResult" || message.toolCallId !== consentCallId || !title) continue;
		approved = declined = false;
		if (message.toolName !== "offer_demo" || message.isError) continue;
		const answer = message.details as QuestionAnswerData | undefined;
		if (!answer || answer.kind !== "ask" || answer.dismissed || answer.dontKnow ||
			!Array.isArray(answer.answers) || answer.answers.length !== 1 || answer.text || answer.other) continue;
		approved = answer.answers[0]?.value === "build";
		declined = answer.answers[0]?.value === "skip";
	}
	if (declined) throw new Error("The learner declined this demo.");
	if (!title || !approved) throw missing();
	return title;
}
