# Build notes / changelog

## Repository setup (2026-11-14)
- Hosted at github.com/mcwm04/pdf-editor for Claude Code: `CLAUDE.md` imports `AGENTS.md`; `scripts/setup.sh` is the cloud environment setup script; `.claude/settings.json` SessionStart hook keeps `node_modules` in sync in cloud sessions; GitHub Actions runs the tests on every push.

## v1.2 — Edit PDF mode (2026-11-14)
- "Edit PDF" tool (key X): select existing text segments, images/forms and shapes; drag to move, corner to resize (images/shapes), Delete removes, double-click/Enter changes a text line.
- Engine in `src/core/content/`: content-stream lexer, interpreter (graphics + text state, font widths, ToUnicode decode/re-encode), rewriter.
- Edits are stored per page as JSON `objEdits` (undoable). Export rewrites the page's own content stream: removed text becomes a blank `[-n] TJ` so later text stays put; moved/edited objects are re-drawn at the end of the page with their saved state.
- Edited text keeps the original font when it has every character, otherwise the closest standard font (Helvetica/Times/Courier, bold/italic kept). Urdu replacement uses the Nastaliq writer, right-aligned to the old line.
- Live preview: edited pages are rebuilt as one-page PDFs and re-rendered, so the screen shows the saved result.
- Decisions: line-level editing (no re-wrap); full-page white background fills are not selectable; outline-only large shapes are picked only near their edge; text segments split on font/size/colour changes.

## v1.1 — Urdu text (2026-11-13)
- Bundled Noto Nastaliq Urdu + Noto Naskh Arabic (regular/bold, OFL) used on screen (FontFace) and in the PDF.
- Typing Urdu switches a text box to Nastaliq; right-to-left boxes grow from the right edge; mixed Urdu/English ordered with bidi-js.
- Export shapes with HarfBuzz (WebAssembly) and embeds a CID font with ToUnicode + ActualText (selectable, searchable). pdf-lib's fontkit hangs on Nastaliq, so HarfBuzz is required. If WebAssembly is blocked, Urdu is saved as a 4x image and the user is told.

## v1.0 — first release (2026-11-13)
- Text, highlight, pen, rectangle, ellipse, line, arrow, whiteout, image, signature (draw/type/upload, saved locally); select/move/resize/restyle/delete; undo/redo.
- Pages: add blank, rotate, delete, drag-reorder, insert from another PDF; merge; split by ranges or every N (ZIP); password-protected PDFs; flattened export.
- Single-file web build; Electron desktop shell (`app://` scheme, single instance, "Open with" .pdf, unsaved-changes prompt); release workflow for installers.
