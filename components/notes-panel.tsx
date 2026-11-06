"use client";

import { useEffect } from "react";
import { XIcon } from "lucide-react";
import { Button } from "./ui/button";
import { MessageResponse } from "./ai-elements/message";
import { SessionSecondaryPanel } from "./session-secondary-panel";
import { useSessionPanel } from "./session-panel-state";
import { useNotesSnapshot, useNotesStore } from "./notes-state";
import { NotesEditor } from "./notes-editor";
import { NoteOrganizer } from "./note-organizer";

export function NotesPanel({ chatId, obscured = false }: { chatId: string; obscured?: boolean }) {
	const panel = useSessionPanel(chatId);
	const store = useNotesStore();
	const state = useNotesSnapshot();
	const open = panel === "notes";
	useEffect(() => {
		if (!store || !open) return;
		void store.refresh();
		const focus = () => { void store.refresh(); };
		window.addEventListener("focus", focus);
		return () => { window.removeEventListener("focus", focus); void store.flush(); };
	}, [store, open]);
	if (!store || !open) return null;
	return <SessionSecondaryPanel chatId={chatId} id={`notes-panel-${chatId}`} label="Notes" testId="notes-panel" obscured={obscured} onEscape={() => store.close()}>
		<header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-3 font-ui">
			<strong className="mr-auto text-sm uppercase">Notes</strong>
			<Button size="sm" variant="ghost" data-testid="notes-organize" title="Organize structure, group topics, collect existing formulas, and merge clear duplicates. Uses a model call."
				disabled={!state.loaded || !state.markdown.trim() || state.preparing || state.organizer?.generating || state.applying || !!state.conflict} onClick={() => void store.organize()}>Organize</Button>
			<Button size="icon-sm" variant="ghost" aria-label="Close notes" onClick={() => store.close()}><XIcon /></Button>
		</header>
		<div className="flex shrink-0 flex-wrap items-center gap-1 px-3 py-2 font-ui text-xs">
			<Button size="sm" variant={state.mode === "write" ? "secondary" : "ghost"} aria-pressed={state.mode === "write"} onClick={() => store.setMode("write")}>Write</Button>
			<Button size="sm" variant={state.mode === "preview" ? "secondary" : "ghost"} aria-pressed={state.mode === "preview"} onClick={() => store.setMode("preview")}>Preview</Button>
			{state.organizer && <Button size="sm" variant={state.mode === "organizer" ? "secondary" : "ghost"} aria-pressed={state.mode === "organizer"} onClick={() => store.setMode("organizer")}>Proposal</Button>}
			<span className="ml-auto text-muted-foreground" role="status">{state.saving ? "Saving…" : state.dirty ? "Unsaved" : state.loaded ? "Saved" : "Loading…"}</span>
		</div>
		<p className="shrink-0 px-3 pb-2 font-ui text-xs text-muted-foreground">Private workspace. Only Organize sends notes to its model. Only confirmed saves survive restart.</p>
		{state.conflict && <div role="alert" className="shrink-0 border-y border-border p-3 font-ui text-xs">
			<p>The server has newer notes. Autosave is paused; your local text is kept.</p>
			<div className="mt-2 flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={state.applying} onClick={() => store.keepServer()}>Keep server version</Button><Button size="sm" variant="outline" disabled={state.applying} onClick={() => void store.keepMine()}>Keep my version</Button></div>
		</div>}
		{state.error && <div role="alert" className="shrink-0 px-3 py-2 font-ui text-xs text-destructive">{state.error} {state.errorAction && <Button size="sm" variant="ghost" disabled={state.applying || !!state.conflict} onClick={() => void store.retry()}>Retry</Button>}</div>}
		{state.loaded && <div className={state.mode === "write" ? "min-h-0 flex-1" : "hidden"} aria-hidden={state.mode !== "write"}><NotesEditor visible={state.mode === "write"} /></div>}
		{state.mode === "preview" && <div className="min-h-0 flex-1 overflow-auto overscroll-contain p-3"><MessageResponse>{state.markdown}</MessageResponse></div>}
		{state.mode === "organizer" && <NoteOrganizer />}
	</SessionSecondaryPanel>;
}
