// electron/paths.spec.ts
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_NAME, designerDataDir, designerLocation, userDataDir } from './paths';

describe('data folders', () => {
  it('are named after the app', () => {
    expect(userDataDir('C:\\AppData')).toBe(path.join('C:\\AppData', 'OMNI Keypad Designer'));
    expect(designerDataDir('C:\\Docs', {})).toBe(path.join('C:\\Docs', APP_NAME));
  });

  it('can be moved with OMNI_KEYPAD_DATA_DIR', () => {
    expect(designerDataDir('C:\\Docs', { OMNI_KEYPAD_DATA_DIR: 'D:\\Try' })).toBe('D:\\Try');
  });
});

describe('designerLocation', () => {
  it('uses the bundled Python and designer once installed', () => {
    expect(designerLocation(true, 'C:\\App\\resources', 'C:\\repo')).toEqual({
      python: path.join('C:\\App\\resources', 'python', 'python.exe'),
      root: path.join('C:\\App\\resources', 'designer'),
    });
  });

  it('uses the repo and the Python on PATH from source', () => {
    expect(designerLocation(false, 'x', 'C:\\repo', {})).toEqual({ python: 'python', root: 'C:\\repo' });
  });

  it('lets OMNI_PYTHON pick the Python from source', () => {
    expect(designerLocation(false, 'x', 'C:\\repo', { OMNI_PYTHON: 'py' }).python).toBe('py');
  });
});
