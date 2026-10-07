import { describe, expect, it } from 'vitest';
import {
  exeName,
  installerExeName,
  loadProjectConfig,
  releaseZipName,
} from './project-config.mjs';

describe('the project config', () => {
  it('loads the identity the installer and the server both key on', () => {
    const config = loadProjectConfig();
    // PROJECT_NAME is also exactly what license_base derives as the
    // server-side application name, so it must stay snake_case.
    expect(config.PROJECT_NAME).toBe('omni_keypad_designer');
    expect(config.APP_NAME).toBe('OMNI Keypad Designer');
    expect(config.PUBLISHER).toBe('MagicSoftware');
    expect(config.APP_ID).toBe('{85FE3E55-AF9A-460C-A720-4CCBF9AE5631}');
    expect(config.PROJECT_ICON).toBe('keypad.ico');
  });

  // The version belongs to package.json alone -- a second copy here drifts
  // into an installer labelled one version around an app reporting another.
  it('carries no version of its own', () => {
    expect('APP_VERSION' in loadProjectConfig()).toBe(false);
  });

  it('names the executable after the snake_case project name', () => {
    expect(exeName()).toBe('omni_keypad_designer.exe');
  });

  it('names the installer the way the iss OutputBaseFilename does', () => {
    expect(installerExeName('v0.2.5')).toBe('omni_keypad_designer_setup_v0.2.5.exe');
  });

  // From APP_NAME with spaces replaced, NOT project_name.title(), which
  // would give "Omni_Keypad_Designer" -- not how the product is written.
  it('names the zip after the product', () => {
    expect(releaseZipName('v0.2.5')).toBe('OMNI_Keypad_Designer_v0.2.5.zip');
  });
});
