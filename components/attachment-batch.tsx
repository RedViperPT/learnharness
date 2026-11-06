"use client";

import { useEffect, useState } from "react";
import { capturePrimaryInput } from "./dictation";
import { INSERT_FILE_PATHS_EVENT } from "./path-input";
import { quoteFilePath } from "@/src/core";
import { PdfExtractionDialog } from "./pdf-extraction-dialog";

const EVENT = "lh:pdf-attachment-batch";
type Destination = { valid: () => boolean; insert: (paths: string[]) => void };
type Acquisition = { paths: string[]; destination: Destination | null; accepted: boolean };

/** False means ordinary paths: callers retain their synchronous behavior. */
export function stagePdfAttachments(paths: string[], editor?: HTMLElement | null): boolean {
	if (!paths.some(path => /\.pdf$/i.test(path))) return false;
	const route = window.location?.href;
	const initial = editor?.innerHTML;
	const primary = editor ? null : capturePrimaryInput();
	const destination: Destination | null = editor ? {
		valid: () => editor.isConnected && window.location?.href === route && editor.innerHTML === initial,
		insert: paths => editor.dispatchEvent(new CustomEvent(INSERT_FILE_PATHS_EVENT, { detail: paths })),
	} : primary ? {
		valid: () => window.location?.href === route && primary.valid(),
		insert: paths => primary.insert(paths.map(quoteFilePath).join(" ")),
	} : null;
	const detail: Acquisition = { paths, destination, accepted: false };
	document.dispatchEvent(new CustomEvent(EVENT, { detail }));
	// Never fall through and attach whole PDFs when staging is unavailable.
	return true;
}

export function AttachmentBatchHost() {
	const [batch, setBatch] = useState<Acquisition | null>(null);
	const [notice, setNotice] = useState("");
	useEffect(() => {
		const receive = (event: Event) => {
			const request = (event as CustomEvent<Acquisition>).detail;
			if (batch) { setNotice("Finish or cancel the open PDF selection first."); return; }
			if (!request.destination) { setNotice("Open a chat to attach file paths."); return; }
			request.accepted = true; setBatch(request);
		};
		document.addEventListener(EVENT, receive);
		return () => document.removeEventListener(EVENT, receive);
	}, [batch]);
	return <>
		{batch && <PdfExtractionDialog paths={batch.paths} valid={() => batch.destination!.valid()}
			onApply={paths => batch.destination!.insert(paths)} onClose={() => setBatch(null)} onNotice={setNotice} />}
		{notice && <div role="status" className="fixed bottom-4 left-1/2 z-[70] max-w-[90vw] -translate-x-1/2 rounded-lg border bg-card p-3 text-sm shadow-lg">{notice} <button type="button" onClick={() => setNotice("")}>Dismiss</button></div>}
	</>;
}
