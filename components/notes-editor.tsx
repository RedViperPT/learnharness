"use client";

import { useLayoutEffect, useRef } from "react";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, isolateHistory } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { useNotesSnapshot, useNotesStore, type NotesStateStore } from "./notes-state";

type EditorMemory = { state: EditorState; readOnly: Compartment; scrollTop: number; focusSequence: number; replacement: number };
const memory = new WeakMap<NotesStateStore, EditorMemory>();

export function NotesEditor({ visible }: { visible: boolean }) {
	const store = useNotesStore();
	const snapshot = useNotesSnapshot();
	const host = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	const readOnly = useRef<Compartment | null>(null);
	const focusSequence = useRef(0);
	const replacement = useRef(snapshot.replacement);
	useLayoutEffect(() => {
		if (!host.current || !store) return;
		const saved = memory.get(store);
		const compartment = saved?.readOnly ?? new Compartment();
		readOnly.current = compartment;
		focusSequence.current = saved?.focusSequence ?? 0;
		// Apply can finish while this view is hidden/unmounted. Its replacement
		// must still become one undoable transaction when the cached editor returns.
		replacement.current = saved?.replacement ?? store.getSnapshot().replacement;
		const state = saved?.state ?? EditorState.create({
			doc: store.getSnapshot().markdown,
			extensions: [
				history(), markdown(), lineNumbers(), drawSelection(), highlightActiveLine(), syntaxHighlighting(defaultHighlightStyle),
				keymap.of([...defaultKeymap, ...historyKeymap]), EditorView.lineWrapping,
				compartment.of([EditorState.readOnly.of(store.getSnapshot().applying), EditorView.editable.of(!store.getSnapshot().applying)]),
				EditorView.contentAttributes.of({ "aria-label": "Session notes", "data-testid": "notes-editor-input", spellcheck: "true" }),
				EditorView.updateListener.of((update) => { if (update.docChanged) store.edit(update.state.doc.toString()); }),
				EditorView.theme({
					"&": { height: "100%", color: "var(--foreground)", backgroundColor: "var(--background)" },
					".cm-scroller": { overflow: "auto", fontFamily: "var(--font-jetbrains), monospace", fontSize: "0.875rem" },
					".cm-content": { padding: "0.75rem 0" },
					".cm-gutters": { backgroundColor: "var(--background)", color: "var(--muted-foreground)", border: "none" },
					".cm-cursor": { borderLeftColor: "var(--foreground)" },
					"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--accent) !important" },
					"&.cm-focused": { outline: "none" },
					".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--muted) 25%, transparent)" },
				}, { dark: true }),
			],
		});
		const editor = new EditorView({ state, parent: host.current });
		view.current = editor;
		if (saved) editor.scrollDOM.scrollTop = saved.scrollTop;
		return () => {
			memory.set(store, { state: editor.state, readOnly: compartment, scrollTop: editor.scrollDOM.scrollTop, focusSequence: focusSequence.current, replacement: replacement.current });
			editor.destroy(); view.current = null;
		};
	}, [store]);
	useLayoutEffect(() => {
		const editor = view.current;
		if (!editor || !readOnly.current) return;
		const isApply = replacement.current !== snapshot.replacement;
		replacement.current = snapshot.replacement;
		const focus = snapshot.focus;
		const newFocus = !!focus && focus.sequence !== focusSequence.current;
		const changed = editor.state.doc.toString() !== snapshot.markdown;
		editor.dispatch({
			...(changed ? { changes: { from: 0, to: editor.state.doc.length, insert: snapshot.markdown } } : {}),
			...(newFocus ? { selection: { anchor: focus.from, head: focus.to }, scrollIntoView: true } : {}),
			effects: readOnly.current.reconfigure([EditorState.readOnly.of(snapshot.applying), EditorView.editable.of(!snapshot.applying)]),
			annotations: [Transaction.addToHistory.of(isApply || newFocus), ...(isApply || newFocus ? [isolateHistory.of("full")] : [])],
		});
		if (newFocus) { focusSequence.current = focus.sequence; editor.focus(); }
		if (visible) editor.requestMeasure();
	}, [snapshot.markdown, snapshot.applying, snapshot.replacement, snapshot.focus, visible]);
	return <div ref={host} className="h-full min-h-0 min-w-0" />;
}
