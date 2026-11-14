// Copies the single-file web build into the desktop app.
const fs = require('fs'), path = require('path');
const src = path.join(__dirname, '..', 'dist', 'index.html');
if (!fs.existsSync(src)) { console.error('Run "npm run build" in the project root first.'); process.exit(1); }
fs.mkdirSync(path.join(__dirname, 'app'), { recursive: true });
fs.copyFileSync(src, path.join(__dirname, 'app', 'index.html'));
console.log('Copied web build into desktop/app');
