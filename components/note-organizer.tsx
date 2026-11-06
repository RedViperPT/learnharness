"use client";

import { MessageResponse } from "./ai-elements/message";
import { Button } from "./ui/button";
import { useNotesSnapshot, useNotesStore } from "./notes-state";

export function NoteOrganizer() {
	const store = useNotesStore();
	const state = useNotesSnapshot();
	const proposal = state.organizer;
	const source = state.organizerSource;
	const tab = state.comparisonTab;
	if (!store || !proposal) return null;
	const busy = state.preparing || proposal.generating;
	const pane = (label: string, text: string, shown: boolean) => <section className={`min-h-0 min-w-0 flex-1 flex-col ${shown ? "flex" : "hidden @2xl:flex"}`}>
		<h3 className="shrink-0 px-3 py-2 font-ui text-xs text-muted-foreground">{label}</h3>
		<div className="min-h-0 flex-1 overflow-auto overscroll-contain px-3 pb-3" tabIndex={0} aria-label={label}>
			{source ? <pre className="whitespace-pre-wrap break-words font-mono text-sm">{text}</pre> : <MessageResponse isAnimating={proposal.generating && label === "Proposed"}>{text}</MessageResponse>}
		</div>
	</section>;
	return <div className="@container flex min-h-0 flex-1 flex-col" data-testid="note-organizer">
		<div className="flex shrink-0 flex-wrap items-center gap-1 px-3 py-2 font-ui">
			<strong className="mr-auto text-xs">Notes organizer</strong>
			<Button size="sm" variant={!source ? "secondary" : "ghost"} aria-pressed={!source} onClick={() => store.setOrganizerSource(false)}>Rendered</Button>
			<Button size="sm" variant={source ? "secondary" : "ghost"} aria-pressed={source} onClick={() => store.setOrganizerSource(true)}>Source</Button>
		</div>
		<div className="flex shrink-0 gap-1 px-3 @2xl:hidden">
			<Button size="sm" variant={tab === "original" ? "secondary" : "ghost"} aria-pressed={tab === "original"} onClick={() => store.setComparisonTab("original")}>Original snapshot</Button>
			<Button size="sm" variant={tab === "proposed" ? "secondary" : "ghost"} aria-pressed={tab === "proposed"} onClick={() => store.setComparisonTab("proposed")}>Proposed</Button>
		</div>
		<div className="flex min-h-0 flex-1 @2xl:divide-x @2xl:divide-border">
			{pane("Original snapshot", proposal.original, tab === "original")}
			{pane("Proposed", proposal.markdown, tab === "proposed")}
		</div>
		<div className="shrink-0 space-y-2 border-t border-border p-3 font-ui text-xs">
			{proposal.model && <p className="break-all text-muted-foreground">{proposal.model}</p>}
			{proposal.generating && <p role="status">Organizing… Saved notes are unchanged.</p>}
			{proposal.error && <p role="alert" className="text-destructive">{proposal.error}</p>}
			{proposal.stale && <p role="status" className="text-muted-foreground">Your notes changed after this proposal was created. Organize the latest version again before applying it.</p>}
			<p className="text-muted-foreground">Check the proposal: AI may omit or change content. Only Apply replaces your notes.</p>
			<div className="flex flex-wrap justify-end gap-2">
				{busy ? <Button size="sm" variant="secondary" onClick={() => store.stop()}>Stop</Button> : <>
					<Button size="sm" variant="ghost" disabled={state.applying} onClick={() => store.discardProposal()}>Discard</Button>
					<Button size="sm" variant="outline" disabled={state.applying || !!state.conflict} onClick={() => void store.organize()}>Try again</Button>
					<Button size="sm" data-testid="notes-apply" disabled={!proposal.complete || proposal.stale || state.dirty || !!state.conflict || state.applying} onClick={() => void store.apply()}>{state.applying ? "Applying…" : "Apply"}</Button>
				</>}
			</div>
			<p className="text-muted-foreground">Each organization request uses the selected model and is included in session usage, even if discarded.</p>
		</div>
	</div>;
}
