# Desktop PDF page extraction

Pick or drop PDFs through the existing desktop attachment flow. One dialog stages the whole selection, including any accompanying non-PDF files. Every PDF defaults to **Whole PDF**. Choose **Extract pages**, enter physical 1-based page positions (`3–8, 12`), and optionally edit the proposed filename. Invalid ranges are rejected, not clamped. Repeated pages are deduplicated and output follows original document order.

The one-page preview has previous/next, page jump, fit-width and 50–200% zoom. It is a rendered image, not a searchable or annotatable PDF viewer. A preview failure does not prevent extraction if the document was successfully inspected. Encrypted or malformed PDFs can be explicitly attached whole or removed from the batch; no password-unlocking UI is provided. Sources over 100,000,000 bytes or 2,000 pages can still be attached whole.

Apply attaches the complete remaining batch once, to the original composer. It never sends the message. If a file fails, resolve/retry/remove it or explicitly select Whole PDF; no successful item is inserted early. A changed or closed destination does not redirect files into another chat.

## Storage and cancellation

Original files are never modified. Outputs live under `PATHS.data/pdf-extracts/<output-sha256>/<filename>.pdf`, respecting `LH_DATA_DIR` in development and the desktop user-data location in packaged apps. Identical output bytes and filenames reuse the same file. Choosing a different name makes another copy. Existing different content is never overwritten.

Published extracts are shared, not session-owned, and are retained until manually deleted. Deleting one manually can break any chat path referencing it. The dedicated published directory is added to optional agent-readable folders, **not** the whole app-data directory. Anything manually placed in that directory receives the same optional-folder allowance. Mandatory sensitive-path restrictions and canonical/symlink checks still apply. Original source files must pass current source-access checks.

New output is prepared in private `pdf-extraction-staging`, outside the agent-readable published folder; the shared source guard also explicitly denies staging. Cancel closes the dialog immediately and cleans the batch's scratch files after any active write/render finishes. It never deletes existing shared files. Final publication briefly disables dismissal. Packaged desktop startup removes abandoned staging before starting its owned server; it never sweeps published files. Externally managed `desktop:dev` servers do not receive an Electron startup sweep; their abandoned staging can be removed after stopping that server.

Extraction renumbers output pages starting at 1. Generated filenames preserve original positions, but there is no automatic citation remapping, verified citation system, source-only teaching mode, OCR, or redaction guarantee.

## Implementation and checks

`src/server/pdf-extraction.ts` owns opaque runtime batches, source checks, PDF inspection, preparation, rendering and publication. `pdf-lib` copies pages; existing PDF.js/native canvas rendering supplies private single-page PNG previews. `app/api/pdf-extractions/route.ts` validates bounded JSON requests behind the existing desktop API gate and same-addressed-origin checks. It exposes no arbitrary write destination or generic raw-file endpoint. Browser-only UI remains path-attachment-disabled; externally launched development servers retain the repository's existing shared local API trust model.

The browser receives images and output paths, never an Electron filesystem read/write bridge. The feature uses no provider/model or cloud service. `components/attachment-batch.tsx` captures the destination; picker and drop both stage PDF-containing acquisitions there. `components/pdf-extraction-dialog.tsx` owns the modal and selection controls.

Run focused tests with:

```
node --import ./scripts/test-environment.mjs --import tsx --test tests/pdf-extraction.test.ts tests/pdf-extraction-ui.test.tsx tests/composer-attach.test.tsx tests/file-path-drop-zone.test.tsx tests/source-access.test.ts
node scripts/smoke-pdf-extraction.mjs
node scripts/smoke-pdf-production.mjs <isolated-build>/.next/standalone/server.js
```

The smoke script uses isolated synthetic app data and a real local Next server/native PDF renderer in Chrome or Edge. It mocks only the Electron path bridge and model catalog; it is not an installed-desktop test. Set `CHROME_PATH` if a browser is not at the script's default Windows paths. Check production build tracing without copying local learner records or profiling exports into a distributable; existing runtime/packaging safety gates still apply.

The production smoke launches the traced standalone server with a fresh data directory and desktop API capability, checks unauthenticated rejection, and exercises inspection, native PNG rendering, selected-page output, and runtime data relocation. It does not create an installer or validate a signed installed desktop binary.
