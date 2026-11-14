// Some hosts reject a literal U+FFFD in HTML. In the inlined JS it only appears inside
// strings/regexes, where the escape � means exactly the same thing.
import fs from 'fs';
const f = 'dist/index.html';
const s = fs.readFileSync(f, 'utf8');
const n = (s.match(/�/g) || []).length;
fs.writeFileSync(f, s.replace(/�/g, '\\uFFFD'));
console.log(`escaped ${n} U+FFFD characters`);
