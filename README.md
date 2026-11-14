# PDF Editor

A private PDF editor that runs fully on the user's device. One codebase ships as a **web app** (a single `index.html`) and a **desktop app** (Electron, Windows/macOS/Linux).

## Features (v1)
- Open, view, zoom, page thumbnails, drag-and-drop files
- Add text (font, size, colour, bold/italic; the font list also shows the fonts already used in the open PDF), highlight, freehand draw, rectangle, ellipse, line, arrow, whiteout
- Insert images; signatures (draw, type or upload), saved for reuse
- Select, move, resize, restyle, delete; undo/redo (200 steps)
- Pages: add blank, rotate, delete, drag to reorder, insert pages from another PDF
- Merge several PDFs; split by ranges or every N pages (ZIP)
- **Edit PDF mode** (Edit PDF tool, key X): change existing text line by line, move/resize/delete existing text, images and shapes. The page's own content is rewritten (no white boxes); edited text keeps the original font when it has every letter, otherwise the closest standard font
- Urdu text: Nastaliq and Naskh fonts built in, right-to-left layout, mixed Urdu/English lines; saved as real, selectable text
- Password-protected PDFs (opens with password; saved copy has no password)
- Download a real, flattened PDF (pdf-lib)

## Run it
```bash
npm install
npm run dev        # web app at http://localhost:5173
npm run build      # dist/index.html: one self-contained file, works offline
```

### Desktop
```bash
npm run build
cd desktop && npm install
npm start                 # run the desktop app
npm run dist:win          # Windows installer (run on Windows)
npm run dist:mac          # macOS .dmg (run on a Mac)
npm run dist:linux        # AppImage + .deb
```
Installers for all three systems are built automatically by `.github/workflows/release.yml` when you push a tag like `v1.0.0`.

## Structure
```
src/core/       model.ts (document + undo/redo), render.ts (PDF.js), export.ts (pdf-lib),
                fonts.ts (font list, metrics, bundled Urdu fonts), urdu-text.ts (HarfBuzz shaping + bidi + CID font embedding)
src/core/content/  lexer.ts (content-stream tokenizer), fontinfo.ts (widths, ToUnicode, re-encoding),
                analyze.ts (objects + drawing state), rewrite.ts (hide/move/resize/re-word), index.ts (API)
src/platform/   file open/save: browser version and Electron version
src/ui/         app.ts (toolbar, sidebar, dialogs), viewer.ts (pages + edit layer), signature.ts
desktop/        Electron shell: main.js, preload.js, packaging config
tests/e2e.py    Playwright end-to-end test (open, annotate, pages, merge, split, password, export)
tests/urdu.py   Urdu typing, font switching, mixed Urdu/English, export
tests/editpdf.py, rot.py  Edit PDF mode on LibreOffice, Chrome, ReportLab, scanned and rotated PDFs
```
`core/` never imports UI code; edits are stored as JSON in PDF points and only written into the PDF on export.

## Known limits
- Edit PDF works line by line: a longer line does not re-wrap the paragraph. Scanned pages are images (move/delete only; text needs OCR). Content inside a form XObject moves as one block. Password-protected files cannot be rewritten.
- Bold and italic: Urdu fonts have bold but no italic.
- In hosts that block WebAssembly, Urdu text is saved as a sharp image (not selectable); the app says so when it happens.
- Form filling, compression, adding passwords and OCR are planned for v2/v3.

## Fonts
Noto Nastaliq Urdu and Noto Naskh Arabic (SIL Open Font License, see `src/assets/fonts/OFL.txt`) are bundled so the screen and the PDF use the same files.
