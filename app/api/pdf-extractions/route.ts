import { desktopAPIAuthorized, subscriptionRequestOrigin, startPdfBatch, previewPdfBatch, preparePdfBatch, commitPdfBatch, cancelPdfBatch } from "@/src/server";
import type { PdfBatchItem, PdfSelection } from "@/src/core";

export const runtime = "nodejs";
export async function POST(request: Request) {
	if (!desktopAPIAuthorized(request.headers)) return Response.json({ error: "Unauthorized desktop request." }, { status: 403 });
	const origin = request.headers.get("origin");
	if (request.headers.get("sec-fetch-site") === "cross-site" || (origin && origin !== subscriptionRequestOrigin(request))) return Response.json({ error: "Invalid request origin." }, { status: 403 });
	if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return Response.json({ error: "Expected JSON." }, { status: 415 });
	try {
		if (Number(request.headers.get("content-length")) > 100_000) throw new Error("Request too large.");
		const reader = request.body?.getReader();
		let text = "", size = 0;
		const decoder = new TextDecoder();
		if (reader) { try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 100_000) throw new Error("Request too large."); text += decoder.decode(value, { stream: true }); } text += decoder.decode(); } finally { await reader.cancel(); } }
		const body = JSON.parse(text);
		if (typeof body.id !== "string") throw new Error("Invalid batch id.");
		let result: unknown;
		if (body.action === "start") {
			if (!Array.isArray(body.items) || body.items.some((item: PdfBatchItem) => !item || typeof item.path !== "string" || item.path.length > 4096 || typeof item.pdf !== "boolean")) throw new Error("Invalid items.");
			result = await startPdfBatch(body.id, body.items);
		} else if (body.action === "preview") {
			if (!Number.isInteger(body.index) || !Number.isInteger(body.page)) throw new Error("Invalid page.");
			return new Response(new Uint8Array(await previewPdfBatch(body.id, body.index, body.page)), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
		} else if (body.action === "cancel") { await cancelPdfBatch(body.id); result = {}; }
		else if (body.action === "prepare" || body.action === "commit") {
			if (!Array.isArray(body.selections) || body.selections.length > 100 || new Set(body.selections.map((s: PdfSelection) => s?.index)).size !== body.selections.length || body.selections.some((s: PdfSelection) => !s || !Number.isInteger(s.index) || s.index < 0 || !["whole", "extract"].includes(s.mode) || (s.mode === "extract" && (typeof s.ranges !== "string" || typeof s.name !== "string")))) throw new Error("Invalid selection.");
			result = body.action === "prepare" ? await preparePdfBatch(body.id, body.selections) : await commitPdfBatch(body.id, body.selections);
		} else throw new Error("Unknown extraction operation.");
		return Response.json(result, { headers: { "Cache-Control": "no-store" } });
	} catch (error) { return Response.json({ error: error instanceof Error ? error.message : "PDF operation failed." }, { status: 400, headers: { "Cache-Control": "no-store" } }); }
}
