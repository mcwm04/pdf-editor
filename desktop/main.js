// Electron main process: window, native file dialogs, "Open with" support.
const { app, BrowserWindow, dialog, ipcMain, protocol, net, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { pathToFileURL } = require('url');

// Serve the UI from app:// instead of file:// so Web Workers and blob URLs behave like on the web.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let win = null;
let pending = []; // files to open once the window is ready
let ready = false;

const pdfArgs = (argv) => argv.slice(app.isPackaged ? 1 : 2).filter(a => a.toLowerCase().endsWith('.pdf'));

async function readFiles(paths) {
  const out = [];
  for (const p of paths) {
    try { const buf = await fs.readFile(p); out.push({ name: path.basename(p), data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }); }
    catch (e) { dialog.showErrorBox('Could not open file', `${p}\n${e.message}`); }
  }
  return out;
}

async function sendOpen(paths) {
  if (!paths.length) return;
  if (!win || !ready) { pending.push(...paths); return; }
  win.webContents.send('open-files', await readFiles(paths));
  if (win.isMinimized()) win.restore();
  win.focus();
}

function filtersFor(accept) {
  if (/pdf/.test(accept)) return [{ name: 'PDF files', extensions: ['pdf'] }];
  if (/image/.test(accept)) return [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }];
  return [{ name: 'All files', extensions: ['*'] }];
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600, title: 'PDF Editor', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadURL('app://editor/index.html');
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => { ready = true; const p = pending; pending = []; sendOpen(p); });
  // Links open in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // The page blocks closing while there are unsaved edits: ask the user.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['Discard changes', 'Cancel'], defaultId: 1, cancelId: 1,
      title: 'Unsaved changes', message: 'You have edits that are not saved. Close anyway?',
    });
    if (choice === 0) e.preventDefault();
  });
  win.on('closed', () => { win = null; ready = false; });
}

ipcMain.handle('open-files', async (_e, accept, multiple) => {
  const r = await dialog.showOpenDialog(win, { properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'], filters: filtersFor(accept) });
  return r.canceled ? [] : readFiles(r.filePaths);
});

ipcMain.handle('save-file', async (_e, name, data) => {
  const ext = path.extname(name).slice(1) || 'pdf';
  const r = await dialog.showSaveDialog(win, { defaultPath: name, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (r.canceled || !r.filePath) return false;
  await fs.writeFile(r.filePath, Buffer.from(data));
  return true;
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_e, argv) => sendOpen(pdfArgs(argv)));
  app.on('open-file', (e, p) => { e.preventDefault(); sendOpen([p]); }); // macOS "Open with"
  app.whenReady().then(() => {
    const root = path.join(__dirname, 'app');
    protocol.handle('app', (req) => {
      const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.normalize(path.join(root, rel));
      if (!file.startsWith(root)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });
    pending.push(...pdfArgs(process.argv));
    createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
