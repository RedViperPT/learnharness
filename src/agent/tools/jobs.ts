import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import type { JobRecord } from "../../core/contracts.ts";
import type { ChatStore, JobStore } from "../../core/ports.ts";
import type { DemoToolInput } from "../../core/contracts/jobs.ts";
import { approvedDemoTitle } from "../../core/demo-consent.ts";
import { checkLearnerImage } from "./learner-image.ts";
import { resolveSourcePath } from "./fs-shared.ts";

/**
 * Async sub-agent job tools (vision §2.5; W2/W6 kinds + the pi-model
 * protocol). SERVER-EXECUTED: each call creates the job record, fires the
 * background runner (via the injected spawn seam — the agent layer never
 * imports one), and resolves IMMEDIATELY with a fire-and-forget ack. The
 * teacher's turn does NOT end at the call; the result arrives later as a
 * steer message that wakes the teacher in a new turn. See contracts.ts
 * "THE ASYNC PROTOCOL".
 */

/** What the job tools need at execute time (injected by the composition root). */
export interface JobToolContext {
	chatId: string;
	/** Creates the job record (deduped by toolCallId). */
	jobStore: JobStore;
	chatStore: Pick<ChatStore, "getChat">;
	/** Fire the background runner for a fresh job — fire-and-forget. The
	 *  input rides along because the spawn happens MID-STREAM, before
	 *  onFinish persists the tool part — a transcript scan would race it. */
	spawn: (job: JobRecord, input: ResearchInput | DemoInput | VisualInput | PdfInput) => void;
	/** Search-provider availability, retained for existing composition seams.
	 *  Research dispatch does not depend on it: web_fetch is keyless and
	 *  web_search reports a missing provider as a recoverable tool result. */
	searchAvailable?: () => boolean;
}

export const researchInputSchema = Type.Object({
	question: Type.String({
		description: "The single research question to answer. Make it specific — the researcher sees nothing else of the lesson.",
	}),
	context: Type.Optional(
		Type.String({
			description: "Why you need this / what the lesson needs it for — focuses the brief. One or two sentences.",
		}),
	),
});

export const demoInputSchema = Type.Object({
	consentCallId: Type.String({ minLength: 1, description: "Tool call id of the learner-approved, unused offer_demo." }),
	brief: Type.String({
		description:
			"Precise brief for the builder: the concept, the parameters/controls and what each does, the interactions, and the visual style. " +
			"The builder sees NOTHING else of the lesson — include everything it needs, including necessary formulas and constants.",
	}),
});

export const visualInputSchema = Type.Object({
	brief: Type.String({
		description:
			"Precise brief for ONE static figure: exactly what it must show — coordinates, labels, proportions, orientation. " +
			"The maker sees NOTHING else of the lesson; a wrong or vague brief produces a wrong figure. " +
			"With an image: which features to mark and what each label says.",
	}),
	image: Type.Optional(
		Type.String({
			description:
				"Path to one of the learner's image files (jpg, png, gif, webp, bmp) to annotate — the maker draws on top of it " +
				"instead of drawing from scratch.",
		}),
	),
});

export const pdfInputSchema = Type.Object({
	path: Type.String({ description: "Path to the learner's PDF (relative or absolute), exactly as they gave it." }),
	question: Type.String({
		description:
			"What you need from the document — the specific content, explanation, or answer to extract and brief. " +
			"The reader sees NOTHING else of the lesson.",
	}),
});

/**
 * The per-call dispatch: create the job (idempotent by toolCallId), fire the
 * runner, and return the ack. Shared by all three tools — only kind differs.
 */
function dispatch(
	ctx: JobToolContext,
	kind: JobRecord["kind"],
	toolCallId: string,
	ack: string,
	input: ResearchInput | DemoInput | VisualInput | PdfInput,
): string {
	const existing = ctx.jobStore.findJobByToolCallId(ctx.chatId, toolCallId);
	const job = existing ?? ctx.jobStore.createJob({ kind, chatId: ctx.chatId, toolCallId, input });
	if (!existing) ctx.spawn(job, input);
	return `Dispatched (job ${job.id}). ${ack}`;
}

const RESEARCH_ACK =
	"This call is fire-and-forget: continue your turn and keep teaching — do not wait, poll, or mention waiting. " +
	"The researched brief arrives as a new message when ready and the lesson resumes from it; cite its sources when you use them.";
const DEMO_ACK =
	"This call is fire-and-forget: continue your turn and keep teaching — do not wait, poll, or mention waiting. " +
	"The tested demo arrives as a new message when ready and is rendered in the lesson; teach with it then.";
const VISUAL_ACK =
	"This call is fire-and-forget: continue your turn and keep teaching — do not wait, poll, or mention waiting. " +
	"The verified figure arrives as a new message when ready and is rendered in the lesson; reference it then.";
const PDF_ACK =
	"This call is fire-and-forget: continue your turn and keep teaching — do not wait, poll, or mention waiting. " +
	"The document brief arrives as a new message when ready; weave it into the lesson and cite its pages.";

const RESEARCH_DESCRIPTION =
	"Dispatch a background web-research agent: fact verification, current data, or niche specifics you are not certain about. " +
	"The call is ASYNC and fire-and-forget — it resolves immediately and your turn continues; the research brief arrives later " +
	"as a new message and the lesson resumes from it. Cite the brief's sources when you use them. " +
	"NEVER use it for things you know cold, internal reasoning, or math.";
const DEMO_DESCRIPTION =
	"Build the interactive demo previously approved by the learner. Requires the consentCallId of an approved, unused offer_demo. " +
	"One approval authorizes one demo job only, including after failure. Write the detailed builder brief only after approval. " +
	"The call is ASYNC and fire-and-forget — it resolves immediately and your turn continues; the tested demo arrives later " +
	"as a new message. Write a precise brief: concept, controls, interactions, style.";
const VISUAL_DESCRIPTION =
	"Dispatch a background sub-agent that hand-authors ONE precise SVG figure, renders it, LOOKS at the render, and iterates " +
	"until correct. Use it for exact spatial pictures auto-layout diagrams can't do: coordinate geometry, number lines, vectors, " +
	"function plots, physical layouts. For flows/relations/taxonomies write mermaid inline instead. " +
	"Pass `image` (a learner image file) to have the maker annotate that picture — arrows, outlines, labels — instead. Local image paths follow File access settings; use ls to discover allowed folders. " +
	"The call is ASYNC and fire-and-forget — it resolves immediately and your turn continues; the verified figure arrives later " +
	"as a new message.";
const PDF_DESCRIPTION =
	"Dispatch a background sub-agent that READS a learner-provided PDF on your behalf (triage, targeted extraction, visual page " +
	"reading for equations and diagrams) and returns a brief with page citations. Use it when the learner gives you a PDF path " +
	"and you need its CONTENT for the lesson. The call is ASYNC and fire-and-forget — it resolves immediately and your turn " +
	"continues; the brief arrives later as a new message. For quick looks at plain text or image files, use the read tool " +
	"directly instead of dispatching. Local PDF paths follow File access settings; use ls to discover allowed folders.";

/**
 * Per-request job tool registry: each tool closes over the composition root's
 * context (chatId + jobStore + the spawn seam), so concurrent chats never
 * share state. chat-handler wires it each turn; tests wire their own.
 *
 * Research remains available without a search-provider key; the role's
 * existing user-toggle filtering still applies outside this registry.
 */
export function jobTools(ctx: JobToolContext): Record<string, AgentTool<any>> {
	return {
		research: {
			name: "research",
			label: "research",
			description: RESEARCH_DESCRIPTION,
			parameters: researchInputSchema,
			execute: serverExecute("research", researchInputSchema, (input, { toolCallId }) =>
				dispatch(ctx, "research", toolCallId, RESEARCH_ACK, input),
			),
		},
		demo: {
			name: "demo",
			label: "demo",
			description: DEMO_DESCRIPTION,
			parameters: demoInputSchema,
			executionMode: "sequential",
			execute: serverExecute("demo", demoInputSchema, (input, { toolCallId, signal }) => {
				signal?.throwIfAborted();
				const title = approvedDemoTitle(ctx.chatStore.getChat(ctx.chatId)?.messages ?? [], input.consentCallId);
				if (ctx.jobStore.listJobs(ctx.chatId).some(job => job.kind === "demo" && job.toolCallId !== toolCallId &&
					(job.input as Partial<DemoToolInput> | undefined)?.consentCallId === input.consentCallId)) {
					throw new Error("This demo approval has already been used. Ask again before building another demo.");
				}
				// No await between validation and durable admission: another call sees this job.
				return dispatch(ctx, "demo", toolCallId, DEMO_ACK, { ...input, title });
			}),
		},
		visual: {
			name: "visual",
			label: "visual",
			description: VISUAL_DESCRIPTION,
			parameters: visualInputSchema,
			// An unusable image path fails the CALL (no job is created), so the
			// teacher corrects the path in the same turn.
			execute: serverExecute("visual", visualInputSchema, async (input, { toolCallId, signal }) => {
				if (!ctx.jobStore.findJobByToolCallId(ctx.chatId, toolCallId) && input.image !== undefined) await checkLearnerImage(input.image);
				signal?.throwIfAborted();
				return dispatch(ctx, "visual", toolCallId, VISUAL_ACK, input);
			}),
		},
		pdf: {
			name: "pdf",
			label: "pdf",
			description: PDF_DESCRIPTION,
			parameters: pdfInputSchema,
			execute: serverExecute("pdf", pdfInputSchema, (input, { toolCallId }) => {
				// Admission uses the current boundary; the queued reader checks
				// again at job start. Preserve raw args/history and replay IDs.
				if (!ctx.jobStore.findJobByToolCallId(ctx.chatId, toolCallId)) resolveSourcePath(input.path);
				return dispatch(ctx, "pdf", toolCallId, PDF_ACK, input);
			}),
		},
	};
}

export type ResearchInput = Static<typeof researchInputSchema>;
/** Worker-facing shape remains compatible with durable pre-consent jobs. */
export type DemoInput = DemoToolInput;
export type VisualInput = Static<typeof visualInputSchema>;
export type PdfInput = Static<typeof pdfInputSchema>;
