import { PDFDocument } from 'pdf-lib';
import { readFileSync, writeFileSync } from 'fs';
import { analyzePage, applyObjEdits } from '../../src/core/content/index';
const [, , file, editsJson, outFile] = process.argv;
(async () => {
  const doc = await PDFDocument.load(readFileSync(file));
  const page = doc.getPage(0);
  const an = analyzePage(doc, page);
  console.log('ops', an.ops.length, 'objects', an.objects.length, 'data', an.data.length);
  if (!editsJson) {
    for (const o of an.objects) console.log(o.id.padEnd(7), o.kind.padEnd(6), `${o.bbox.x.toFixed(1)},${o.bbox.y.toFixed(1)} ${o.bbox.w.toFixed(1)}x${o.bbox.h.toFixed(1)}`, o.kind === 'text' ? `size=${o.size!.toFixed(1)} font=${o.font?.baseFont} col=${o.color} "${o.text}"` : (o.label + (o.fullPage ? ' FULLPAGE' : '')));
    return;
  }
  const edits = JSON.parse(editsJson);
  // allow picking by text: {"@Waqas": {...}}
  for (const k of Object.keys(edits)) if (k.startsWith('@')) { const o = an.objects.find(x => x.text?.includes(k.slice(1))); edits[o!.id] = edits[k]; delete edits[k]; }
  const extra = await applyObjEdits(doc, page, edits);
  writeFileSync(outFile, await doc.save());
  console.log('saved', outFile, 'extra', extra.length);
})().catch(e => { console.error("ERR", e); process.exit(1); });
