// electron/license/registry.spec.ts
//
// Runs against the real registry, under a throwaway app name that is
// deleted afterwards: the point is to prove the layout matches what
// license_base's winreg calls read and write, which a mock cannot.
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { registryLicenseStore } from './registry';

const APP = `License Base Test ${process.pid}`;
const KEY = `HKCU\\SOFTWARE\\Magic Software\\${APP}`;

describe.runIf(process.platform === 'win32')('registryLicenseStore', () => {
  afterAll(() => {
    try { execFileSync('reg', ['delete', KEY, '/f'], { stdio: 'ignore' }); } catch { /* never created */ }
  });

  it('reads nothing for an app that has never been licensed', async () => {
    expect(await registryLicenseStore(APP).read()).toEqual({
      serial: null, sig: null, serial_required: null, manual_serial: null,
    });
  });

  it("writes each value as its subkey's default value, as winreg.SetValue does", async () => {
    const store = registryLicenseStore(APP);
    await store.write('serial_required', '1');
    const out = execFileSync('reg', ['query', `${KEY}\\serial_required`, '/ve'], { encoding: 'utf8' });
    expect(out).toMatch(/REG_SZ\s+1\s*$/m);
  });

  it('round-trips every value, including an empty one', async () => {
    const store = registryLicenseStore(APP);
    await store.write('serial', 'ZYYY-YYYY-YYYY-YYYZ-YYYZ');
    await store.write('sig', 'aCI78bGA-_x==');
    await store.write('manual_serial', '');
    expect(await store.read()).toEqual({
      serial: 'ZYYY-YYYY-YYYY-YYYZ-YYYZ',
      sig: 'aCI78bGA-_x==',
      serial_required: '1',
      manual_serial: '',
    });
  });
});
