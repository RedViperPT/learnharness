"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { defaultPdfName, extractionPages, pageRanges, pdfOutputName, type PdfInspection, type PdfSelection } from "@/src/core";

export async function pdfRequest(id: string, action: string, payload: object = {}, signal?: AbortSignal) {
	const response = await fetch("/api/pdf-extractions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action, ...payload }), signal });
	if (!response.ok) throw new Error((await response.json()).error || "PDF operation failed.");
	return response;
}
type Row = { path: string; pdf: boolean; removed: boolean; mode: "whole" | "extract"; ranges: string; name: string; edited: boolean; pages?: number; error?: string };
const button = "rounded border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-40";
const field = "w-full rounded border bg-background px-2 py-1 text-sm";

export function PdfExtractionDialog({ paths, valid, onApply, onClose, onNotice }: {
	paths: string[]; valid: () => boolean; onApply: (paths: string[]) => void; onClose: () => void; onNotice: (message: string) => void;
}) {
	const [id] = useState(() => crypto.randomUUID());
	const [rows, setRows] = useState<Row[]>(() => paths.map(path => ({ path, pdf: /\.pdf$/i.test(path), removed: false, mode: "whole", ranges: "", name: "", edited: false })));
	const [selected, setSelected] = useState(() => paths.findIndex(path => /\.pdf$/i.test(path)));
	const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [finalizing, setFinalizing] = useState(false);
	const [failure, setFailure] = useState("");
	const [errors, setErrors] = useState<Record<number, string>>({});
	const [page, setPage] = useState(1), [zoom, setZoom] = useState(100), [image, setImage] = useState("");
	const [previewError, setPreviewError] = useState("");
	const closed = useRef(false), finalized = useRef(false), finalizingRef = useRef(false);
	const dialog = useRef<HTMLDivElement>(null);
	const restoreFocus = useRef<HTMLElement | null>(null);
	const controller = useRef(new AbortController());
	const startRequest = useRef<Promise<PdfInspection[]> | null>(null);
	const generation = useRef(0);
	const cancelRef = useRef<() => void>(() => {});
	const callbacks = useRef({ valid, onApply, onClose, onNotice }); callbacks.current = { valid, onApply, onClose, onNotice };
	function cancel() {
		if (finalizingRef.current || closed.current) return;
		closed.current = true; controller.current.abort();
		void pdfRequest(id, "cancel").catch(() => {});
		callbacks.current.onClose();
	}
	cancelRef.current = cancel;
	useEffect(() => {
		const token = ++generation.current;
		restoreFocus.current ??= document.activeElement as HTMLElement | null;
		const previous = restoreFocus.current;
		dialog.current?.focus();
		// Do not abort the start request: cancellation must reach the batch after it exists.
		let disposed = false;
		startRequest.current ??= pdfRequest(id, "start", { items: paths.map(path => ({ path, pdf: /\.pdf$/i.test(path) })) }).then(r => r.json());
		void startRequest.current.then((info: PdfInspection[]) => {
			if (disposed || closed.current) return;
			setRows(current => current.map((row, i) => ({ ...row, ...info[i] }))); setLoading(false);
		}).catch(error => { if (!disposed && !closed.current) { setFailure(error.message); setLoading(false); } });
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelRef.current(); }
			if (event.key === "Tab") {
				const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex='0']") ?? []);
				const first = controls[0], last = controls.at(-1);
				if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
				else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
			}
		};
		document.addEventListener("keydown", key, true);
		return () => { disposed = true; document.removeEventListener("keydown", key, true); queueMicrotask(() => { if (generation.current !== token) return; controller.current.abort(); if (!finalized.current) { void pdfRequest(id, "cancel").catch(() => {}); void startRequest.current?.then(() => pdfRequest(id, "cancel")).catch(() => {}); } previous?.focus(); }); };
	}, [id, paths]);
	const current = rows[selected];
	useEffect(() => {
		setImage(""); setPreviewError("");
		if (loading || !current?.pdf || current.error || current.removed || !current.pages) return;
		const abort = new AbortController();
		let url = "";
		void pdfRequest(id, "preview", { index: selected, page }, abort.signal).then(r => r.blob()).then(blob => {
			if (!abort.signal.aborted) { url = URL.createObjectURL(blob); setImage(url); }
		}).catch(error => { if (!abort.signal.aborted) setPreviewError(`Preview unavailable: ${error.message}`); });
		return () => { abort.abort(); if (url) URL.revokeObjectURL(url); };
	}, [id, selected, page, loading, current?.pages, current?.error, current?.removed, current?.pdf]);
	function update(index: number, change: Partial<Row>) {
		setRows(existing => existing.map((row, i) => {
			if (i !== index) return row;
			const next = { ...row, ...change };
			if (!next.edited && next.pages) { try { next.name = defaultPdfName(next.path, extractionPages(next.ranges, next.pages)); } catch { /* Keep the last valid generated name. */ } }
			return next;
		}));
		setErrors({}); setFailure("");
	}
	async function apply() {
		if (busy || loading) return;
		const selections: PdfSelection[] = [];
		const invalid: Record<number, string> = {};
		rows.forEach((row, index) => {
			if (row.removed) return;
			if (row.mode === "extract") { try { extractionPages(row.ranges, row.pages ?? 0); pdfOutputName(row.name); if (row.error) throw new Error(row.error); } catch (error) { invalid[index] = (error as Error).message; } }
			selections.push({ index, mode: row.mode, ranges: row.ranges, name: row.name });
		});
		setErrors(invalid); if (Object.keys(invalid).length || !selections.length) return;
		setBusy(true); setFailure("");
		try {
			if (!callbacks.current.valid()) throw new Error("The original composer changed or closed. Nothing was attached.");
			const preparation = await (await pdfRequest(id, "prepare", { selections }, controller.current.signal)).json();
			if (closed.current) return;
			if (Object.keys(preparation).length) { setErrors(preparation); return; }
			if (!callbacks.current.valid()) throw new Error("The original composer changed or closed. Nothing was attached.");
			finalizingRef.current = true; setFinalizing(true);
			const results: string[] = await (await pdfRequest(id, "commit", { selections })).json();
			finalized.current = true;
			if (callbacks.current.valid()) callbacks.current.onApply(results);
			else callbacks.current.onNotice("The original composer closed before insertion. Nothing was attached; saved extracts remain in app storage.");
			closed.current = true; callbacks.current.onClose();
		} catch (error) { if (!closed.current) setFailure((error as Error).message); }
		finally { finalizingRef.current = false; setFinalizing(false); setBusy(false); }
	}
	let summary = "";
	if (current?.mode === "extract") { try { const pages = extractionPages(current.ranges, current.pages ?? 0); summary = `${pageRanges(pages)} (${pages.length} pages)`; } catch { /* Validation appears on Apply. */ } }
	return createPortal(<div className="fixed inset-0 z-[65] flex items-center justify-center bg-background/80 p-4" onMouseDown={e => { if (e.target === e.currentTarget) cancel(); }}>
		<div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Attach PDF pages" className="flex max-h-[90vh] w-[64rem] max-w-full flex-col overflow-hidden rounded-xl border bg-card p-4 shadow-xl" onDrop={e => { e.preventDefault(); e.stopPropagation(); }}>
			<h2 className="font-semibold">Attach PDF pages</h2>
			<p className="my-2 text-xs text-muted-foreground">Choose whole PDFs or extract physical PDF pages (not printed page numbers). Limits: 100 MB and 2,000 pages per source.</p>
			<div className="grid min-h-0 flex-1 gap-4 overflow-auto md:grid-cols-[18rem_1fr]">
				<div className="space-y-3">{rows.map((row, index) => !row.removed && <div key={index} className="rounded border p-2">
					<button type="button" className="max-w-full break-all text-left text-sm underline" onClick={() => { setSelected(index); setPage(1); setZoom(100); }}>{row.path.split(/[/\\]/).pop()}</button>
					{row.pdf && <>
						<p className="text-xs">{row.pages ? `${row.pages} PDF pages` : loading ? "Inspecting…" : "Page count unavailable"}</p>
						<label className="block text-xs">Attachment<select className={field} disabled={busy} value={row.mode} onChange={e => update(index, { mode: e.target.value as Row["mode"] })}><option value="whole">Whole PDF</option><option value="extract" disabled={loading || !!row.error}>Extract pages</option></select></label>
						{row.mode === "extract" && <>
							<label className="block text-xs">PDF pages<input className={field} disabled={busy} placeholder="3–8, 12" value={row.ranges} onChange={e => update(index, { ranges: e.target.value })} /></label>
							<label className="block text-xs">Output filename<input className={field} disabled={busy} value={row.name} onChange={e => update(index, { name: e.target.value, edited: true })} /></label>
						</>}
					</>}
					{(row.error || errors[index]) && <p role="alert" className="text-xs text-destructive">{errors[index] || row.error}</p>}
					<button type="button" className="mt-1 block text-xs underline" disabled={busy} onClick={() => update(index, { removed: true })}>Remove from batch</button>
				</div>)}</div>
				<div className="min-w-0">
					{current?.pdf && !current.removed && <>
						<div className="mb-2 flex flex-wrap items-center gap-2">
							<button className={button} disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button>
							<label className="text-xs">PDF page <input aria-label="Preview PDF page" className="w-16 rounded border bg-background p-1" type="number" min={1} max={current.pages ?? 1} value={page} onChange={e => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 1 && n <= (current.pages ?? 1)) setPage(n); }} /></label>
							<button className={button} disabled={page >= (current.pages ?? 1)} onClick={() => setPage(p => p + 1)}>Next</button>
							<button className={button} disabled={zoom <= 50} onClick={() => setZoom(z => z - 25)}>−</button><span className="text-xs">{zoom}%</span><button className={button} disabled={zoom >= 200} onClick={() => setZoom(z => z + 25)}>+</button>
							<button className={button} onClick={() => setZoom(100)}>Fit width</button>
						</div>
						<div className="h-[48vh] overflow-auto rounded border bg-muted p-2">
							{image ? <div style={{ width: `${zoom}%` }}>{/* Private blob URL: Next image optimization must not fetch it. */}
								{/* eslint-disable-next-line @next/next/no-img-element */}
								<img src={image} alt={`PDF page ${page}`} className="w-full max-w-none" /></div> : <p role="status" className="text-sm">{previewError || current.error || (loading ? "Inspecting PDF…" : "Loading preview…")}</p>}
						</div>
						{summary && <p className="mt-2 text-xs">Extract: {summary}</p>}
					</>}
				</div>
			</div>
			<p className="mt-3 text-xs text-muted-foreground">Extracts are saved in app data → pdf-extracts, shared across sessions and kept until manually deleted. That dedicated folder is agent-readable even with folder restrictions. Cancel removes temporary extracts, not existing shared files. Extracted numbering starts at 1.</p>
			{failure && <p role="alert" className="mt-2 text-sm text-destructive">{failure}</p>}
			<div className="mt-3 flex justify-end gap-2"><button className={button} disabled={finalizing} onClick={cancel}>Cancel</button><button className={button} disabled={loading || busy || rows.every(row => row.removed)} onClick={() => { void apply(); }}>{finalizing ? "Saving…" : busy ? "Extracting…" : Object.keys(errors).length ? "Retry / Apply" : "Apply"}</button></div>
		</div>
	</div>, document.body);
}
