import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import type { Plugin } from 'vite';
import { readFileSync } from 'fs';

// harfbuzzjs loads its .wasm by URL at import time. We ship the .wasm inline instead, so make
// initialisation explicit (__hbInit) and drop the URL lookup (it would duplicate the binary).
const harfbuzzInline = (): Plugin => ({
  name: 'harfbuzz-inline',
  enforce: 'pre',
  // `import x from 'file?base64'` gives the file's bytes as a base64 string (fonts, wasm).
  load(id) {
    if (id.endsWith('?base64')) return `export default ${JSON.stringify(readFileSync(id.slice(0, -7)).toString('base64'))};`;
  },
  transform(code, id) {
    if (/harfbuzzjs[\\/]dist[\\/]index\.mjs$/.test(id)) {
      if (!code.includes('init(await createHarfBuzz());')) this.error('harfbuzzjs changed: update the harfbuzz-inline plugin');
      return code.replace('init(await createHarfBuzz());', 'export async function __hbInit(opts) { init(await createHarfBuzz(opts)); }');
    }
    if (/harfbuzzjs[\\/]dist[\\/]harfbuzz\.js$/.test(id)) {
      return code.replace('new URL("harfbuzz.wasm",import.meta.url).href', '""');
    }
  },
});

// One self-contained index.html: used by the web build and copied into the desktop app.
export default defineConfig({
  base: './',
  plugins: [harfbuzzInline(), viteSingleFile()],
  build: { target: 'es2022', assetsInlineLimit: 100_000_000, chunkSizeWarningLimit: 5000 },
  worker: { format: 'iife' },
});
