// electron/server-process.spec.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseServerUrl, PREFERRED_PORT, serverArgs, startServer } from './server-process';

const REPO_ROOT = path.join(__dirname, '..');
const PYTHON = process.env.OMNI_PYTHON || 'python';

describe('parseServerUrl', () => {
  it("finds the address in the server's start-up line", () => {
    expect(parseServerUrl('Button designer running at http://127.0.0.1:8044/. Press Ctrl+C to stop.'))
      .toBe('http://127.0.0.1:8044/');
  });

  it('is null until the line arrives', () => {
    expect(parseServerUrl('')).toBeNull();
    expect(parseServerUrl('Loading...')).toBeNull();
  });
});

describe('serverArgs', () => {
  it('runs server.py isolated, on the preferred port, with the data folder', () => {
    const args = serverArgs('C:\\app', 'C:\\Docs\\OMNI Keypad Designer');
    expect(args.slice(0, 2)).toEqual(['-I', path.join('C:\\app', 'designer', 'server.py')]);
    expect(args).toContain('--any-port');
    expect(args).toContain('--exit-with-parent');
    expect(args[args.indexOf('--port') + 1]).toBe(String(PREFERRED_PORT));
    expect(args[args.indexOf('--data-dir') + 1]).toBe('C:\\Docs\\OMNI Keypad Designer');
  });
});

describe('startServer', () => {
  it('starts the real designer server and resolves with its address', async () => {
    const args = serverArgs(REPO_ROOT, mkdtempSync(path.join(tmpdir(), 'designer-')));
    args[args.indexOf('--port') + 1] = '0';           // Don't fight a designer you have open.
    const { url, child } = await startServer(PYTHON, args);
    try {
      const response = await fetch(`${url}api/models`);
      expect(response.ok).toBe(true);
      expect((await response.json()).map((m: { id: string }) => m.id)).toContain('OMNI-KP-8BV');
    } finally {
      const exited = new Promise(resolve => child.on('exit', resolve));
      child.stdin?.end();                               // As when the app quits.
      expect(await exited).toBe(0);
    }
  }, 30_000);

  it('rejects with what the server printed when it fails', async () => {
    await expect(startServer(PYTHON, ['-c', 'import sys; sys.exit("no designer here")'], 10_000))
      .rejects.toThrow(/no designer here/);
  });
});
