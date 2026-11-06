import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { PATHS } from "../../config.ts";
import { extractionPages, pdfOutputName, MAX_PDF_BYTES, MAX_PDF_PAGES, type PdfBatchItem, type PdfInspection, type PdfSelection } from "../core/pdf-extraction.ts";
import { resolveSourcePath } from "../agent/tools/fs-shared.ts";
import { resolvePolicy } from "../agent/tools/file-access.ts";
import { fileAccessPolicy } from "./file-access.ts";
import { getHeadless } from "../agent/subagents/headless.ts";

type Item = PdfBatchItem & PdfInspection & { sourceHash?: string; prepared?: { key: string; file: string; name: string; hash: string } };
type Batch = { items: Item[]; active: number; cancelled: boolean; committing: boolean; prepared: boolean };
const state = globalThis as typeof globalThis & { pdfExtractionBatches?: Map<string, Batch>; pdfPublication?: Promise<void> };
const batches = state.pdfExtractionBatches ??= new Map<string, Batch>();
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const batchDir = (id: string) => path.join(PATHS.pdfStaging, id);
function validId(id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid extraction batch."); }
function checkedPath(source: string) {
	return resolveSourcePath(source, resolvePolicy(fileAccessPolicy()));
}
async function publishLocked<T>(run: () => Promise<T>): Promise<T> {
	const previous = state.pdfPublication ?? Promise.resolve();
	let release!: () => void;
	state.pdfPublication = new Promise<void>(resolve => { release = resolve; });
	await previous;
	try { return await run(); } finally { release(); }
}
async function sourceBytes(item: Item) {
	const source = checkedPath(item.path);
	const handle = await fs.open(source, "r");
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > MAX_PDF_BYTES) throw new Error("Extraction supports PDF files up to 100 MB. You can still attach the whole PDF.");
		// Bounded read even if a source grows after stat.
		const bytes = Buffer.alloc(stat.size + 1);
		let length = 0;
		while (length < bytes.length) {
			const read = await handle.read(bytes, length, bytes.length - length, null);
			if (!read.bytesRead) break;
			length += read.bytesRead;
		}
		if (length !== stat.size) throw new Error("PDF changed while reading. Remove it and select it again.");
		const data = bytes.subarray(0, length);
		if (data.subarray(0, 5).toString() !== "%PDF-") throw new Error("This file does not start with a PDF header.");
		if (item.sourceHash && item.sourceHash !== hash(data)) throw new Error("PDF changed. Remove it and select it again.");
		return data;
	} finally { await handle.close(); }
}
async function cleanup(id: string, batch: Batch) {
	if (batch.cancelled && batch.active === 0 && !batch.committing) {
		await fs.rm(batchDir(id), { recursive: true, force: true });
		batches.delete(id);
	}
}
async function useBatch<T>(id: string, run: (batch: Batch) => Promise<T>): Promise<T> {
	validId(id);
	const batch = batches.get(id);
	if (!batch || batch.cancelled || batch.committing) throw new Error("Extraction batch is no longer available.");
	batch.active++;
	try { return await run(batch); }
	finally { batch.active--; await cleanup(id, batch); }
}
export async function startPdfBatch(id: string, items: PdfBatchItem[]) {
	validId(id);
	if (batches.has(id) || batches.size >= 20 || !items.length || items.length > 100) throw new Error("Cannot start this extraction batch.");
	const batch: Batch = { items: items.map(item => ({ ...item })), active: 0, cancelled: false, committing: false, prepared: false };
	batches.set(id, batch);
	return useBatch(id, async () => {
		await fs.mkdir(PATHS.pdfStaging, { recursive: true });
		if ((await fs.lstat(PATHS.pdfStaging)).isSymbolicLink()) throw new Error("PDF staging must not be a symlink.");
		await fs.mkdir(batchDir(id), { recursive: true });
		for (const item of batch.items) {
			if (batch.cancelled) break;
			if (!item.pdf) continue;
			try {
				const bytes = await sourceBytes(item);
				const doc = await PDFDocument.load(bytes, { updateMetadata: false });
				item.pages = doc.getPageCount();
				item.sourceHash = hash(bytes);
				if (item.pages > MAX_PDF_PAGES) throw new Error("Extraction supports up to 2,000 PDF pages. You can still attach the whole PDF.");
			} catch (error) { item.error = error instanceof Error ? error.message : "Cannot inspect PDF."; }
		}
		return batch.items.map(({ pages, error }) => ({ pages, error }));
	});
}
export async function previewPdfBatch(id: string, index: number, page: number) {
	return useBatch(id, async batch => {
		const item = batch.items[index];
		if (!item?.pdf || item.error || !item.pages || !Number.isInteger(page) || page < 1 || page > item.pages) throw new Error("Invalid preview page.");
		// Snapshot avoids a second unchecked read by the renderer; never expose it to the agent.
		const bytes = await sourceBytes(item);
		const file = path.join(batchDir(id), `preview-${index}-${page}-${randomUUID()}.pdf`);
		await fs.writeFile(file, bytes, { flag: "wx" });
		try {
			const rendered = await getHeadless().renderPdfPages(file, [page], { dpi: 150 });
			if (!rendered[0]) throw new Error("Preview unavailable.");
			return rendered[0].png;
		} finally { await fs.rm(file, { force: true }); }
	});
}
export async function preparePdfBatch(id: string, selections: PdfSelection[]) {
	return useBatch(id, async batch => {
		if (batch.prepared) throw new Error("Batch is already processing.");
		batch.prepared = true;
		try {
			const errors: Record<number, string> = {};
			for (const choice of selections) {
				if (batch.cancelled) throw new Error("Extraction cancelled.");
				const item = batch.items[choice.index];
				if (!item) throw new Error("Invalid batch item.");
				if (choice.mode === "whole") continue;
				try {
					if (!item.pdf || item.error || !item.pages) throw new Error(item.error || "Cannot extract this PDF.");
					const pages = extractionPages(choice.ranges ?? "", item.pages);
					const name = pdfOutputName(choice.name ?? "");
					const bytes = await sourceBytes(item);
					const key = JSON.stringify([pages, name]);
					if (item.prepared?.key === key) continue;
					const source = await PDFDocument.load(bytes, { updateMetadata: false });
					const output = await PDFDocument.create();
					output.setCreationDate(new Date(0)); output.setModificationDate(new Date(0));
					for (const page of await output.copyPages(source, pages.map(p => p - 1))) output.addPage(page);
					const data = await output.save();
					const file = path.join(batchDir(id), `extract-${choice.index}.pdf`);
					await fs.writeFile(file, data);
					item.prepared = { key, file, name, hash: hash(data) };
				} catch (error) { errors[choice.index] = error instanceof Error ? error.message : "Extraction failed."; }
			}
			return errors;
		} finally { batch.prepared = false; }
	});
}
export async function commitPdfBatch(id: string, selections: PdfSelection[]) {
	return useBatch(id, async batch => {
		if (batch.prepared) throw new Error("Extraction is still processing.");
		const paths: string[] = [];
		const publish: { staged: string; target: string }[] = [];
		for (const choice of selections) {
			const item = batch.items[choice.index];
			if (!item) throw new Error("Invalid batch item.");
			if (choice.mode === "whole") { paths.push(item.path); continue; }
			const key = JSON.stringify([extractionPages(choice.ranges ?? "", item.pages ?? 0), pdfOutputName(choice.name ?? "")]);
			if (!item.prepared || item.prepared.key !== key) throw new Error("Prepare all selected PDFs first.");
			const target = path.join(PATHS.pdfExtracts, item.prepared.hash, item.prepared.name);
			if (target.length > 240) throw new Error("Extracted path is too long. Choose a shorter filename.");
			publish.push({ staged: item.prepared.file, target }); paths.push(target);
		}
		batch.committing = true;
		try {
			await publishLocked(async () => {
				const created: string[] = [];
				try {
					for (const { staged, target } of publish) {
						await fs.mkdir(PATHS.pdfExtracts, { recursive: true });
						if ((await fs.lstat(PATHS.pdfExtracts)).isSymbolicLink()) throw new Error("Extract folder must not be a symlink.");
						await fs.mkdir(path.dirname(target), { recursive: true });
						if ((await fs.lstat(path.dirname(target))).isSymbolicLink()) throw new Error("Extract directory must not be a symlink.");
						checkedPath(target);
						try { await fs.link(staged, target); created.push(target); }
						catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
							if ((await fs.lstat(target)).isSymbolicLink() || hash(await fs.readFile(target)) !== hash(await fs.readFile(staged))) throw new Error("Existing extract differs; it will not be overwritten.");
						}
					}
				} catch (error) { await Promise.all(created.map(file => fs.unlink(file))); throw error; }
			});
			batch.cancelled = true;
			return paths;
		} finally { batch.committing = false; }
	});
}
export async function cancelPdfBatch(id: string) {
	validId(id);
	const batch = batches.get(id);
	if (!batch) return;
	if (batch.committing) throw new Error("Final save is already in progress.");
	batch.cancelled = true;
	await cleanup(id, batch);
}
