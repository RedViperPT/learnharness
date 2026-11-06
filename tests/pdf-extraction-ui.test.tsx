import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { parseHTML } from "linkedom";
import { PdfExtractionDialog } from "../components/pdf-extraction-dialog.tsx";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });
async function fixture({ valid = true, previewFails = false, strict = false } = {}) {
	const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
	let active = document.body;
	Object.defineProperty(document, "activeElement", { get: () => active });
	window.HTMLElement.prototype.focus = function () { active = this; };
	const calls: { action: string; selections?: { mode: string }[] }[] = [], applied: string[][] = [], notices: string[] = [];
	let closed = 0;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({ React, window, document, HTMLElement: window.HTMLElement, Node: window.Node, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (_url: string, init: RequestInit) => {
			const body = JSON.parse(init.body as string); calls.push(body);
			if (body.action === "start") return Response.json([{ pages: 5 }, {}]);
			if (body.action === "preview") return previewFails ? Response.json({ error: "Synthetic preview failure" }, { status: 400 }) : new Response(new Blob(["png"], { type: "image/png" }));
			if (body.action === "prepare") return Response.json({});
			if (body.action === "commit") return Response.json(["/managed/extract.pdf", "/notes.txt"]);
			return Response.json({});
		},
	})) { previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }); }
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	const paths = ["/book.pdf", "/notes.txt"];
	await act(async () => {
		const dialog = <PdfExtractionDialog paths={paths} valid={() => valid} onApply={paths => applied.push(paths)} onClose={() => closed++} onNotice={message => notices.push(message)} />;
		root.render(strict ? <React.StrictMode>{dialog}</React.StrictMode> : dialog);
	});
	cleanup = async () => { await act(async () => root.unmount()); for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as Record<string, unknown>)[name]; } };
	return { document, calls, applied, notices, get closed() { return closed; },
		async click(text: string) { await act(async () => { const target = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === text); assert.ok(target, `Missing ${text}`); target.click(); }); },
	};
}
it("defaults to whole PDF, stages mixed items, and applies once as a complete batch", async () => {
	const f = await fixture();
	assert.ok(f.document.querySelector('[role="dialog"]'));
	assert.equal(f.applied.length, 0);
	await f.click("Apply");
	assert.deepEqual(f.calls.find(call => call.action === "prepare")!.selections!.map(row => row.mode), ["whole", "whole"]);
	assert.deepEqual(f.applied, [["/managed/extract.pdf", "/notes.txt"]]); assert.equal(f.closed, 1);
});
it("cancel never inserts and asks the server to remove staging", async () => {
	const f = await fixture(); await f.click("Cancel");
	assert.equal(f.applied.length, 0); assert.equal(f.closed, 1); assert.ok(f.calls.some(call => call.action === "cancel"));
});
it("a failed preview still allows applying attachments", async () => {
	const f = await fixture({ previewFails: true });
	assert.match(f.document.body.textContent!, /Preview unavailable/); await f.click("Apply"); assert.equal(f.applied.length, 1);
});
it("does not prepare or publish into an invalid original destination", async () => {
	const f = await fixture({ valid: false }); await f.click("Apply");
	assert.equal(f.applied.length, 0); assert.ok(!f.calls.some(call => call.action === "prepare")); assert.match(f.document.body.textContent!, /original composer/);
});
it("React StrictMode starts exactly one batch without cancelling the live remount", async () => {
	const f = await fixture({ strict: true });
	assert.equal(f.calls.filter(call => call.action === "start").length, 1);
	assert.equal(f.calls.filter(call => call.action === "cancel").length, 0);
	await f.click("Apply"); assert.equal(f.applied.length, 1);
});
