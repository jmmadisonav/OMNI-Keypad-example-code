// electron/license/license.spec.ts
import { describe, expect, it, vi } from 'vitest';
import { LicenseClient } from './license';
import type { LicenseStore, LicenseValueName, LicenseValues } from './registry';

const SERIAL = 'ZYYY-YYYY-YYYY-YYYZ-YYYZ';

function memoryStore(initial: Partial<LicenseValues> = {}): LicenseStore & { values: LicenseValues } {
  const values: LicenseValues = {
    serial: null, sig: null, serial_required: null, manual_serial: null, ...initial,
  };
  return {
    values,
    read: async () => ({ ...values }),
    write: async (name: LicenseValueName, value: string) => { values[name] = value; },
  };
}

function server(body: object | null) {
  return vi.fn(async () => {
    if (body === null) { throw new Error('offline'); }
    return new Response(JSON.stringify(body));
  });
}

/** A client whose signature check accepts only `GOOD`, standing in for the
 * server's key -- check-in.spec.ts tests the real verification. */
function client(
  store: LicenseStore,
  fetchFn: ReturnType<typeof server>,
  version = '0.1.1',
  enforceSerial = false,
) {
  return new LicenseClient({
    appName: 'BSS Commission',
    version,
    enforceSerial,
    store,
    serverUri: 'https://example.test',
    pcUuid: async () => 'UUID-1',
    fetchFn,
    verifySignature: (_message, signature) => signature?.trim() === 'GOOD',
  });
}

describe('LicenseClient', () => {
  describe('when no serial is required', () => {
    it('runs, and records the requirement as off', async () => {
      const store = memoryStore();
      const outcome = await client(store, server({ require_serial_number: false })).start();
      expect(outcome).toEqual({ kind: 'licensed', update: null });
      expect(store.values.serial_required).toBe('0');
    });

    it('offers a newer version', async () => {
      const outcome = await client(memoryStore(), server({
        require_serial_number: false, current_version: 'v0.2.1',
      })).start();
      expect(outcome).toEqual({
        kind: 'licensed',
        update: { currentVersion: 'v0.2.1', url: 'https://example.test/updates/bss_commission' },
      });
    });

    it('offers nothing when the running version is current', async () => {
      const outcome = await client(memoryStore(), server({
        require_serial_number: false, current_version: 'v0.2.1',
      }), '0.2.1').start();
      expect(outcome).toEqual({ kind: 'licensed', update: null });
    });

    it('runs offline when the server has never required one', async () => {
      expect(await client(memoryStore(), server(null)).start()).toEqual({ kind: 'licensed', update: null });
    });
  });

  describe('when a serial is required', () => {
    it('asks for one when none is stored, and records the requirement', async () => {
      const store = memoryStore();
      const outcome = await client(store, server({ require_serial_number: true })).start();
      expect(outcome).toEqual({ kind: 'need-serial', message: '' });
      expect(store.values.serial_required).toBe('1');
    });

    it('asks again when the entered serial is malformed', async () => {
      const c = client(memoryStore(), server({ require_serial_number: true }));
      await c.start();
      expect(await c.verify('not-a-serial')).toEqual({ kind: 'need-serial', message: '' });
    });

    it('stores an accepted serial and its signature, and runs', async () => {
      const store = memoryStore();
      const fetchFn = server({ require_serial_number: true, success: true, signature: 'GOOD' });
      const outcome = await client(store, fetchFn).verify(SERIAL);
      expect(outcome).toEqual({ kind: 'licensed', update: null });
      expect(store.values.serial).toBe(SERIAL);
      expect(store.values.sig).toBe('GOOD');
    });

    it("shows the server's reason for refusing a serial", async () => {
      const fetchFn = server({ require_serial_number: true, success: false, error: 'Serial already in use' });
      expect(await client(memoryStore(), fetchFn).verify(SERIAL)).toEqual({
        kind: 'need-serial',
        message: 'Unable to register\nSerial already in use\n',
      });
    });

    it('asks again, rather than hanging, when an accepted serial does not verify', async () => {
      const store = memoryStore();
      const fetchFn = server({ require_serial_number: true, success: true, signature: 'FORGED' });
      const outcome = await client(store, fetchFn).verify(SERIAL);
      expect(outcome.kind).toBe('need-serial');
      expect(store.values.serial).toBeNull();
    });

    it('checks in with the stored serial on startup', async () => {
      const store = memoryStore({ serial: SERIAL, sig: 'GOOD', serial_required: '1' });
      const fetchFn = server({ require_serial_number: true, success: true, signature: 'GOOD' });
      expect(await client(store, fetchFn).start()).toEqual({ kind: 'licensed', update: null });
    });
  });

  describe('with enforceSerial set in the app', () => {
    it('asks for a serial offline, with nothing stored', async () => {
      expect(await client(memoryStore(), server(null), '0.1.1', true).start())
        .toEqual({ kind: 'need-serial', message: '' });
    });

    it('asks for a serial offline even when the server last said none was needed', async () => {
      const store = memoryStore({ serial_required: '0' });
      expect(await client(store, server(null), '0.1.1', true).start())
        .toEqual({ kind: 'need-serial', message: '' });
    });

    it('asks for a serial when the server also requires one', async () => {
      expect(await client(memoryStore(), server({ require_serial_number: true }), '0.1.1', true).start())
        .toEqual({ kind: 'need-serial', message: '' });
    });

    it('is overridden by a server that says none is needed', async () => {
      const store = memoryStore();
      expect(await client(store, server({ require_serial_number: false }), '0.1.1', true).start())
        .toEqual({ kind: 'licensed', update: null });
      expect(store.values.serial_required).toBe('0');
    });

    it('is overridden by a server reply that does not say, as in license_base', async () => {
      expect(await client(memoryStore(), server({ current_version: 'v0.1.1' }), '0.1.1', true).start())
        .toEqual({ kind: 'licensed', update: null });
    });
  });

  describe('offline, with a serial required from an earlier check-in', () => {
    it('asks for a serial when none is stored', async () => {
      const store = memoryStore({ serial_required: '1' });
      expect(await client(store, server(null)).start()).toEqual({ kind: 'need-serial', message: '' });
    });

    it('runs on a stored signature that still verifies', async () => {
      const store = memoryStore({ serial: SERIAL, sig: 'GOOD', serial_required: '1' });
      expect(await client(store, server(null)).start()).toEqual({ kind: 'licensed', update: null });
    });

    it('offers to save an activation request the first time, and remembers the serial', async () => {
      const store = memoryStore({ serial: SERIAL, sig: 'STALE', serial_required: '1' });
      const outcome = await client(store, server(null)).start();
      expect(outcome).toMatchObject({ kind: 'manual-activation', stage: 'save-request', serial: SERIAL });
      if (outcome.kind === 'manual-activation') {
        expect(outcome.request).toMatch(/^[A-Za-z0-9_-]{342}==$/);
      }
      expect(store.values.manual_serial).toBe(SERIAL);
    });

    it('asks for the license file once a request for this serial was made', async () => {
      const store = memoryStore({ serial_required: '1', manual_serial: SERIAL });
      const c = client(store, server(null));
      expect(await c.start()).toEqual({ kind: 'need-serial', message: '' });
      expect(await c.verify(SERIAL)).toMatchObject({ kind: 'manual-activation', stage: 'load-license' });
    });

    it('activates from a license file that verifies, storing it like an online license', async () => {
      const store = memoryStore({ serial_required: '1', manual_serial: SERIAL });
      const c = client(store, server(null));
      await c.start();
      await c.verify(SERIAL);
      expect(await c.manualActivation('GOOD\r\n', SERIAL)).toBe(true);
      expect(store.values).toEqual({
        serial: SERIAL, sig: 'GOOD', serial_required: '1', manual_serial: '',
      });
    });

    it('refuses a license file that does not verify, storing nothing', async () => {
      const store = memoryStore({ serial_required: '1', manual_serial: SERIAL });
      const c = client(store, server(null));
      await c.start();
      await c.verify(SERIAL);
      expect(await c.manualActivation('FORGED', SERIAL)).toBe(false);
      expect(store.values.sig).toBeNull();
    });
  });
});
