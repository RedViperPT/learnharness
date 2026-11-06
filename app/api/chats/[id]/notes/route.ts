import { stores } from "@/src/server";
import { NOTES_MAX_BYTES, notesByteLength } from "@/src/core";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const notes = stores.chatStore.readNotes(id);
	return notes ? Response.json(notes, { headers: { "Cache-Control": "no-store" } }) : Response.json({ error: "Not found" }, { status: 404 });
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = await request.json().catch(() => null) as { markdown?: unknown; expectedRevision?: unknown } | null;
	if (typeof body?.markdown !== "string" || typeof body.expectedRevision !== "number" || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
		return Response.json({ error: "markdown and a non-negative integer expectedRevision are required" }, { status: 400 });
	}
	if (notesByteLength(body.markdown) > NOTES_MAX_BYTES) return Response.json({ error: "Notes exceed the 512 KiB limit." }, { status: 413 });
	try {
		const notes = stores.chatStore.saveNotes(id, body.markdown, body.expectedRevision);
		if (notes === "conflict") return Response.json({ code: "notes_revision_conflict", notes: stores.chatStore.readNotes(id) }, { status: 409 });
		return notes ? Response.json(notes) : Response.json({ error: "Not found" }, { status: 404 });
	} catch {
		return Response.json({ error: "Notes could not be saved. Your local text has been kept." }, { status: 503 });
	}
}
