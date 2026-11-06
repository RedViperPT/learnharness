import { getChat, sideChats } from "@/src/server";
import { parseSideRequestId, SideChatInputError } from "@/src/core";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	let requestId: string;
	try {
		const body = await request.json();
		requestId = parseSideRequestId(body?.requestId);
	} catch (error) {
		return Response.json({ error: error instanceof SideChatInputError ? error.message : "Invalid request body" }, { status: 400 });
	}
	if (!sideChats.cancel(id, requestId)) return Response.json({ error: "The side question request expired." }, { status: 409 });
	return Response.json({ ok: true });
}
