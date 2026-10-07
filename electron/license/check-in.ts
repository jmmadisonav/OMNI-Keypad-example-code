// electron/license/check-in.ts
//
// The wire half of licensing, ported from license_base (the Python package
// every Magic Software desktop app uses). The server has one endpoint: a
// check-in that takes an RSA-encrypted JSON message and answers with whether
// a serial number is required, a signature over the message when the serial
// is accepted, and the application's `current_version`. There is no separate
// "latest version" URL, so the check-in is also the update check.
import { constants, publicEncrypt, verify } from 'node:crypto';
import { execFile } from 'node:child_process';

export const DEFAULT_SERVER_URI = 'https://magicsoftware.ornear.com';

/** The server's public key -- the same one license_base carries. It both
 * encrypts check-ins and verifies the signatures the server returns. */
const SERVER_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA28ScQvwVmIFwjOMXvo10
3hotQPBFITXos8swfGH+E/lHQpj3q1pvY76cfXZjSGH/o3kvFzKLzc24kVJqW2sS
l8G88WHnMJzmTeOwMxpSX3wNAPQIL+Zu53VEkU4n7Ykfx089Y7FMpcF0bsbPwQBd
GAnU3wnxEemArzD8TaltL28/HHSCswNn61R+mk2sGtzZJCSRY4TstLRp8I2u/BLa
RUehs5qhQys6mhjtVQBtXgjNBJqlCJvAzziLZZS/7kNO+8b2Jgi5WpTlmxFidYEQ
X+AQX5RY/39FqHQww9thu16D+/SkTR7gj5V7TaaZQSQglPRrezjSHTtPrZS+f2o/
WQIDAQAB
-----END PUBLIC KEY-----`;

const CHECK_IN_TIMEOUT_MS = 10_000;

/** How the server names an application: `"OMNI Keypad Designer"` becomes
 * `"omni_keypad_designer"`. The same rule license_base applies. */
export function serverAppName(appName: string): string {
  return appName.toLowerCase().split(/\s+/).filter(Boolean).join('_');
}

/** A string as Python's `json.dumps` writes it: non-ASCII escaped as
 * lower-case `\uXXXX`. Everything else JSON.stringify already does the same
 * way. */
function pythonJsonString(value: string): string {
  return JSON.stringify(value).replace(
    /[\u0080-￿]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * The plaintext the server decrypts, byte for byte as license_base builds it.
 *
 * The exact bytes matter. The server signs the message re-serialised the way
 * Python's `json.dumps` writes it -- `", "` and `": "` separators -- and the
 * signature is checked against these bytes, so JSON.stringify's compact
 * output would never verify. `app.getVersion()` has no leading `v`, but the
 * Python apps always send one, so it is added here to match.
 */
export function checkInMessage(
  pcUuid: string,
  serialNumber: string,
  appName: string,
  version: string,
): string {
  const fields: [string, string][] = [
    ['pc_uuid', pcUuid],
    ['serial_number', serialNumber],
    ['application_name', serverAppName(appName)],
    ['application_version', version.startsWith('v') ? version : `v${version}`],
  ];
  return `{${fields.map(([k, v]) => `${pythonJsonString(k)}: ${pythonJsonString(v)}`).join(', ')}}`;
}

/** The message encrypted for the server, as padded URL-safe base64. This is
 * also the manual activation request a user sends in when offline. */
export function encryptForServer(message: string): string {
  const cipher = publicEncrypt(
    { key: SERVER_PUBLIC_KEY, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(message, 'utf8'),
  );
  // Python's urlsafe_b64encode keeps the `=` padding; Node's base64url drops it.
  const encoded = cipher.toString('base64url');
  return encoded + '='.repeat((4 - (encoded.length % 4)) % 4);
}

/** Whether `signature` (URL-safe base64, as the server sends it) is the
 * server's RSA-PSS signature over `message`. False rather than a throw for
 * a malformed signature: a corrupt stored value just means "not licensed". */
export function verifyServerSignature(message: string, signature: string | null): boolean {
  if (!signature) { return false; }
  try {
    return verify(
      'sha256',
      Buffer.from(message, 'utf8'),
      {
        key: SERVER_PUBLIC_KEY,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: constants.RSA_PSS_SALTLEN_AUTO,
      },
      Buffer.from(signature.trim(), 'base64url'),
    );
  } catch {
    return false;
  }
}

/** What the check-in endpoint answers. Every field is optional: the server
 * omits what does not apply, and a response is never trusted to be complete. */
export interface CheckInResponse {
  success?: boolean;
  signature?: string;
  error?: string;
  require_serial_number?: boolean;
  current_version?: string;
}

/**
 * Posts an encrypted check-in, and returns the server's answer or null.
 *
 * Null covers every failure -- offline, a timeout, a refused check-in, a body
 * that is not JSON -- because license_base treats them all the same way: as
 * not having reached the server. Failures are logged so they can still be
 * diagnosed.
 */
export async function sendCheckIn(
  cipher: string,
  serverUri: string = DEFAULT_SERVER_URI,
  fetchFn: typeof fetch = fetch,
): Promise<CheckInResponse | null> {
  try {
    const response = await fetchFn(`${serverUri}/register/checkin/`, {
      method: 'POST',
      body: new URLSearchParams({ cipher }),
      signal: AbortSignal.timeout(CHECK_IN_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error(`License check-in refused (${response.status}): ${await response.text()}`);
      return null;
    }
    const body: unknown = await response.json();
    return body && typeof body === 'object' ? (body as CheckInResponse) : null;
  } catch (error) {
    console.error('License check-in failed:', error);
    return null;
  }
}

function parseVersion(version: string): number[] | null {
  const match = /^v?(\d+(?:\.\d+)*)$/.exec(version.trim());
  return match ? match[1].split('.').map(Number) : null;
}

/** Whether `serverVersion` is later than `runningVersion`. Missing parts count
 * as zero, so `v1.0` equals `1.0.0`. An unparseable server version is never
 * newer: a malformed answer must not nag the user to update. */
export function isNewerVersion(serverVersion: string, runningVersion: string): boolean {
  const server = parseVersion(serverVersion);
  const running = parseVersion(runningVersion);
  if (!server || !running) { return false; }
  for (let i = 0; i < Math.max(server.length, running.length); i++) {
    const diff = (server[i] ?? 0) - (running[i] ?? 0);
    if (diff !== 0) { return diff > 0; }
  }
  return false;
}

export function updatePageUrl(serverUri: string, appName: string): string {
  return `${serverUri}/updates/${serverAppName(appName)}`;
}

/** The machine's SMBIOS UUID, as license_base reads it. The server keys
 * check-ins by it, and the signature covers it, so a license only verifies on
 * the machine it was issued to. */
export function windowsPcUuid(): Promise<string> {
  return new Promise(resolve => {
    execFile(
      'powershell',
      ['-NoProfile', '-Command', '(Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID'],
      { timeout: CHECK_IN_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => resolve(error ? 'Unable to get UUID' : stdout.trim() || 'Unable to get UUID'),
    );
  });
}
