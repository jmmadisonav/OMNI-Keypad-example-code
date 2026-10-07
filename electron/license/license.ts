// electron/license/license.ts
//
// The licensing flow, ported from license_base's LicenseBase. It decides
// what the app must do next -- run, ask for a serial, or fall back to a
// manual activation -- and leaves every dialog to the caller (see
// license-ui.ts), so the flow itself is testable without Electron.
import {
  DEFAULT_SERVER_URI,
  checkInMessage,
  encryptForServer,
  isNewerVersion,
  sendCheckIn,
  updatePageUrl,
  verifyServerSignature,
  windowsPcUuid,
  type CheckInResponse,
} from './check-in';
import type { LicenseStore } from './registry';
import { validateSerial } from './serial';

export interface AvailableUpdate {
  currentVersion: string;
  url: string;
}

/** What the app must do next. */
export type LicenseOutcome =
  /** Run. Either licensed, or this app does not require a serial. */
  | { kind: 'licensed'; update: AvailableUpdate | null }
  /** Ask for a serial number, showing `message` (empty the first time, or
   * why the last one was refused). */
  | { kind: 'need-serial'; message: string }
  /**
   * The server cannot be reached and nothing stored verifies. `save-request`
   * means offering to save `request` for the user to send in;
   * `load-license` means a request for this serial was already made, so the
   * user may now have the license file that answers it.
   */
  | { kind: 'manual-activation'; stage: 'save-request' | 'load-license'; request: string; serial: string };

export interface LicenseClientOptions {
  /** The display name, such as `"OMNI Keypad Designer"`. */
  appName: string;
  version: string;
  store: LicenseStore;
  /**
   * Require a serial from the start, as license_base's `enforce_serial`.
   *
   * A starting point, not a lock: the server still decides. Each check-in
   * replaces it with the server's `require_serial_number`, so the server can
   * turn it off for an app that ships with it on. It holds offline, and until
   * the server first answers.
   */
  enforceSerial?: boolean;
  serverUri?: string;
  pcUuid?: () => Promise<string>;
  fetchFn?: typeof fetch;
  verifySignature?: (message: string, signature: string | null) => boolean;
}

export class LicenseClient {
  private readonly serverUri: string;
  private readonly pcUuid: () => Promise<string>;
  private readonly fetchFn: typeof fetch;
  private readonly verifySignature: (message: string, signature: string | null) => boolean;

  /** Whether this app requires a serial. Starts from `enforceSerial`, or
   * failing that the value the server last reported, so an app that has been
   * told once still enforces it offline. */
  private enforceSerial: boolean;

  /** The last check-in message. A manual activation's license file is a
   * signature over exactly this, so it has to outlive the check-in. */
  private message = '';

  constructor(private readonly options: LicenseClientOptions) {
    this.serverUri = options.serverUri ?? DEFAULT_SERVER_URI;
    this.pcUuid = options.pcUuid ?? windowsPcUuid;
    this.fetchFn = options.fetchFn ?? fetch;
    this.verifySignature = options.verifySignature ?? verifyServerSignature;
    this.enforceSerial = options.enforceSerial ?? false;
  }

  /** The startup check: checks in with the stored serial, if any. */
  async start(): Promise<LicenseOutcome> {
    const stored = await this.options.store.read();
    // As license_base's run(): the stored answer only ever turns it ON.
    if (!this.enforceSerial) { this.enforceSerial = stored.serial_required === '1'; }
    return this.verify(stored.serial ?? '');
  }

  /**
   * Checks `serial` in with the server and decides what happens next.
   *
   * Called by `start`, and again with each serial the user enters.
   */
  async verify(serial: string): Promise<LicenseOutcome> {
    const { appName, version, store } = this.options;
    const validSerial = validateSerial(serial);
    this.message = checkInMessage(await this.pcUuid(), validSerial, appName, version);
    const request = encryptForServer(this.message);
    const response = await sendCheckIn(request, this.serverUri, this.fetchFn);

    let update: AvailableUpdate | null = null;
    if (response) {
      this.enforceSerial = await this.recordSerialRequirement(response);
      update = this.updateFrom(response);
    }

    if (!this.enforceSerial) { return { kind: 'licensed', update }; }
    if (!validSerial) { return { kind: 'need-serial', message: '' }; }

    if (response) {
      if (response.success) {
        if (this.verifySignature(this.message, response.signature ?? null)) {
          await store.write('sig', response.signature ?? '');
          await store.write('serial', validSerial);
          return { kind: 'licensed', update };
        }
        // license_base does nothing here and leaves the app waiting forever.
        // Asking again at least tells the user something went wrong.
        return {
          kind: 'need-serial',
          message: "The license server's response couldn't be verified.",
        };
      }
      return {
        kind: 'need-serial',
        message: `Unable to register\n${response.error ?? 'The server refused this serial number.'}\n`,
      };
    }

    // Offline. A signature stored by an earlier online check-in still proves
    // the license -- for as long as nothing in the message has changed,
    // which includes the app version.
    const stored = await store.read();
    if (this.verifySignature(this.message, stored.sig)) {
      return { kind: 'licensed', update: null };
    }
    if (stored.manual_serial === validSerial) {
      return { kind: 'manual-activation', stage: 'load-license', request, serial: validSerial };
    }
    await store.write('manual_serial', validSerial);
    return { kind: 'manual-activation', stage: 'save-request', request, serial: validSerial };
  }

  /**
   * Completes a manual activation with the contents of a license file.
   *
   * The file holds the server's signature over the check-in message this
   * client just made, which is why `verify` must have run first. True when
   * it verifies, and the license is then stored as an online one would be.
   */
  async manualActivation(licenseFileText: string, serial: string): Promise<boolean> {
    const signature = licenseFileText.trim();
    if (!this.verifySignature(this.message, signature)) { return false; }
    const { store } = this.options;
    await store.write('manual_serial', '');
    await store.write('sig', signature);
    await store.write('serial', serial);
    return true;
  }

  /** Records whether the server requires a serial, returning the answer. A
   * response that does not say counts as not required, as in license_base. */
  private async recordSerialRequirement(response: CheckInResponse): Promise<boolean> {
    if (!('require_serial_number' in response)) { return false; }
    const required = Boolean(response.require_serial_number);
    await this.options.store.write('serial_required', required ? '1' : '0');
    return required;
  }

  private updateFrom(response: CheckInResponse): AvailableUpdate | null {
    const currentVersion = typeof response.current_version === 'string' ? response.current_version : '';
    if (!isNewerVersion(currentVersion, this.options.version)) { return null; }
    return { currentVersion, url: updatePageUrl(this.serverUri, this.options.appName) };
  }
}
