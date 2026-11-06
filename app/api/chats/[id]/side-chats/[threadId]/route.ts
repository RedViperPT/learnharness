import { sideChats } from "@/src/server";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; threadId: string }> }) {
	const { id, threadId } = await params;
	const result = sideChats.remove(id, threadId);
	if (result !== "ok") return Response.json({ error: result === "unknown-chat" ? "Not found" : "Unknown side thread" }, { status: 404 });
	return Response.json({ ok: true });
}
