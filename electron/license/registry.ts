// electron/license/registry.ts
//
// Where licensing keeps its state: the same registry layout license_base
// uses, so every Magic Software app is licensed the same way.
//
//   HKCU\SOFTWARE\Magic Software\<App Name>\<value name>  (Default) = REG_SZ
//
// Each value is the DEFAULT value of its own subkey, not a named value --
// that is what Python's winreg.SetValue/QueryValue read and write.
import { execFile } from 'node:child_process';

export type LicenseValueName = 'serial' | 'sig' | 'serial_required' | 'manual_serial';

const VALUE_NAMES: LicenseValueName[] = ['serial', 'sig', 'serial_required', 'manual_serial'];

export type LicenseValues = Record<LicenseValueName, string | null>;

export interface LicenseStore {
  /** Every stored value, null for any never written. */
  read(): Promise<LicenseValues>;
  write(name: LicenseValueName, value: string): Promise<void>;
}

const REGISTRY_TIMEOUT_MS = 10_000;

function emptyValues(): LicenseValues {
  return { serial: null, sig: null, serial_required: null, manual_serial: null };
}

function run(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: REGISTRY_TIMEOUT_MS, windowsHide: true, env: { ...process.env, ...env } },
      (error, stdout, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout)),
    );
  });
}

// Reads with PowerShell rather than `reg query`: reg.exe labels the default
// value "(Default)" in the display language, and prints "(value not set)"
// the same way, so its output cannot be parsed reliably on a non-English
// Windows. One call reads every value, since PowerShell is slow to start.
// The key path arrives in an environment variable, so no app name can
// break out of the script's quoting.
const READ_SCRIPT = `
$o = @{}
foreach ($n in '${VALUE_NAMES.join("','")}') {
  $k = Get-Item -LiteralPath ($env:MAGIC_LICENSE_KEY + '\\' + $n) -ErrorAction SilentlyContinue
  $o[$n] = if ($k) { $k.GetValue('') } else { $null }
}
$o | ConvertTo-Json -Compress
`;

/** The license store for `appName` -- the display name, such as
 * `"OMNI Keypad Designer"`, exactly as license_base keys it. */
export function registryLicenseStore(appName: string): LicenseStore {
  const key = `SOFTWARE\\Magic Software\\${appName}`;
  return {
    async read() {
      try {
        const out = await run(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-Command', READ_SCRIPT],
          { MAGIC_LICENSE_KEY: `HKCU:\\${key}` },
        );
        const parsed = JSON.parse(out) as Record<string, unknown>;
        const values = emptyValues();
        for (const name of VALUE_NAMES) {
          const value = parsed[name];
          values[name] = typeof value === 'string' ? value : null;
        }
        return values;
      } catch (error) {
        console.error('Failed to read the license from the registry:', error);
        return emptyValues();
      }
    },
    async write(name, value) {
      // reg add creates the app's key and the value's subkey as needed, which
      // covers license_base's _init_reg. A failure is logged, not thrown, as
      // license_base does: an unwritable registry costs the user a re-prompt
      // next launch, not this one.
      try {
        await run('reg', ['add', `HKCU\\${key}\\${name}`, '/ve', '/t', 'REG_SZ', '/d', value, '/f']);
      } catch (error) {
        console.error(`Failed to write ${name} to the registry:`, error);
      }
    },
  };
}
