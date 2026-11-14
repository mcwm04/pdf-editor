// Platform adapters: the only code that differs between web and desktop.
export interface PickedFile { name: string; bytes: Uint8Array }
export interface Platform {
  kind: 'web' | 'desktop';
  openFiles(accept: string, multiple: boolean): Promise<PickedFile[]>;
  saveFile(name: string, bytes: Uint8Array): Promise<boolean>; // false = cancelled
  /** Desktop: files passed on the command line / "Open with". */
  onExternalOpen?(fn: (files: PickedFile[]) => void): void;
}

interface DesktopBridge {
  openFiles(accept: string, multiple: boolean): Promise<{ name: string; data: ArrayBuffer }[]>;
  saveFile(name: string, data: Uint8Array): Promise<boolean>;
  onOpenFiles(cb: (files: { name: string; data: ArrayBuffer }[]) => void): void;
}
declare global { interface Window { desktopAPI?: DesktopBridge; claude?: { use(name: string): Promise<any> } } }

function pickWithInput(accept: string, multiple: boolean): Promise<PickedFile[]> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept; input.multiple = multiple;
    input.style.display = 'none'; document.body.appendChild(input);
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      input.remove();
      resolve(await Promise.all(files.map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
    };
    input.addEventListener('cancel', () => { input.remove(); resolve([]); });
    input.click();
  });
}

const webPlatform: Platform = {
  kind: 'web',
  openFiles: pickWithInput,
  async saveFile(name, bytes) {
    // Inside claude.ai the page is sandboxed: downloads go through the host's `downloads` capability.
    if (window.claude?.use) {
      const dl = await window.claude.use('downloads').catch(() => null);
      if (dl) {
        try { await dl.save({ filename: name, data: new Blob([bytes as BlobPart]) }); return true; }
        catch (e: any) { if (e?.code === 'declined') return false; throw new Error(e?.message || 'Download was blocked'); }
      }
    }
    const mime = name.endsWith('.zip') ? 'application/zip' : 'application/pdf';
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return true;
  },
};

const desktopPlatform = (api: DesktopBridge): Platform => ({
  kind: 'desktop',
  async openFiles(accept, multiple) {
    const files = await api.openFiles(accept, multiple);
    return files.map(f => ({ name: f.name, bytes: new Uint8Array(f.data) }));
  },
  saveFile: (name, bytes) => api.saveFile(name, bytes),
  onExternalOpen(fn) { api.onOpenFiles(files => fn(files.map(f => ({ name: f.name, bytes: new Uint8Array(f.data) })))); },
});

export const platform: Platform = window.desktopAPI ? desktopPlatform(window.desktopAPI) : webPlatform;
