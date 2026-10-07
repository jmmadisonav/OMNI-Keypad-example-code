// electron/main.ts
//
// The desktop app: it starts the designer's Python server, shows the
// designer page in a window, and licenses the app as every Magic Software
// app does. The designer itself is unchanged: the same page and server you
// get from `python designer/server.py`.
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppDialogs } from './app-dialog';
import { LicenseClient } from './license/license';
import { runLicensing } from './license/license-ui';
import { registryLicenseStore } from './license/registry';
import { setPromptFontDir } from './license/serial-prompt';
import { APP_NAME, designerDataDir, designerLocation, userDataDir } from './paths';
import { serverArgs, startServer } from './server-process';
import { shortcutFor } from './shortcuts';

/** Require a serial number even before the license server says so -- see
 * `enforceSerial` in electron/license/license.ts. The server can still turn
 * it on when online, as in the Python apps. */
const ENFORCE_SERIAL = false;

/** The page's background, so the window doesn't flash white before it paints. */
const PAGE_BACKGROUND = '#e4e5e6';

let mainWindow: BrowserWindow | null = null;
let server: ChildProcess | null = null;

// Before anything reads userData -- the single-instance lock below lives in it.
app.setPath('userData', userDataDir(app.getPath('appData')));

/** Only one copy runs at a time: two would share one data folder, and save
 * over each other's projects. A second copy hands over to the first. */
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.exit(0);
}

/** `dist-electron/electron` -> the repo root, when run from source. */
const REPO_ROOT = path.join(__dirname, '..', '..');

const dataDir = designerDataDir(app.getPath('documents'));

function sendToWindow(win: BrowserWindow | null, channel: string, ...args: unknown[]): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) { return; }
  win.webContents.send(channel, ...args);
}

/** Message boxes the designer page draws for the main process -- see
 * electron/app-dialog.ts. */
const appDialogs = new AppDialogs(request => sendToWindow(mainWindow, 'app-dialog:show', request));

ipcMain.handle('app-dialog:pending', () => appDialogs.pending());
ipcMain.on('app-dialog:answer', (_event, id: number, confirmed: boolean) => appDialogs.answer(id, confirmed));

/** What the page shows only in the desktop app -- see electron/preload.ts. */
ipcMain.handle('desktop:info', () => ({ version: app.getVersion(), dataDir }));
ipcMain.handle('desktop:openDataFolder', () => shell.openPath(dataDir));

function createWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    title: APP_NAME,
    backgroundColor: PAGE_BACKGROUND,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // The page's own title is "Button Designer"; keep the app's name.
  win.on('page-title-updated', event => event.preventDefault());
  // No menu bar: the page's header is the app's menu. The shortcuts a menu
  // would have provided are handled here instead -- see electron/shortcuts.ts.
  win.webContents.on('before-input-event', (event, input) => {
    const shortcut = shortcutFor(input);
    if (!shortcut) { return; }
    event.preventDefault();
    const contents = win.webContents;
    switch (shortcut) {
      case 'devtools': contents.toggleDevTools(); break;
      case 'reload': contents.reload(); break;
      case 'zoom-in': contents.setZoomLevel(Math.min(contents.getZoomLevel() + 0.5, 5)); break;
      case 'zoom-out': contents.setZoomLevel(Math.max(contents.getZoomLevel() - 0.5, -3)); break;
      case 'zoom-reset': contents.setZoomLevel(0); break;
      case 'fullscreen': win.setFullScreen(!win.isFullScreen()); break;
    }
  });
  win.once('ready-to-show', () => win.show());

  // Links to anywhere but the designer open in the browser, never in the app.
  const origin = new URL(url).origin;
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) { void shell.openExternal(target); }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== origin) {
      event.preventDefault();
      if (/^https?:/.test(target)) { void shell.openExternal(target); }
    }
  });

  // The page asks before it's closed with unsaved changes (beforeunload). A
  // browser shows its own prompt; Electron just cancels the close, so ask here.
  win.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: APP_NAME,
      message: 'This project has unsaved changes.',
      detail: 'If you close it now, the changes are lost. To keep them, click Cancel, and then click Save.',
      buttons: ['Close without saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (choice === 0) { event.preventDefault(); }       // Go ahead and close.
  });

  win.on('closed', () => {
    appDialogs.cancelAll();
    if (mainWindow === win) { mainWindow = null; }
  });
  void win.loadURL(url);
  return win;
}

/**
 * Licenses the app, and offers any newer release, once the page is up -- the
 * port of license_base, which every Magic Software app runs at startup.
 *
 * Runs in the background: an app that needs no serial starts as normal while
 * the check-in is in flight. One that does is held behind a modal prompt
 * until it is licensed, or quits. See electron/license/.
 */
function startLicensing(win: BrowserWindow): Promise<void> {
  const client = new LicenseClient({
    appName: APP_NAME,
    version: app.getVersion(),
    store: registryLicenseStore(APP_NAME),
    enforceSerial: ENFORCE_SERIAL,
  });
  return runLicensing(win, client, APP_NAME, options => appDialogs.show(options))
    .then(() => undefined)
    .catch(error => console.error('Licensing failed:', error));
}

async function start(): Promise<void> {
  const where = designerLocation(app.isPackaged, process.resourcesPath, REPO_ROOT);
  setPromptFontDir(path.join(where.root, 'designer', 'vendor', 'fonts'));
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const running = await startServer(where.python, serverArgs(where.root, dataDir));
    server = running.child;
    server.on('exit', code => {
      server = null;
      if (code !== 0 && mainWindow && !quitting) {
        dialog.showErrorBox(APP_NAME, `The designer stopped unexpectedly (exit code ${code}). Restart ${APP_NAME}.`);
      }
    });
    Menu.setApplicationMenu(null);
    mainWindow = createWindow(running.url);
    const win = mainWindow;
    // Wait for the page, so a licensing dialog sits over a drawn window. Only
    // the first load: View > Reload mustn't license the app again.
    win.webContents.once('did-finish-load', () => void startLicensing(win));
  } catch (error) {
    dialog.showErrorBox(
      `${APP_NAME} couldn't start`,
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
  }
}

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) { return; }
  if (mainWindow.isMinimized()) { mainWindow.restore(); }
  mainWindow.focus();
});

app.whenReady().then(() => {
  if (isPrimaryInstance) { void start(); }
});

app.on('window-all-closed', () => app.quit());

let quitting = false;

// The server also exits by itself when its standard input closes, which
// covers a crash; this just doesn't wait for that.
app.on('will-quit', () => {
  quitting = true;
  server?.kill();
});
