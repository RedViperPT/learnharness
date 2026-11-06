import { noteOrganizer } from "@/src/server";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = await request.json().catch(() => null) as { revision?: unknown } | null;
	if (typeof body?.revision !== "number" || !Number.isSafeInteger(body.revision) || body.revision < 0) return Response.json({ error: "A non-negative integer revision is required." }, { status: 400 });
	return noteOrganizer.organize(id, body.revision, request.signal);
}
