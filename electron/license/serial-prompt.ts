// electron/license/serial-prompt.ts
//
// A modal serial-number prompt. Electron has no text-input dialog, so this
// is a small window of its own, the counterpart of license_base's
// QInputDialog.
import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

const RESULT_CHANNEL = 'license:serial-result';

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
}

/** The designer's bundled fonts (designer/vendor/fonts), set by main.ts
 * once it knows where the designer is installed. */
let fontDir: string | null = null;

export function setPromptFontDir(dir: string): void {
  fontDir = dir;
}

/**
 * @font-face rules for the designer's UI font, Hind, embedded as data: URIs.
 *
 * The prompt is a data: page, so it can't load the font files by URL. A
 * missing font just falls back to Segoe UI.
 */
function appFontFaces(): string {
  if (!fontDir) { return ''; }
  return [['400', 'Hind-Regular.ttf'], ['700', 'Hind-Bold.ttf']]
    .map(([weight, file]) => {
      try {
        const data = fs.readFileSync(path.join(fontDir as string, file)).toString('base64');
        return `@font-face { font-family: "Hind"; font-weight: ${weight}; `
          + `src: url(data:font/ttf;base64,${data}) format("truetype"); }`;
      } catch {
        return '';
      }
    })
    .join('\n');
}

/** The window's own background, so it doesn't flash before the page paints. */
export const PROMPT_BACKGROUND = '#ffffff';

/**
 * The prompt's page. `message` is why a previous serial was refused, or
 * empty the first time.
 *
 * Styled like the designer's own dialogs: the MGE colours from
 * designer/static/style.css, copied because this page can't load that
 * stylesheet. Change them there, change them here.
 */
export function serialPromptHtml(message: string, fontFaces = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:">
<style>
  ${fontFaces}
  :root {
    color-scheme: light;
    --red: #e31837; --red-hover: #cf1532; --slate: #2e3c49; --grey: #445c6d;
    --muted: #909dab; --light: #e4e5e6; --control: #c9ccd0; --white: #ffffff;
  }
  html, body { margin: 0; background: var(--white); color: var(--slate); }
  body { font: 14px/1.5 "Hind", "Segoe UI", system-ui, sans-serif; border-bottom: 6px solid var(--red); }
  form { display: flex; flex-direction: column; gap: 10px; padding: 20px 22px 18px; }
  h2 { margin: 0; font-size: 20px; font-weight: 700; }
  h2 span { color: var(--red); }
  p { margin: 0; }
  .hint { color: var(--grey); }
  .error { display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; border: 1px solid var(--red);
           white-space: pre-line; }
  .chip { flex: none; padding: 1px 6px; background: var(--red); color: var(--white); font-size: 10px;
          font-weight: 700; letter-spacing: .08em; }
  input {
    height: 38px; border: 1px solid var(--control); border-radius: 0; padding: 0 12px;
    background: var(--white); color: var(--slate); outline: none;
    font: 15px Consolas, "Cascadia Mono", monospace; letter-spacing: 0.05em;
  }
  input:focus { border-color: var(--slate); }
  input::placeholder { color: var(--muted); }
  .actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px; }
  button {
    height: 38px; padding: 0 18px; border: 1px solid var(--slate); border-radius: 0; background: var(--white);
    color: var(--slate); font: 700 12px "Hind", "Segoe UI", sans-serif; letter-spacing: .06em;
    text-transform: uppercase; cursor: pointer;
  }
  button:hover { background: var(--light); }
  button.primary { background: var(--red); border-color: var(--red); color: var(--white); }
  button.primary:hover { background: var(--red-hover); }
  button:focus-visible { outline: 2px solid var(--slate); outline-offset: 2px; }
</style>
</head>
<body>
<form id="form">
  <h2>Serial number required<span>.</span></h2>
  ${message.trim() ? `<p class="error"><span class="chip">ERROR</span><span>${escapeHtml(message.trim())}</span></p>` : ''}
  <p class="hint">Enter the serial number for this copy of the software.</p>
  <input id="serial" aria-label="Serial number" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX">
  <div class="actions">
    <button type="button" id="cancel">Cancel</button>
    <button type="submit" class="primary">OK</button>
  </div>
</form>
</body>
</html>`;
}

/**
 * Asks for a serial number over `parent`, resolving with what was entered,
 * or null when the prompt was cancelled or closed.
 */
export function promptForSerial(parent: BrowserWindow, title: string, message: string): Promise<string | null> {
  return new Promise(resolve => {
    const win = new BrowserWindow({
      parent,
      modal: true,
      // A starting size only: the window is fitted to its content before it
      // is shown, since an error message can run to more than one line.
      width: 420,
      height: 180,
      useContentSize: true,
      backgroundColor: PROMPT_BACKGROUND,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'serial-prompt-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setMenu(null);
    // The page has no <title>, and would otherwise replace this one with its URL.
    win.on('page-title-updated', event => event.preventDefault());

    let result: string | null = null;
    const onResult = (event: IpcMainEvent, value: unknown) => {
      if (event.sender !== win.webContents) { return; }
      result = typeof value === 'string' && value.trim() ? value.trim() : null;
      win.close();
    };
    ipcMain.on(RESULT_CHANNEL, onResult);
    win.on('closed', () => {
      ipcMain.removeListener(RESULT_CHANNEL, onResult);
      resolve(result);
    });
    win.once('ready-to-show', async () => {
      try {
        const height = await win.webContents.executeJavaScript('document.body.scrollHeight');
        if (typeof height === 'number' && height > 0) { win.setContentSize(420, Math.ceil(height)); }
      } catch {
        // Keep the starting size; the prompt still works.
      }
      if (!win.isDestroyed()) { win.show(); }
    });
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(serialPromptHtml(message, appFontFaces()))}`);
  });
}
