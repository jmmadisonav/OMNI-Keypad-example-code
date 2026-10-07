import { describe, expect, it } from 'vitest';
import { embedZipName, embedZipUrl, PYTHON_VERSION, shipsInDesigner } from './stage-python.mjs';

describe('the bundled Python', () => {
  it('is the 64-bit embeddable runtime from python.org', () => {
    expect(embedZipName('3.13.9')).toBe('python-3.13.9-embed-amd64.zip');
    expect(embedZipUrl('3.13.9'))
      .toBe('https://www.python.org/ftp/python/3.13.9/python-3.13.9-embed-amd64.zip');
  });

  it('is at least the 3.10 the designer needs', () => {
    const [major, minor] = PYTHON_VERSION.split('.').map(Number);
    expect(major * 100 + minor).toBeGreaterThanOrEqual(310);
  });
});

describe('shipsInDesigner', () => {
  it('ships the server, models, page, and vendored files', () => {
    for (const file of ['designer/server.py', 'designer/models/OMNI-KP-8BV.json',
      'designer/static/app.js', 'designer/vendor/fonts/Hind-Bold.ttf']) {
      expect(shipsInDesigner(file)).toBe(true);
    }
  });

  it("leaves out your data, tests, caches, and the render check", () => {
    for (const file of ['designer/projects/Lobby/keypad.json', 'designer/backups/backup_1.cpio',
      'designer/library/HDMI.json', 'designer/static/model.test.mjs',
      'designer/__pycache__/server.cpython-313.pyc', 'designer/static/render-check.html']) {
      expect(shipsInDesigner(file)).toBe(false);
    }
  });

  it('understands Windows paths', () => {
    expect(shipsInDesigner('designer\\projects\\Lobby')).toBe(false);
    expect(shipsInDesigner('designer\\server.py')).toBe(true);
  });
});
