// The Windows identity of this application: what the exe is called, who
// publishes it, and the GUID Windows uses to recognise an upgrade of it.
// The mirror of project_config.py in the Python projects -- with one
// deliberate omission, see NO version below.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.dirname(HERE);

/** Every key project_config.json must carry. A missing one is a build that
 * would otherwise produce an installer with a blank publisher or, worse, no
 * AppId -- which Windows treats as a different application entirely. */
const REQUIRED = ['PROJECT_NAME', 'APP_NAME', 'PUBLISHER', 'URL', 'APP_ID', 'PROJECT_ICON'];

export function loadProjectConfig() {
  const file = path.join(HERE, 'project_config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const missing = REQUIRED.filter(key => !config[key]);
  if (missing.length) {
    throw new Error(`${file} is missing: ${missing.join(', ')}`);
  }
  // NO version here. app.getVersion() and electron-builder both read
  // package.json, so a copy in this file would be a third source of the
  // same fact -- and the failure when they drift is silent.
  return config;
}

/** The exe electron-builder produces and the installer runs. */
export function exeName() {
  return `${loadProjectConfig().PROJECT_NAME}.exe`;
}

/** What the NSIS build emits, matching `nsis.artifactName` in
 * electron-builder.yml. */
export function installerExeName(version) {
  return `${loadProjectConfig().PROJECT_NAME}_setup_${version}.exe`;
}

/** The release archive. Built from APP_NAME rather than the snake_case
 * project name: release.py uses project_name.title(), which here would give
 * "Omni_Keypad_Designer" -- not how the product is written anywhere else. */
export function releaseZipName(version) {
  return `${loadProjectConfig().APP_NAME.split(' ').join('_')}_${version}.zip`;
}
