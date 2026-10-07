// electron/preload.ts
//
// The only bridge between the designer page and the main process: the
// message boxes licensing asks the page to draw (see electron/app-dialog.ts).
// The page itself talks to its server over HTTP, as it does in a browser.
import { contextBridge, ipcRenderer } from 'electron';

interface AppDialogRequest {
  id: number;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string | null;
}

contextBridge.exposeInMainWorld('appDialog', {
  /** Everything asked for before the page started listening. */
  getPending: (): Promise<AppDialogRequest[]> => ipcRenderer.invoke('app-dialog:pending'),
  onShow: (callback: (request: AppDialogRequest) => void): void => {
    ipcRenderer.on('app-dialog:show', (_event, request: AppDialogRequest) => callback(request));
  },
  answer: (id: number, confirmed: boolean): void => ipcRenderer.send('app-dialog:answer', id, confirmed),
});
