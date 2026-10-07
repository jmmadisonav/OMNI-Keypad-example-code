// electron/paths.ts
//
// Where the desktop app keeps things, and where it finds the designer.
import * as path from 'node:path';

/** The display name: window title, Start menu shortcut, data folders, and
 * the name the license server and registry know the app by. */
export const APP_NAME = 'OMNI Keypad Designer';

/**
 * Chromium's own data and caches. Named after the app, as the installer and
 * the Documents folder are, rather than left to Electron, which would name it
 * after package.json's "name".
 */
export function userDataDir(appDataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  // A copy trying a build in its own data folder (see designerDataDir) gets
  // its own profile too, and with it its own single-instance lock, so it runs
  // alongside an installed copy instead of handing over to it.
  if (env.OMNI_KEYPAD_DATA_DIR) { return path.join(env.OMNI_KEYPAD_DATA_DIR, 'app-profile'); }
  return path.join(appDataDir, APP_NAME);
}

/** Projects, backups, and the recipe library: in Documents, so they're easy
 * to find, copy, and back up. OMNI_KEYPAD_DATA_DIR moves them, for example to
 * try a build without touching your own projects. */
export function designerDataDir(documentsDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.OMNI_KEYPAD_DATA_DIR || path.join(documentsDir, APP_NAME);
}

export interface DesignerLocation {
  /** The Python interpreter that runs the designer's server. */
  python: string;
  /** The folder that holds designer/, hcontrol.py, keypad_design.py, and docs/. */
  root: string;
}

/**
 * The installed app carries its own Python and a copy of the designer as
 * extra resources (see electron-builder.yml and build_tools/stage-python.mjs).
 * Run from source, it uses the repo itself and the Python on PATH, or the
 * one OMNI_PYTHON names.
 */
export function designerLocation(
  isPackaged: boolean,
  resourcesPath: string,
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): DesignerLocation {
  if (isPackaged) {
    return { python: path.join(resourcesPath, 'python', 'python.exe'), root: path.join(resourcesPath, 'designer') };
  }
  return { python: env.OMNI_PYTHON || 'python', root: repoRoot };
}
