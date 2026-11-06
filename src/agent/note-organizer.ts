import { randomUUID } from "node:crypto";
import { normalizeContext, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { NOTES_MAX_BYTES, notesByteLength } from "../core/session-notes.ts";
import { readPromptSource } from "./prompt-segments.ts";
import type { PiEngine } from "./models.ts";

export const NOTE_ORGANIZER_CONTEXT_RESERVE_TOKENS = 12_000;
export const NOTE_ORGANIZER_CONTEXT_ERROR = "These notes are too large to organize with the selected model. Choose a model with a larger context window. Your notes have not been shortened.";
export const noteOrganizerInstructions = () => readPromptSource("note-organizer/00-base.md");

export function noteOrganizerContext(markdown: string, instructions: string) {
	return normalizeContext({
		systemPrompt: instructions,
		messages: [{ role: "user", content: JSON.stringify({ learner_notes: markdown }), timestamp: Date.now() }],
		tools: [],
	});
}

export function organizerContextFits(engine: PiEngine, context: ReturnType<typeof noteOrganizerContext>): boolean {
	return Number.isFinite(engine.model.contextWindow) && engine.model.contextWindow > 0
		&& Math.ceil(JSON.stringify(context).length / 4) + NOTE_ORGANIZER_CONTEXT_RESERVE_TOKENS <= engine.model.contextWindow;
}

export interface NoteOrganizerResult {
	text: string;
	usages: Usage[];
	outcome: "done" | "aborted" | "error";
	error?: string;
}

const textOf = (message: AssistantMessage) => message.content.filter((part) => part.type === "text").map((part) => part.text).join("");

/** Exactly one tool-less call. Never sees a ChatRecord or any lesson context. */
export async function streamNoteOrganization(options: {
	engine: PiEngine;
	context: ReturnType<typeof noteOrganizerContext>;
	signal: AbortSignal;
	onText: (text: string) => void;
}): Promise<NoteOrganizerResult> {
	let text = "";
	const usages: Usage[] = [];
	const result = (outcome: NoteOrganizerResult["outcome"], error?: string): NoteOrganizerResult => ({ text, usages, outcome, error });
	if (!organizerContextFits(options.engine, options.context)) return result("error", NOTE_ORGANIZER_CONTEXT_ERROR);
	try {
		const stream = options.engine.streamFn(options.engine.model, options.context, {
			sessionId: randomUUID(), signal: options.signal,
			maxTokens: Math.min(NOTE_ORGANIZER_CONTEXT_RESERVE_TOKENS, options.engine.model.maxTokens),
			reasoning: options.engine.level && options.engine.level !== "off" ? options.engine.level : undefined,
		} as never);
		for await (const event of stream) {
			if (event.type === "text_delta" || event.type === "text_end") {
				text = textOf(event.partial);
				options.onText(text);
			} else if (event.type === "error") {
				usages.push(event.error.usage);
				text = textOf(event.error) || text;
				return result(event.reason === "aborted" ? "aborted" : "error", event.error.errorMessage ?? "The organizer failed.");
			} else if (event.type === "done") {
				usages.push(event.message.usage);
				text = textOf(event.message);
				if (options.signal.aborted) return result("aborted");
				if (event.message.stopReason !== "stop" || event.message.content.some((part) => part.type === "toolCall")) return result("error", "The organizer did not complete the document. The partial proposal cannot be applied.");
				if (!text.trim()) return result("error", "The organizer returned an empty document.");
				if (notesByteLength(text) > NOTES_MAX_BYTES) return result("error", "The proposal exceeds the 512 KiB notes limit and cannot be applied.");
				return result("done");
			}
		}
		return result(options.signal.aborted ? "aborted" : "error", "The organizer stream ended before completion.");
	} catch (error) {
		return result(options.signal.aborted ? "aborted" : "error", error instanceof Error ? error.message : "The organizer failed.");
	}
}
