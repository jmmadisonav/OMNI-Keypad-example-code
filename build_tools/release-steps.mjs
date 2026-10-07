// The parts of the release pipeline that are decisions rather than
// side effects, kept separate so they can be tested without building
// anything. Mirrors release.py's helpers of the same names.

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** Accepts '0.2.5' or 'v0.2.5'; returns canonical 'v0.2.5'.
 *
 * Strict on purpose. This one string names the installer, the zip and the
 * exe's version resource, so a typo here ships a mislabelled release --
 * which is discovered by whoever tries to work out what a laptop is
 * running, long after the fact. */
export function normalizeVersion(arg) {
  const match = VERSION.exec(String(arg).trim());
  if (!match) {
    throw new Error(`Invalid version ${JSON.stringify(arg)}; expected X.Y.Z or vX.Y.Z`);
  }
  const [, major, minor, patch] = match;
  return `v${major}.${minor}.${patch}`;
}

export function releaseNotesTemplate(version) {
  return `${version}\n\nFeatures:\n\n`;
}

/** True when nothing was written under the 'Features:' heading. */
export function notesAreEmpty(text) {
  const after = text.split('Features:').pop() ?? '';
  return after.trim() === '';
}

/** Renders a command line for logging with every secret masked -- release
 * output lands in terminal scrollback, and a release is exactly the moment
 * someone screenshares or pastes a build log. An empty/undefined secret is
 * skipped rather than masking every character, and masking is substring-
 * based so a secret embedded inside a longer argument is still caught. */
export function formatCommand(command, args, secrets = []) {
  const real = secrets.filter(secret => typeof secret === 'string' && secret.length > 0);
  const mask = arg => real.reduce((text, secret) => text.split(secret).join('***'), String(arg));
  return [command, ...args.map(mask)].join(' ');
}

/** True when saved release notes are for a different version than the one
 * being released now, meaning they are leftover from a previous run and
 * should be overwritten with a fresh template. The comparison has to be
 * robust to a trailing '\r': a file an editor saved with CRLF line endings
 * turns line 0 into "v0.2.5\r", which a bare '!==' treats as a mismatch --
 * silently overwriting the release notes the user just finished writing. */
export function notesAreStale(existing, version) {
  const firstLine = existing.split(/\r?\n/)[0] ?? '';
  return firstLine !== version;
}

/** Whether .env text carries a non-empty SIGNING_PASSWORD= line. Shared by
 * the real signing step, which needs the value, and the dry-run warning,
 * which only needs to know whether one is set, so both agree on what
 * "configured" means. */
export function hasSigningPassword(envText) {
  return envText.split(/\r?\n/).some(line => {
    const trimmed = line.trim();
    return trimmed.startsWith('SIGNING_PASSWORD=') && trimmed.slice('SIGNING_PASSWORD='.length).length > 0;
  });
}

/** Quotes an argument for a Windows shell command line when it contains
 * whitespace, so a `C:\Program Files (x86)\...` path survives as one
 * argument. Used only for the shell path run() takes to launch npm's .cmd
 * shim -- see the comment on run() for why that path needs its own
 * quoting instead of relying on spawnSync's normal argument handling. */
export function quoteForShell(arg) {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

/** The release notes as a GitHub release description: everything after the
 * version line, which the release title already carries. */
export function releaseNotesBody(text) {
  return text.split(/\r?\n/).slice(1).join('\n').trim();
}

/** Arguments for `gh release create`. `--verify-tag` makes gh refuse when
 * the tag isn't on GitHub yet, instead of creating one from whatever the
 * default branch holds there -- which, before a push, is not the commit
 * this installer was built from. */
export function ghReleaseArgs(version, installerPath, notesBody) {
  return [
    'release', 'create', version, installerPath,
    '--verify-tag',
    '--title', `OMNI Keypad Designer ${version}`,
    '--notes', notesBody,
  ];
}
