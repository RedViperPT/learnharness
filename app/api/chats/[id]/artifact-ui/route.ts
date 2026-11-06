/**
 * THE ARTIFACT-UI ROUTE: persists inversion and demo collapse preferences
 * onto artifact steer messages (details.ui) so they
 * survives session navigation and restarts. Modeled on the dismissal
 * route's SILENCE: no wake, no agent, no tokens, no SSE — the record is
 * the only state that moves, and the client already holds the toggled
 * state optimistically (no refetch churn).
 *
 * Guards: 404 unknown chat, 400 for a body that isn't
 * { input: { messageId, inverted?, collapsed? } } or targets an unsupported steer.
 */
import { patchSteerUi, type SteerDetails } from "@/src/core";
import { getChat, stores } from "@/src/server";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Unknown chat" }, { status: 404 });

	const body = (await req.json().catch(() => null)) as { input?: unknown } | null;
	const input = body?.input as { messageId?: unknown; inverted?: unknown; collapsed?: unknown } | null | undefined;
	if (
		!input ||
		typeof input !== "object" ||
		typeof input.messageId !== "string" ||
		Array.isArray(input) ||
		(input.inverted === undefined && input.collapsed === undefined) ||
		(input.inverted !== undefined && typeof input.inverted !== "boolean") ||
		(input.collapsed !== undefined && typeof input.collapsed !== "boolean")
	) {
		return Response.json({ error: "input requires messageId and at least one boolean inverted or collapsed field" }, { status: 400 });
	}

	// Honesty: the target must actually be a demo/figure steer.
	// Read again after body parsing so simultaneous UI patches merge with the latest record.
	const current = getChat(id);
	if (!current) return Response.json({ error: "Unknown chat" }, { status: 404 });
	const target = current.messages.find((m) => m.id === input.messageId);
	const details = target ? ((target as { details?: unknown }).details as Partial<SteerDetails> | undefined) : undefined;
	if (target?.role !== "custom" || target.customType !== "subagent-steer" || !details ||
		(details.kind !== "demo" && details.kind !== "visual") || (input.collapsed !== undefined && details.kind !== "demo")) {
		return Response.json({ error: "No demo/figure steer with that message id" }, { status: 400 });
	}

	const messages = patchSteerUi(current.messages, input.messageId, {
		...(typeof input.inverted === "boolean" ? { inverted: input.inverted } : {}),
		...(typeof input.collapsed === "boolean" ? { collapsed: input.collapsed } : {}),
	});
	stores.chatStore.saveMessages(id, messages);
	return Response.json({ ok: true });
}
