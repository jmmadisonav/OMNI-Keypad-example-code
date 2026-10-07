// electron/license/check-in.spec.ts
import { describe, expect, it, vi } from 'vitest';
import {
  checkInMessage,
  encryptForServer,
  isNewerVersion,
  sendCheckIn,
  serverAppName,
  updatePageUrl,
  verifyServerSignature,
} from './check-in';

/** A real check-in and the signature the live server returned for it
 * (captured 2026-09-23), so verification is tested against the server's
 * actual scheme rather than a key this test made up. */
const SERVER_MESSAGE =
  '{"pc_uuid": "TEST-UUID", "serial_number": "", "application_name": "bss_commission", "application_version": "v0.1.1"}';
const SERVER_SIGNATURE =
  'aCI78bGAdsbz4yD-hYyGkZF0ZCydOFI1f6q2Box0u-ug0e9CXEpWUahff6zdL1SPl9Rentp8aKCAFp2xtd3OL3EJEDzltJZ6G6oOIYJUL91Ei9LHY1OWwEw-1ls5zET93h34lhF8WbMTGjo9K4kZOwELK7O3s2sFM30BfOG_eoscDJ7Ud2ZF9LfOj2uFeR18Fb7TPh-L50PZLfLSvZ70s0xYAsWxTfa9zM9_n0-4XrpkvQ_HGj6KqLJeWtbfDObcIfOZ95bQhfmRhTbzMqgycjv3yA_h8OLrCwq1L3EFu_zrxBrusY4QO09JwAgUfzIlaJaJoSfBqwBqZv8p7ExTxw==';

describe('serverAppName', () => {
  it('lower-cases and joins words with underscores, as license_base does', () => {
    expect(serverAppName('BSS Commission')).toBe('bss_commission');
    expect(serverAppName('bss_commission')).toBe('bss_commission');
  });
});

describe('checkInMessage', () => {
  it("matches Python's json.dumps byte for byte, since the server signs that form", () => {
    expect(checkInMessage('TEST-UUID', '', 'BSS Commission', '0.1.1')).toBe(SERVER_MESSAGE);
  });

  it('keeps a version that already has its v', () => {
    expect(JSON.parse(checkInMessage('U', '', 'App', 'v1.2.3')).application_version).toBe('v1.2.3');
  });

  it('escapes non-ASCII as json.dumps does', () => {
    expect(checkInMessage('é', '', 'App', '1')).toContain('"pc_uuid": "\\u00e9"');
  });
});

describe('verifyServerSignature', () => {
  it("accepts the server's signature over the message it signed", () => {
    expect(verifyServerSignature(SERVER_MESSAGE, SERVER_SIGNATURE)).toBe(true);
  });

  it('tolerates the whitespace a license file may carry', () => {
    expect(verifyServerSignature(SERVER_MESSAGE, `${SERVER_SIGNATURE}\r\n`)).toBe(true);
  });

  it('rejects the signature for any other message', () => {
    expect(verifyServerSignature(SERVER_MESSAGE.replace('v0.1.1', 'v0.2.1'), SERVER_SIGNATURE)).toBe(false);
  });

  it('rejects the compact JSON form of the same message', () => {
    expect(verifyServerSignature(JSON.stringify(JSON.parse(SERVER_MESSAGE)), SERVER_SIGNATURE)).toBe(false);
  });

  it('rejects a missing or malformed signature without throwing', () => {
    expect(verifyServerSignature(SERVER_MESSAGE, null)).toBe(false);
    expect(verifyServerSignature(SERVER_MESSAGE, '')).toBe(false);
    expect(verifyServerSignature(SERVER_MESSAGE, 'not a signature')).toBe(false);
  });
});

describe('encryptForServer', () => {
  it('produces padded URL-safe base64 of a 256-byte RSA ciphertext', () => {
    expect(encryptForServer(SERVER_MESSAGE)).toMatch(/^[A-Za-z0-9_-]{342}==$/);
  });
});

describe('isNewerVersion', () => {
  it.each([
    ['v0.2.1', '0.1.1', true],
    ['v0.2.1', 'v0.2.1', false],
    ['v0.2.1', '0.2.2', false],
    ['v0.10.0', '0.9.9', true],
    ['v1.0', '0.9.9', true],
    ['v1.0.0', '1.0', false],
  ])('server %s vs running %s -> %s', (server, running, expected) => {
    expect(isNewerVersion(server, running)).toBe(expected);
  });

  it('treats an unparseable server version as not newer', () => {
    expect(isNewerVersion('latest', '0.1.1')).toBe(false);
    expect(isNewerVersion('', '0.1.1')).toBe(false);
  });
});

describe('updatePageUrl', () => {
  it('points at the per-application updates page', () => {
    expect(updatePageUrl('https://magicsoftware.ornear.com', 'BSS Commission'))
      .toBe('https://magicsoftware.ornear.com/updates/bss_commission');
  });
});

describe('sendCheckIn', () => {
  it('posts the cipher form-encoded to the check-in endpoint and returns the JSON', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ current_version: 'v0.2.1' })));
    expect(await sendCheckIn('CIPHER==', 'https://example.test', fetchFn)).toEqual({ current_version: 'v0.2.1' });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.test/register/checkin/');
    expect(init.method).toBe('POST');
    expect((init.body as URLSearchParams).get('cipher')).toBe('CIPHER==');
  });

  it('returns null when the server refuses the check-in', async () => {
    const fetchFn = vi.fn(async () => new Response('Invalid request', { status: 400 }));
    expect(await sendCheckIn('C', 'https://example.test', fetchFn)).toBeNull();
  });

  it('returns null when the server cannot be reached', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('offline'); });
    expect(await sendCheckIn('C', 'https://example.test', fetchFn)).toBeNull();
  });

  it('returns null for a body that is not a JSON object', async () => {
    const fetchFn = vi.fn(async () => new Response('<html>'));
    expect(await sendCheckIn('C', 'https://example.test', fetchFn)).toBeNull();
  });
});
