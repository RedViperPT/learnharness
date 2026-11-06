import assert from "node:assert/strict";
import { after, it } from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { PDFDocument, degrees, StandardFonts } from "pdf-lib";
import { PATHS } from "../config.ts";
import { extractionPages, pageRanges, pdfOutputName, defaultPdfName } from "../src/core/pdf-extraction.ts";
import { startPdfBatch, preparePdfBatch, commitPdfBatch, cancelPdfBatch, previewPdfBatch } from "../src/server/pdf-extraction.ts";
import { fileAccessPolicy } from "../src/server/file-access.ts";
import { resolvePolicy } from "../src/agent/tools/file-access.ts";
import { resolveSourcePath } from "../src/agent/tools/fs-shared.ts";
import { headlessOverride } from "../src/agent/subagents/headless.ts";

const root = await fs.mkdtemp(path.join(PATHS.data, "pdf-test-"));
after(async () => { headlessOverride.current = undefined; await fs.rm(root, { recursive: true, force: true }); });
const source = path.join(root, "Textbook.pdf");
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 5; i++) { const page = doc.addPage([300 + i, 400 + i]); page.drawText(`Physical page ${i}`, { font, x: 20, y: 100 }); if (i === 3) page.setRotation(degrees(90)); }
const original = await doc.save();
await fs.writeFile(source, original);
const choice = { index: 0, mode: "extract" as const, ranges: "5, 3, 3", name: "Selected.pdf" };

it("validates physical ranges without silent clamping and normalizes document order", () => {
	assert.deepEqual(extractionPages("5, 2–4, 3", 5), [2, 3, 4, 5]);
	assert.equal(pageRanges([1, 3, 4, 5, 8]), "1, 3–5, 8");
	for (const spec of ["", "0", "6", "4-2", "1,", "1-3-4", "2abc", "1.5", "-1", "1,,2"]) assert.throws(() => extractionPages(spec, 5));
	assert.throws(() => extractionPages("1", 2001));
});
it("validates cross-platform filenames and supplies a bounded editable default", () => {
	assert.equal(pdfOutputName("Notes"), "Notes.pdf");
	for (const name of ["", "../notes", "CON", "notes.", "notes ", "a:b", "a\\b", "x".repeat(200)]) assert.throws(() => pdfOutputName(name));
	assert.equal(defaultPdfName(source, [2, 3, 5]), "Textbook — PDF pages 2–3, 5.pdf");
});
it("extracts only selected pages, preserves geometry/rotation, reuses bytes+name and leaves originals intact", async () => {
	const id = randomUUID();
	assert.deepEqual(await startPdfBatch(id, [{ path: source, pdf: true }]), [{ pages: 5, error: undefined }]);
	assert.deepEqual(await preparePdfBatch(id, [choice]), {});
	const [output] = await commitPdfBatch(id, [choice]);
	const extracted = await PDFDocument.load(await fs.readFile(output!));
	assert.equal(extracted.getPageCount(), 2);
	assert.equal(extracted.getPage(0).getWidth(), 303);
	assert.equal(extracted.getPage(0).getRotation().angle, 90);
	assert.equal(extracted.getPage(1).getWidth(), 305);
	assert.deepEqual(await fs.readFile(source), Buffer.from(original));
	const second = randomUUID(); await startPdfBatch(second, [{ path: source, pdf: true }]);
	await preparePdfBatch(second, [choice]);
	assert.deepEqual(await commitPdfBatch(second, [choice]), [output]);
	const third = randomUUID(); await startPdfBatch(third, [{ path: source, pdf: true }]);
	const renamed = { ...choice, name: "Renamed" }; await preparePdfBatch(third, [renamed]);
	const [other] = await commitPdfBatch(third, [renamed]);
	assert.notEqual(other, output); assert.deepEqual(await fs.readFile(other!), await fs.readFile(output!));
	assert.throws(() => resolveSourcePath(PATHS.pdfStaging), /protected location/);
	assert.equal(resolveSourcePath(output!, resolvePolicy({ restricted: true, folders: [PATHS.pdfExtracts] })), output);
});
it("cancel deletes only staged outputs and preserves already published extracts", async () => {
	const id = randomUUID(); await startPdfBatch(id, [{ path: source, pdf: true }]); await preparePdfBatch(id, [choice]);
	assert.ok((await fs.readdir(path.join(PATHS.pdfStaging, id))).length);
	const before = await fs.readdir(PATHS.pdfExtracts);
	await cancelPdfBatch(id);
	await assert.rejects(fs.stat(path.join(PATHS.pdfStaging, id)), { code: "ENOENT" });
	assert.deepEqual(await fs.readdir(PATHS.pdfExtracts), before);
	await assert.rejects(commitPdfBatch(id, [choice]), /no longer available/);
});
it("keeps prepared successes when another item fails; retries and whole-file fallback are explicit", async () => {
	const bad = path.join(root, "Broken.pdf"); await fs.writeFile(bad, "%PDF-not really a PDF");
	const id = randomUUID(); const info = await startPdfBatch(id, [{ path: source, pdf: true }, { path: bad, pdf: true }]);
	assert.ok(info[1]!.error);
	const broken = { index: 1, mode: "extract" as const, ranges: "1", name: "Broken.pdf" };
	const errors = await preparePdfBatch(id, [choice, broken]); assert.ok(errors[1]);
	await assert.rejects(commitPdfBatch(id, [choice, broken]));
	assert.deepEqual(await preparePdfBatch(id, [choice, { index: 1, mode: "whole" }]), {});
	const paths = await commitPdfBatch(id, [choice, { index: 1, mode: "whole" }]); assert.equal(paths[1], bad);
});
it("rejects changed sources, excessive byte sizes, and invalid batch identifiers", async () => {
	const changing = path.join(root, "Changing.pdf"); await fs.writeFile(changing, original);
	const id = randomUUID(); await startPdfBatch(id, [{ path: changing, pdf: true }]); await fs.appendFile(changing, "changed");
	assert.match((await preparePdfBatch(id, [choice]))[0]!, /changed/); await cancelPdfBatch(id);
	const huge = path.join(root, "Huge.pdf"); const handle = await fs.open(huge, "w"); await handle.truncate(100_000_001); await handle.close();
	const large = randomUUID(); assert.match((await startPdfBatch(large, [{ path: huge, pdf: true }]))[0]!.error!, /100 MB/); await cancelPdfBatch(large);
	await assert.rejects(cancelPdfBatch("../../elsewhere"), /Invalid/);
});
it("preview failure does not block extraction, and cancellation waits for active preview cleanup", async () => {
	const id = randomUUID(); await startPdfBatch(id, [{ path: source, pdf: true }]);
	let release!: () => void, entered!: () => void;
	const started = new Promise<void>(r => { entered = r; });
	headlessOverride.current = { renderPdfPages: async () => { entered(); await new Promise<void>(r => { release = r; }); throw new Error("synthetic preview failure"); } } as unknown as NonNullable<typeof headlessOverride.current>;
	const rendering = previewPdfBatch(id, 0, 1); await started;
	await cancelPdfBatch(id); release(); await assert.rejects(rendering, /synthetic/);
	await assert.rejects(fs.stat(path.join(PATHS.pdfStaging, id)), { code: "ENOENT" });
	headlessOverride.current = undefined;
});
it("never overwrites a corrupted shared output and cleans abandoned staging only", async () => {
	const id = randomUUID(); await startPdfBatch(id, [{ path: source, pdf: true }]);
	const special = { ...choice, name: "Collision.pdf" }; await preparePdfBatch(id, [special]);
	const [output] = await commitPdfBatch(id, [special]); await fs.writeFile(output!, "existing modified file");
	const retry = randomUUID(); await startPdfBatch(retry, [{ path: source, pdf: true }]); await preparePdfBatch(retry, [special]);
	await assert.rejects(commitPdfBatch(retry, [special]), /not be overwritten/); await cancelPdfBatch(retry);
	assert.equal(await fs.readFile(output!, "utf8"), "existing modified file");
	await fs.mkdir(path.join(PATHS.pdfStaging, "abandoned"), { recursive: true });
	const require = createRequire(import.meta.url); require("../electron/pdf-staging.cjs").cleanPdfStaging(PATHS.data);
	await assert.rejects(fs.stat(PATHS.pdfStaging), { code: "ENOENT" }); assert.ok(await fs.stat(output!));
	assert.ok(fileAccessPolicy().folders.includes(PATHS.pdfExtracts));
});

it("checks HTTP desktop authorization, addressed host origin, JSON, bounded input, and selections", async () => {
	const { POST } = await import("../app/api/pdf-extractions/route.ts");
	const old = process.env.LH_DESKTOP_API_SECRET;
	process.env.LH_DESKTOP_API_SECRET = "a".repeat(64);
	const id = randomUUID();
	const request = (body: unknown, extra: Record<string, string> = {}) => new Request("http://localhost:3000/api/pdf-extractions", { method: "POST", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json", "x-learnharness-desktop": "a".repeat(64), ...extra }, body: JSON.stringify(body) });
	try {
		assert.equal((await POST(request({ id, action: "cancel" }, { "x-learnharness-desktop": "wrong" }))).status, 403);
		assert.equal((await POST(request({ id, action: "cancel" }, { origin: "https://evil.example" }))).status, 403);
		assert.equal((await POST(request({ id, action: "cancel" }, { "content-type": "text/plain" }))).status, 415);
		assert.equal((await POST(request({ id, action: "start", items: [{ path: source, pdf: true }] }))).status, 200, "Host origin, not Next's internal hostname");
		assert.equal((await POST(request({ id, action: "prepare", selections: [{ index: 0, mode: "extract", ranges: "1", name: "test" }, { index: 0, mode: "whole" }] }))).status, 400);
		assert.equal((await POST(request({ id, action: "preview", index: 0, page: 99 }))).status, 400);
		assert.equal((await POST(request({ id, action: "cancel", padding: "x".repeat(100_001) }))).status, 400);
		assert.equal((await POST(request({ id, action: "cancel" }))).status, 200);
	} finally { if (old === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = old; await cancelPdfBatch(id); }
});

it("published-folder allowance is narrow, canonical, and never grants private staging", async () => {
	await fs.mkdir(PATHS.pdfExtracts, { recursive: true });
	const policy = resolvePolicy({ restricted: true, folders: [PATHS.pdfExtracts] });
	assert.throws(() => resolveSourcePath(source, policy), /outside the allowed/);
	const alias = path.join(PATHS.pdfExtracts, "escape");
	await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
	assert.throws(() => resolveSourcePath(path.join(alias, "Textbook.pdf"), policy), /outside the allowed/);
	await fs.rm(alias);
	assert.throws(() => resolveSourcePath(path.join(PATHS.pdfStaging, "unpublished.pdf")), /protected location/);
});

it("rejects encrypted and over-page-limit extraction without blocking explicit whole-file attachment", async () => {
	const many = await PDFDocument.create(); for (let i = 0; i < 2001; i++) many.addPage([10, 10]);
	const manyPath = path.join(root, "Many.pdf"); await fs.writeFile(manyPath, await many.save());
	const encrypted = await PDFDocument.create(); encrypted.addPage();
	encrypted.context.trailerInfo.Encrypt = encrypted.context.register(encrypted.context.obj({ Filter: "Standard" }));
	const encryptedPath = path.join(root, "Encrypted.pdf"); await fs.writeFile(encryptedPath, await encrypted.save());
	const id = randomUUID(); const info = await startPdfBatch(id, [{ path: manyPath, pdf: true }, { path: encryptedPath, pdf: true }]);
	assert.match(info[0]!.error!, /2,000/); assert.match(info[1]!.error!, /encrypted/i);
	assert.deepEqual(await commitPdfBatch(id, [{ index: 0, mode: "whole" }, { index: 1, mode: "whole" }]), [manyPath, encryptedPath]);
});

it("rolls back newly published batch files when a later shared-name collision fails", async () => {
	const id = randomUUID(); await startPdfBatch(id, [{ path: source, pdf: true }, { path: source, pdf: true }]);
	const selections = [{ ...choice, name: "Rollback-only.pdf" }, { ...choice, index: 1, name: "Collision.pdf" }];
	assert.deepEqual(await preparePdfBatch(id, selections), {});
	await assert.rejects(commitPdfBatch(id, selections), /not be overwritten/);
	const all = await fs.readdir(PATHS.pdfExtracts, { recursive: true });
	assert.ok(!all.some(name => name.endsWith("Rollback-only.pdf")));
	await cancelPdfBatch(id);
});
