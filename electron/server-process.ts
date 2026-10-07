// electron/server-process.ts
//
// Starts the designer's Python server (designer/server.py) and waits until it
// says where it's listening. The window then loads that address, so the app
// is the same page you get from `python designer/server.py`.
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';

/** The port the server tries first. A fixed port keeps the page's origin the
 * same from one run to the next, so what the page remembers (the keypad
 * address, the drawer's size) survives a restart. */
export const PREFERRED_PORT = 8044;

const START_TIMEOUT_MS = 20_000;

/** The address in the server's "Button designer running at ..." line, or null. */
export function parseServerUrl(line: string): string | null {
  return /http:\/\/127\.0\.0\.1:\d+\//.exec(line)?.[0] ?? null;
}

/**
 * The server's command line, after the interpreter.
 *
 * `-I` isolates Python from any PYTHONPATH or user site-packages on the
 * machine; server.py puts its own folder on the path. `--any-port` moves to a
 * free port when another program has 8044. `--exit-with-parent` stops the
 * server when its standard input closes, which happens whenever the app exits,
 * even if it crashes.
 */
export function serverArgs(root: string, dataDir: string): string[] {
  return [
    '-I', path.join(root, 'designer', 'server.py'),
    '--no-browser', '--port', String(PREFERRED_PORT), '--any-port',
    '--data-dir', dataDir, '--exit-with-parent',
  ];
}

export interface RunningServer {
  url: string;
  child: ChildProcess;
}

/** The last few lines of what the server wrote to stderr, for an error message. */
function tail(text: string, lines = 12): string {
  return text.trim().split(/\r?\n/).slice(-lines).join('\n');
}

/**
 * Starts the server and resolves with its address once it's listening.
 * Rejects, with what the server printed, if it exits or doesn't start in time.
 */
export function startServer(python: string, args: string[], timeoutMs = START_TIMEOUT_MS): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = (message: string) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) { child.kill(); }
      const output = tail(stderr || stdout);
      reject(new Error(output ? `${message}\n\n${output}` : message));
    };
    const timer = setTimeout(() => fail(`The designer didn't start within ${timeoutMs / 1000} seconds.`), timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const url = parseServerUrl(stdout);
      if (url && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ url, child });
      }
    });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', error => fail(`Couldn't run ${python}: ${error.message}`));
    child.on('exit', code => fail(`The designer stopped (exit code ${code}).`));
  });
}
