# Session notes

Every teaching and practice session has one optional Markdown document. Open **Notes** in the top bar. Notes and Side Questions share the secondary column (an overlay in narrow windows); switching panels keeps their session-local state.

## Writing and saving

**Write** uses CodeMirror 6 with Markdown source, selection, and undo/redo. **Preview** uses the same Markdown, KaTeX, code, tables, callouts, and Mermaid renderer as lessons. Select settled teacher text and choose **Add to notes** to append a blockquote with captured TeX. Appending never replaces learner text or repairs an unfinished code/math block; an unfinished block can affect how the quotation renders.

Autosave runs 600 ms after an edit. Only one write is in flight, and edits made during that write are saved next using its confirmed revision. **Only confirmed saves are durable across reload/restart**; pending/failed edits can be lost. Closing the panel flushes pending changes without destroying local state. Session navigation flushes first; failure offers retry, staying to resolve the problem, or explicitly leaving without saving. Native reload/close warns about pending edits when the browser supports it, but cannot guarantee a final save.

On a revision conflict autosave pauses and retains local text. Choose **Keep server version** or **Keep my version**. Keeping your version uses the observed server revision in a fresh compare-and-set; another intervening write can conflict again. Panel open/window focus and Apply revalidate canonical notes; there is no live cross-window note-change subscription.

The document limit is 512 KiB of UTF-8 Markdown. Oversized documents are rejected, never truncated. Saving notes does not change lesson activity timestamps, sidebar ordering, or emit `chats-changed`.

## One-click organization

**Organize** makes one explicitly requested, tool-less model call. It applies a fixed policy: clean up structure, group by topic, collect existing formulas in a reference section while preserving context, and merge only clear duplicates. There is no free-form instruction box or condensation mode in v1.

The organizer sees only its fixed instructions and the frozen notes snapshot as document data. It must preserve substantive content, quotations, code, TeX, unresolved questions, and uncertainty. It must not add equations, explanations, facts, examples, or silently correct the learner. These are model instructions, not a provable preservation guarantee: **inspect the proposal before applying it**.

The organizer resolves the `noteOrganizer` role override, then the **Cheap** slot, then refuses if neither is configured. It never falls back to Strong. Reported usage contributes to session cost even for discarded, failed, or stopped proposals. One request per session may run server-side, independently of the teacher turn; different sessions may organize concurrently.

Compare the frozen **Original snapshot** with **Proposed**, using Rendered/Source controls. Narrow panels use Original/Proposed tabs even on desktop; panels at least 42rem wide show both panes. Notes remain editable via Write during generation/preview. Any local edit immediately and permanently stales that proposal, even if the learner undoes the edit before autosave. External revision changes also stale it when detected. No force-Apply exists.

**Apply** revalidates and briefly locks editing while performing an atomic revision-guarded PUT. Successful replacement is one editor undo transaction; undo becomes a normal edit and autosaves. Discard never changes saved notes. Try again runs a fresh paid request against current confirmed notes. Stop aborts generation; partial, empty, oversized, or output-token-truncated proposals cannot be applied. Outer fences are never automatically removed.

Generation and proposals survive panel hiding and in-app session navigation in client memory, but need not survive reload/restart. A disconnected/aborted request can leave reported usage without a recoverable proposal; no automatic model retry occurs.

## Privacy and storage

Notes never enter teacher/practice/prober messages, side questions, extraction, graph coverage, compaction, lesson export, or ordinary chat resync payloads. Only explicitly invoking Organize sends the frozen snapshot to that model/provider. The organizer cannot save notes, access lesson tools, or research.

Notes are an additive optional `ChatRecord.notes` field, with their own `updatedAt` and monotonically increasing revision. No schema version bump or migration is required. Missing notes read as empty Markdown, revision 0, and null update time. GET/PUT `/api/chats/:id/notes` own document synchronization; POST `/api/chats/:id/notes/organize` owns proposal streaming. Usage has kind `notes-organize`; `notes-organizer-settled` refreshes only session accounting, never a teacher turn.

### One writer process per data directory

The JSON adapter supports **one server writer process per chat directory**, including all transcript, notes, side-chat, image, settings, and usage writes. Reads do not acquire a writer claim or modify files. Synchronous compare-and-set is atomic within that process, not a distributed transaction. Multiple browser windows connected to that process are supported through revision conflicts.

The first mutation claims `chats/.writer/<pid>` using an exclusive directory creation. Another live process is refused before reading/modifying records. Normal process exit releases its claim; a clearly dead PID is reclaimed. An empty/unreadable claim fails closed: stop every server using that data directory before manually removing a leftover claim. Do not run development and production servers against the same mutable directory.

## Verification

`npm test` uses `scripts/test-environment.mjs` to give each test worker its own fallback data/auth directory before static imports. Tests can still provide explicit isolated fixtures. This also works on Windows without shell-specific environment assignment.

`node scripts/verify-session-notes.mjs <disposable-server-url>` exercises the real CodeMirror/browser flow with mocked organizer transport. Run the server with an isolated `LH_DATA_DIR` and no credentials; the script creates test sessions. Set `CHROME_PATH` to a Chrome executable on non-default installations. It does not purchase model calls.
