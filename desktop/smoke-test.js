const { app, BrowserWindow } = require('electron');
require('./main.js');
app.whenReady().then(() => setTimeout(async () => {
  const w = BrowserWindow.getAllWindows()[0];
  const r = await w.webContents.executeJavaScript(`JSON.stringify({pages: window.__pdfEditor.store.pages.length, desktop: !!window.desktopAPI, title: document.title})`);
  console.log('SMOKE', r);
  const img = await w.webContents.capturePage(); require('fs').writeFileSync('/home/claude/test/out/electron.png', img.toPNG());
  app.exit(0);
}, 7000));
