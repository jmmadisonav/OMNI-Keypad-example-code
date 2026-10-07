// electron/license/serial-prompt-preload.ts
//
// Wires the serial prompt's form to the main process. The page itself has no
// script: it is a data: URL built in serial-prompt.ts.
import { ipcRenderer } from 'electron';

const RESULT_CHANNEL = 'license:serial-result';

window.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('form') as HTMLFormElement;
  const input = document.getElementById('serial') as HTMLInputElement;
  const cancel = document.getElementById('cancel') as HTMLButtonElement;
  form.addEventListener('submit', event => {
    event.preventDefault();
    ipcRenderer.send(RESULT_CHANNEL, input.value);
  });
  cancel.addEventListener('click', () => ipcRenderer.send(RESULT_CHANNEL, null));
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') { ipcRenderer.send(RESULT_CHANNEL, null); }
  });
  input.focus();
});
