# AGENTS.md — PDF Editor

Instructions for coding agents (OpenAI Codex, Claude Code and others) working in this repository.

## What this is
A private PDF editor that runs entirely on the user's device. One TypeScript codebase ships as:
- **Web app:** `npm run build` produces a single self-contained `dist/index.html` (fonts, PDF.js worker and HarfBuzz WebAssembly are all inlined). It must keep working when opened as a local file and inside a sandboxed iframe.
- **Desktop app:** Electron shell in `desktop/` that loads the same `index.html` over an `app://` scheme.

Owner: Waqas Ahmad (TEKDIGIX). Users are students, teachers and office staff in Pakistan, so **Urdu support matters**.

## Commands
| Task | Command |
| --- | --- |
| Install | `npm ci` |
| Dev server | `npm run dev` (http://localhost:5173) |
| Type check | `npm run typecheck` |
| Build web app | `npm run build` → `dist/index.html` |
| All browser tests | `npm test` (builds, then runs `tests/*.py` with Python Playwright) |
| One test | `npm run build && cd tests && python3 editpdf.py` |
| Desktop (local only) | `cd desktop && npm ci && npm start` |
| Windows installer | `cd desktop && npm run dist:win` (run on Windows) |

Test dependencies: `pip install -r tests/requirements.txt && python3 -m playwright install --with-deps chromium`. In Codex cloud, `scripts/codex-setup.sh` does all of this.

**Before finishing any change:** `npm run typecheck` must be clean and `npm test` must print `ALL TESTS PASSED`. Add or extend a test in `tests/` for every new feature or bug fix.

## Architecture
```
src/main.ts               loads Urdu fonts, starts the app
src/core/                 NO UI CODE HERE (no DOM except canvas/fonts helpers)
  model.ts                PageRef list + annotations + objEdits; DocStore with snapshot undo/redo
  render.ts               PDF.js loading/rendering; edited pages render from a rebuilt one-page PDF
  export.ts               pdf-lib writer: copies pages, applies objEdits, flattens annotations
  fonts.ts                font list, line metrics, bundled Urdu fonts (Noto Nastaliq Urdu, Noto Naskh Arabic)
  urdu-text.ts            HarfBuzz shaping + bidi-js + CID font embedding (ToUnicode + ActualText)
  content/                Edit PDF engine for content already in a PDF
    lexer.ts              content-stream tokenizer, keeps byte offsets
    fontinfo.ts           widths, ToUnicode decoding, re-encoding new text in the original font
    analyze.ts            replays the stream: text segments, images/forms, shapes + their drawing state
    rewrite.ts            hide / move / resize / re-word objects; untouched bytes copied as-is
    index.ts              public API: analyzePage, applyObjEdits, editedTextWidth
src/platform/index.ts     file open/save: browser (input/download or claude.ai downloads capability) vs Electron bridge
src/ui/                   app.ts (toolbar, sidebar, dialogs), viewer.ts (pages + SVG annotation layer),
                          editmode.ts (Edit PDF mode), signature.ts, dialogs.ts, icons.ts
desktop/                  main.js, preload.js (contextIsolation on, nodeIntegration off), packaging config
tests/                    Python Playwright tests + fixtures/ (Word/LibreOffice, Chrome, ReportLab, scanned, rotated, encrypted PDFs)
```

## Key rules (do not break)
1. **Coordinates:** all model positions are PDF points from the **top-left of the unrotated crop box**. Convert to PDF space only in export (`y_pdf = top - y`). Page rotation is display-only (CSS) plus `/Rotate` on export.
2. **Screen = file.** Anything drawn on screen must be written the same way in the PDF. Text metrics live in `METRICS` (`fonts.ts`) and are shared by viewer and exporter.
3. **Undo:** every change goes through `store.apply()` (or `checkpoint()` + `changed()`). Never mutate `store.pages` without a checkpoint.
4. **Edit PDF engine:** removed text is replaced by a blank `[-n] TJ` with the same advance (so later text does not move). Objects are identified by command index (`T<op>`, `I<op>`, `S<op>`), which must stay deterministic for the same content bytes.
5. **Urdu:** shaping must go through HarfBuzz (`urdu-text.ts`). pdf-lib's fontkit hangs on Nastaliq — never use `font.layout`/`encodeText` for Urdu fonts. Existing fonts' glyph maps cannot shape Arabic script, so Urdu replacement text always uses the bundled fonts.
6. **Single file build:** no runtime network requests. Fonts/wasm are imported with `?base64` (custom Vite plugin in `vite.config.ts`). `scripts/escape-replacement-char.js` must keep running after build (some hosts reject a literal U+FFFD).
7. **Sandbox-safe UI:** no `alert/confirm/prompt`, no `window.open`; use `ui/dialogs.ts`.
8. **Privacy:** never upload or log document content.
9. Keep `core/` free of UI imports; keep Electron code inside `desktop/` and `platform/`.

## Style
- TypeScript, ES2022, `strict: false` but write typed code; 2-space indent; small focused modules.
- UI text in simple English (users are not technical). Toasts explain what happened and how to undo.
- Comments explain *why*, not *what*.

## Known limits (good next tasks)
- Edit PDF is line-level: no paragraph re-wrap.
- Scanned pages need OCR (candidate: Tesseract.js with an Urdu model) before their text is editable.
- Form XObject content moves as one block; encrypted PDFs cannot be rewritten (pdf-lib cannot decrypt).
- Not yet built: AcroForm filling, compression, adding a password.
- Planning docs: `docs/` (PRD, architecture, build notes).
