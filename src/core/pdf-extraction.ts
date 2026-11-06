export const MAX_PDF_BYTES = 100_000_000;
export const MAX_PDF_PAGES = 2_000;

/** Physical positions only. Unlike the agent's permissive page spec, never clamp. */
export function extractionPages(spec: string, total: number): number[] {
	if (!Number.isInteger(total) || total < 1 || total > MAX_PDF_PAGES) throw new Error("PDF exceeds the 2,000-page extraction limit.");
	if (spec.length > 20_000) throw new Error("Page selection is too long.");
	const pages = new Set<number>();
	for (const part of spec.split(",")) {
		const match = /^\s*(\d+)\s*(?:[-–]\s*(\d+)\s*)?$/.exec(part);
		if (!match) throw new Error("Enter PDF pages such as 3–8, 12.");
		const start = Number(match[1]), end = Number(match[2] ?? match[1]);
		if (start < 1 || end > total || start > end || !Number.isSafeInteger(end)) throw new Error(`PDF pages must be between 1 and ${total}, in ascending ranges.`);
		for (let page = start; page <= end; page++) pages.add(page);
	}
	return [...pages].sort((a, b) => a - b);
}

export function pageRanges(pages: number[]): string {
	const ranges: string[] = [];
	for (let i = 0; i < pages.length; i++) {
		const start = pages[i]!;
		let end = start;
		while (pages[i + 1] === end + 1) end = pages[++i]!;
		ranges.push(start === end ? `${start}` : `${start}–${end}`);
	}
	return ranges.join(", ");
}

export function pdfOutputName(value: string): string {
	const name = /\.pdf$/i.test(value) ? value : `${value}.pdf`;
	if (!value.trim() || value !== value.trim() || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]\.pdf$/i.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || name.length > 160) {
		throw new Error("Choose a filename of up to 160 characters without path separators, reserved names, or invalid filename characters.");
	}
	return name;
}

export function defaultPdfName(source: string, pages: number[]): string {
	const stem = source.split(/[/\\]/).pop()!.replace(/\.pdf$/i, "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 70) || "PDF";
	const ranges = pageRanges(pages);
	return `${stem} — PDF pages ${ranges.length <= 60 ? ranges : `${pages.length} selected pages`}.pdf`;
}

export interface PdfBatchItem { path: string; pdf: boolean }
export interface PdfInspection { pages?: number; error?: string }
export type PdfSelection = { index: number; mode: "whole" | "extract"; ranges?: string; name?: string };
