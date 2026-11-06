import type { ChatStore } from "../core/ports.ts";
import type { NoteOrganizerEvent } from "../core/session-notes.ts";
import { emit } from "../core/events.ts";
import { modelsNotConfigured, providerKeyMissing } from "../core/settings.ts";
import { noteOrganizerContext, noteOrganizerInstructions, organizerContextFits, streamNoteOrganization, NOTE_ORGANIZER_CONTEXT_ERROR } from "../agent/note-organizer.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { isSubscriptionProvider } from "../agent/subscription-connections.ts";
import { effectiveSettings, stores, requireSessionWriter } from "./stores.ts";
import { providerKeyPresent } from "./keys.ts";
import { refreshConnectionCatalog } from "./model-catalog.ts";
import { createLatestValueCoalescer } from "./latest-value-coalescer.ts";

export function createNoteOrganizerService(deps: {
	chatStore: ChatStore;
	engineFor: () => Promise<PiEngine | Response>;
	instructions: () => string;
}) {
	const runs = new Map<string, AbortController>();
	return {
		stopAll(chatId: string) { runs.get(chatId)?.abort(); },
		async organize(chatId: string, revision: number, signal?: AbortSignal): Promise<Response> {
			const notes = deps.chatStore.readNotes(chatId);
			if (!notes) return Response.json({ error: "Not found" }, { status: 404 });
			if (notes.revision !== revision) return Response.json({ code: "notes_revision_conflict", error: "Your notes changed. Organize the latest version again.", notes }, { status: 409 });
			if (!notes.markdown.trim()) return Response.json({ error: "Write some notes before organizing." }, { status: 400 });
			if (runs.has(chatId)) return Response.json({ code: "notes_organizer_busy", error: "An organizer request is already running for this session." }, { status: 409 });
			const controller = new AbortController();
			runs.set(chatId, controller); // reserve before asynchronous model resolution
			const abort = () => controller.abort();
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			const release = () => { if (runs.get(chatId) === controller) runs.delete(chatId); signal?.removeEventListener("abort", abort); };
			try {
				if (controller.signal.aborted) { release(); return Response.json({ error: "Organization stopped." }, { status: 409 }); }
				let admissionAbort = () => {};
				const cancelled = new Promise<null>((resolve) => { admissionAbort = () => resolve(null); controller.signal.addEventListener("abort", admissionAbort, { once: true }); });
				let engine: PiEngine | Response | null;
				try { engine = await Promise.race([deps.engineFor(), cancelled]); }
				finally { controller.signal.removeEventListener("abort", admissionAbort); }
				if (!engine || controller.signal.aborted) { release(); return Response.json({ error: "Organization stopped." }, { status: 409 }); }
				if (engine instanceof Response) { release(); return engine; }
				// Freeze only notes; neither the agent nor its context receives the record.
				const current = deps.chatStore.readNotes(chatId);
				if (!current) { release(); return Response.json({ error: "Not found" }, { status: 404 }); }
				if (current.revision !== revision) { release(); return Response.json({ code: "notes_revision_conflict", error: "Your notes changed. Organize the latest version again.", notes: current }, { status: 409 }); }
				const context = noteOrganizerContext(notes.markdown, deps.instructions());
				if (!organizerContextFits(engine, context)) { release(); return Response.json({ code: "notes_context_exceeded", error: NOTE_ORGANIZER_CONTEXT_ERROR }, { status: 413 }); }
				const proposalId = crypto.randomUUID();
				const model = `${engine.model.provider}:${engine.model.id}`;
				const encoder = new TextEncoder();
				let closed = false;
				const body = new ReadableStream<Uint8Array>({
					start(output) {
						const send = (event: NoteOrganizerEvent) => { if (!closed) { try { output.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); } catch { closed = true; } } };
						const updates = createLatestValueCoalescer<NoteOrganizerEvent>((events) => events.forEach(send));
						send({ type: "start", proposalId, baseRevision: revision, model });
						void (async () => {
							try {
								const result = await streamNoteOrganization({ engine, context, signal: controller.signal, onText: (text) => updates.queue("text", { type: "text", text }) });
								// Spend belongs to the session even if the proposal fails, stops, or is discarded.
								if (result.usages.length && deps.chatStore.getChat(chatId)) deps.chatStore.appendTurnUsage(chatId, {
									id: proposalId, kind: "notes-organize", messageId: proposalId, at: new Date().toISOString(), model,
									steps: result.usages.map((usage) => ({ inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite, cacheWrite1hTokens: usage.cacheWrite1h ?? 0, reasoningTokens: usage.reasoning ?? 0 })),
								});
								updates.flush();
								send(result.outcome === "done" && !controller.signal.aborted ? { type: "done", text: result.text } : { type: "error", error: result.outcome === "aborted" ? "Organization stopped. Partial text cannot be applied." : result.error ?? "Organization failed." });
							} catch (error) {
								updates.flush();
								send({ type: "error", error: error instanceof Error ? error.message : "Organization failed." });
							} finally {
								release();
								emit("notes-organizer-settled", { chatId });
								if (!closed) { closed = true; output.close(); }
							}
						})();
					},
					cancel() { closed = true; controller.abort(); },
				});
				return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform" } });
			} catch (error) {
				release();
				return Response.json({ error: error instanceof Error ? error.message : "The organizer is unavailable." }, { status: 503 });
			}
		},
	};
}

export type NoteOrganizerService = ReturnType<typeof createNoteOrganizerService>;
const root = globalThis as typeof globalThis & { __lhNoteOrganizer?: NoteOrganizerService };
export const noteOrganizer = root.__lhNoteOrganizer ??= createNoteOrganizerService({
	chatStore: stores.chatStore,
	instructions: noteOrganizerInstructions,
	async engineFor() {
		requireSessionWriter(); // refuse another process before buying a call we cannot account for
		const spec = effectiveSettings().agent.models.noteOrganizer;
		if (!spec) return Response.json(modelsNotConfigured(["cheap"]), { status: 503 });
		if (isSubscriptionProvider(spec.provider)) await refreshConnectionCatalog(spec.provider);
		if (!providerKeyPresent(spec.provider)) return Response.json(providerKeyMissing(spec.provider, ["cheap"]), { status: 503 });
		return piEngineForSpec(spec, false, undefined, () => stores.settingsStore.readSettings()?.models?.cheap?.cacheRetention);
	},
});
