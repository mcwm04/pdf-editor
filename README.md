# PDF Editor

A private PDF editor that runs fully on the user's device. One codebase ships as a **web app** (a single `index.html`) and a **desktop app** (Electron, Windows/macOS/Linux).

## Features (v1)
- Open, view, zoom, page thumbnails, drag-and-drop files
- Add text (font, size, colour, bold/italic), highlight, freehand draw, rectangle, ellipse, line, arrow, whiteout
- Insert images; signatures (draw, type or upload), saved for reuse
- Select, move, resize, restyle, delete; undo/redo (200 steps)
- Pages: add blank, rotate, delete, drag to reorder, insert pages from another PDF
- Merge several PDFs; split by ranges or every N pages (ZIP)
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
src/platform/   file open/save: browser version and Electron version
src/ui/         app.ts (toolbar, sidebar, dialogs), viewer.ts (pages + edit layer), signature.ts
desktop/        Electron shell: main.js, preload.js, packaging config
tests/e2e.py    Playwright end-to-end test (open, annotate, pages, merge, split, password, export)
tests/urdu.py   Urdu typing, font switching, mixed Urdu/English, export
```
`core/` never imports UI code; edits are stored as JSON in PDF points and only written into the PDF on export.

## Known limits
- Edits are added on top of the page. The PDF's original words cannot be changed; use Whiteout + Text instead.
- Bold and italic: Urdu fonts have bold but no italic.
- In hosts that block WebAssembly, Urdu text is saved as a sharp image (not selectable); the app says so when it happens.
- Form filling, compression, adding passwords and OCR are planned for v2/v3.

## Fonts
Noto Nastaliq Urdu and Noto Naskh Arabic (SIL Open Font License, see `src/assets/fonts/OFL.txt`) are bundled so the screen and the PDF use the same files.
