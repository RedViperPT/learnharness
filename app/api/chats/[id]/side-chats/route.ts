import { getChat, sideChats } from "@/src/server";
import { parseSideAskInput, SideChatInputError } from "@/src/core";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json(sideChats.list(id));
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	let input;
	try { input = parseSideAskInput(await request.json()); }
	catch (error) { return Response.json({ error: error instanceof SideChatInputError ? error.message : "Invalid request body" }, { status: 400 }); }
	return sideChats.ask(id, input);
}
