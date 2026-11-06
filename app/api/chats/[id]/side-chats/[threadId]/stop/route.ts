import { getChat, sideChats } from "@/src/server";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string; threadId: string }> }) {
	const { id, threadId } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	if (!sideChats.stop(id, threadId)) return Response.json({ error: "No side answer is running" }, { status: 409 });
	return Response.json({ ok: true });
}
