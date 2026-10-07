// electron/license/license-ui.ts
//
// The dialogs licensing needs, the counterpart of license_base's
// pyside6_utilities. LicenseClient decides what happens; this shows it.
//
// Messages go through `ask`, the app's own dialog (see electron/app-dialog.ts),
// so they match everything else the app shows. Only the file pickers are
// native, since the app has no file browser of its own.
import { app, dialog, shell, type BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import type { AppDialogOptions } from '../app-dialog';
import type { AvailableUpdate, LicenseClient, LicenseOutcome } from './license';
import { promptForSerial } from './serial-prompt';

/** Shows a message in the app's own dialog; true for the confirm button. */
export type Ask = (options: AppDialogOptions) => Promise<boolean>;

/**
 * Runs the licensing flow to its end: the app is licensed, or it has quit.
 *
 * Every path that cannot license the app quits it, exactly as license_base
 * exits. The main window stays open behind the prompts, but each one covers
 * it -- the serial prompt as a modal window, the rest behind a backdrop -- so
 * it can't be used until licensing finishes.
 */
export async function runLicensing(
  win: BrowserWindow,
  client: LicenseClient,
  appName: string,
  ask: Ask,
): Promise<void> {
  let outcome: LicenseOutcome = await client.start();
  for (;;) {
    if (win.isDestroyed()) { return; }
    switch (outcome.kind) {
      case 'licensed':
        if (outcome.update) { await offerUpdate(ask, appName, outcome.update); }
        return;

      case 'need-serial': {
        const serial = await promptForSerial(win, `${appName} Serial Number Required`, outcome.message);
        if (serial === null) {
          await ask({
            title: 'Serial number required',
            message: 'This software requires a valid serial number to run.',
            confirmLabel: 'Quit',
            cancelLabel: null,
          });
          app.quit();
          return;
        }
        outcome = await client.verify(serial);
        break;
      }

      case 'manual-activation': {
        if (outcome.stage === 'load-license') {
          const activated = await loadLicenseFile(win, client, ask, appName, outcome.serial);
          if (activated === 'activated') {
            outcome = { kind: 'licensed', update: null };
            break;
          }
          if (activated === 'rejected') {
            app.quit();
            return;
          }
          // Cancelled: offer to save the request again, as license_base does.
        }
        await saveActivationRequest(win, ask, outcome.request, outcome.serial);
        app.quit();
        return;
      }
    }
  }
}

/** Offers the download page for a newer release. The app does not update
 * itself: the page hosts the installer, which upgrades in place. */
async function offerUpdate(ask: Ask, appName: string, update: AvailableUpdate): Promise<void> {
  const withV = (version: string) => (version.startsWith('v') ? version : `v${version}`);
  const download = await ask({
    title: 'Update available',
    message: `A new version is available for download: ${appName} ${withV(update.currentVersion)}.`
      + ` You're running ${withV(app.getVersion())}.`,
    confirmLabel: 'Open download page',
    cancelLabel: 'Later',
  });
  if (download) { await shell.openExternal(update.url); }
}

/** Asks for the license file that answers an earlier activation request. */
async function loadLicenseFile(
  win: BrowserWindow,
  client: LicenseClient,
  ask: Ask,
  appName: string,
  serial: string,
): Promise<'activated' | 'rejected' | 'cancelled'> {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Load Manual Activation',
    filters: [{ name: 'License file', extensions: ['lic'] }],
    properties: ['openFile'],
  });
  if (canceled || filePaths.length === 0) { return 'cancelled'; }

  let text = '';
  try {
    text = await fs.readFile(filePaths[0], 'utf8');
  } catch (error) {
    console.error('Unable to read the license file:', error);
  }
  if (text && (await client.manualActivation(text, serial))) {
    await ask({
      title: 'Activation complete',
      message: `This copy of ${appName} is now licensed on this computer.`,
      confirmLabel: 'OK',
      cancelLabel: null,
    });
    return 'activated';
  }

  await ask({
    title: 'Unlicensed',
    message: "That file can't be used for manual activation.",
    confirmLabel: 'Quit',
    cancelLabel: null,
  });
  return 'rejected';
}

/** Offers to save the encrypted request a user sends in to be activated
 * without the server. */
async function saveActivationRequest(win: BrowserWindow, ask: Ask, request: string, serial: string): Promise<void> {
  const save = await ask({
    title: 'Unable to contact the license server',
    message: 'To activate without it, save a manual activation request and send it to Magic Software.',
    confirmLabel: 'Save activation request',
    cancelLabel: 'Quit',
  });
  if (!save) { return; }

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save Manual Activation',
    defaultPath: `${serial}.txt`,
    filters: [{ name: 'Text file', extensions: ['txt'] }],
  });
  if (canceled || !filePath) { return; }
  try {
    await fs.writeFile(filePath, request, 'utf8');
  } catch (error) {
    await ask({
      title: 'Unlicensed',
      message: `The activation request could not be saved. ${error instanceof Error ? error.message : String(error)}`,
      confirmLabel: 'Quit',
      cancelLabel: null,
    });
  }
}
