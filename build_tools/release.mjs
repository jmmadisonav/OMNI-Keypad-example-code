#!/usr/bin/env node
// Local one-command release builder. The Node counterpart of release.py in
// basic_gui_functions, step for step, so that cutting a release feels the
// same whichever language the project is written in.
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
// Pinned to 7.x deliberately: 8.0.0 removed the default-export callable
// API (`archiver('zip', options)`) this file uses, in favour of named
// classes. Bumping past 7.x means migrating this function first.
import archiver from 'archiver';
import { ROOT, installerExeName, releaseZipName } from './project-config.mjs';
import {
  formatCommand,
  hasSigningPassword,
  normalizeVersion,
  notesAreEmpty,
  notesAreStale,
  quoteForShell,
  releaseNotesTemplate,
} from './release-steps.mjs';

const OUTPUT_DIR = path.join(ROOT, 'output');

/** The code-signing certificate, in the work OneDrive. Its password comes
 * from .env. OneDriveCommercial is the work account's folder, which Windows
 * sets for each user; OneDrive is the fallback on a machine with only one. */
const SIGNING_CERT = path.join(
  process.env.OneDriveCommercial ?? process.env.OneDrive ?? '', 'WindowSigningCert', 'MyKey.pfx',
);

/** `env` is added to this process's environment for the child, and never
 * logged: it is how the signing password reaches electron-builder. */
function run(command, args, dryRun, cwd = ROOT, secrets = [], env = {}) {
  const envNote = Object.keys(env).length ? ` [with ${Object.keys(env).join(', ')} set]` : '';
  console.log(`  RUN (${cwd}): ${formatCommand(command, args, secrets)}${envNote}`);
  if (dryRun) { return; }
  // npm on Windows is npm.cmd, a batch file. spawnSync with shell: false
  // calls CreateProcess directly, which can only launch real executables --
  // it cannot run a .cmd at all, and fails with ENOENT rather than falling
  // back to a shell. Real tools (like cmd.exe itself) don't have this
  // problem and are left on shell: false, where spawnSync's own Windows
  // argument escaping already handles paths with spaces correctly; routing
  // them through a shell too would trade that for a second, less careful
  // quoting pass with nothing to gain.
  //
  // For npm, a shell is unavoidable. But when shell is truthy, Node builds
  // the command line by joining command and args with bare spaces before
  // handing the whole line to cmd.exe (see normalizeSpawnArguments in
  // node's lib/child_process.js) -- it does not quote each argument first.
  // So any argument containing whitespace, such as a `C:\Program Files
  // (x86)\...` path passed through to npm, has to be quoted here ourselves
  // or cmd.exe tears it into multiple arguments.
  //
  // That join is done here rather than left to Node, so the shell gets one
  // command string and no argument array: Node 24 warns (DEP0190) whenever
  // args are passed alongside `shell: true`, because it only concatenates
  // them. The command line is the same either way.
  const useShell = process.platform === 'win32' && command === 'npm';
  const childEnv = { ...process.env, ...env };
  const result = useShell
    ? spawnSync([command, ...args.map(quoteForShell)].join(' '), { cwd, env: childEnv, stdio: 'inherit', shell: true })
    : spawnSync(command, args, { cwd, env: childEnv, stdio: 'inherit', shell: false });
  if (result.error) {
    throw new Error(`Failed to run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status ?? result.signal}`);
  }
}

/** The signing password, read from .env at the repo root. Never a literal
 * in this file, and .env is gitignored -- see .env.example. */
function signingPassword() {
  const envPath = path.join(ROOT, '.env');
  if (!existsSync(envPath)) {
    throw new Error('.env not found. Copy .env.example and set SIGNING_PASSWORD.');
  }
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('SIGNING_PASSWORD=')) {
      const value = trimmed.slice('SIGNING_PASSWORD='.length);
      if (value) { return value; }
    }
  }
  throw new Error('SIGNING_PASSWORD is empty in .env.');
}

function bumpVersion(version, dryRun) {
  // --no-git-tag-version: this script does not touch git, matching
  // release.py, which leaves the git flow as a deliberate manual step.
  // npm updates package.json AND package-lock.json together, which is why
  // the version is bumped through npm rather than by editing JSON.
  console.log(`  Bump version -> ${version.slice(1)} in package.json`);
  run('npm', ['version', version.slice(1), '--no-git-tag-version', '--allow-same-version'], dryRun);
}

async function captureReleaseNotes(version, dryRun) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const notesPath = path.join(OUTPUT_DIR, 'release_notes.txt');
  const existing = existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : '';
  if (notesAreStale(existing, version)) {
    console.log(`  Write release notes template -> ${notesPath}`);
    if (!dryRun) { writeFileSync(notesPath, releaseNotesTemplate(version), 'utf8'); }
  }
  if (dryRun) { return notesPath; }

  run('cmd', ['/c', 'start', '', notesPath], false);
  const rl = createInterface({ input: stdin, output: stdout });
  await rl.question('  Edit the release notes, save, then press Enter to continue... ');
  if (notesAreEmpty(readFileSync(notesPath, 'utf8'))) {
    const answer = await rl.question('  Release notes look empty. Continue anyway? [y/N] ');
    if (answer.trim().toLowerCase() !== 'y') {
      rl.close();
      throw new Error('Aborted: empty release notes.');
    }
  }
  rl.close();
  return notesPath;
}

/** Warns during a dry run when the real run's signing would fail for lack
 * of configuration. Without this, a dry run passes happily with no
 * SIGNING_PASSWORD set, and the real run then dies at the build -- after
 * the version has been bumped. A warning, not a thrown error: a dry run
 * must still finish. */
function warnIfSigningNotConfigured() {
  const envPath = path.join(ROOT, '.env');
  const configured = existsSync(envPath) && hasSigningPassword(readFileSync(envPath, 'utf8'));
  if (!configured) {
    console.warn(
      '  WARNING: .env is missing or SIGNING_PASSWORD is not set. ' +
      'Signing will fail on a real run -- copy .env.example and set it first.',
    );
  }
  if (!existsSync(SIGNING_CERT)) {
    console.warn(`  WARNING: the signing certificate is not at ${SIGNING_CERT}.`);
  }
}

/**
 * Builds the app and its NSIS installer, signed, in one electron-builder run.
 *
 * electron-builder signs the app exe, the installer and the uninstaller
 * itself when WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD are set, so there is no
 * separate signing step. They are set for this command only, never written
 * anywhere: `npm run installer` on its own builds unsigned.
 */
function buildInstaller(dryRun) {
  if (dryRun) {
    warnIfSigningNotConfigured();
    run('npm', ['run', 'installer'], true, ROOT, [], { WIN_CSC_LINK: '', WIN_CSC_KEY_PASSWORD: '' });
    return;
  }
  if (!existsSync(SIGNING_CERT)) {
    throw new Error(`Signing certificate not found: ${SIGNING_CERT}`);
  }
  const password = signingPassword();
  run('npm', ['run', 'installer'], false, ROOT, [password], {
    WIN_CSC_LINK: SIGNING_CERT,
    WIN_CSC_KEY_PASSWORD: password,
  });
}

async function packageZip(version, notesPath, dryRun) {
  const installer = path.join(OUTPUT_DIR, installerExeName(version));
  const zipPath = path.join(OUTPUT_DIR, releaseZipName(version));
  console.log(`  Package -> ${zipPath}`);
  if (dryRun) { return zipPath; }
  if (!existsSync(installer)) {
    throw new Error(`Installer not found: ${installer}`);
  }
  await new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const out = createWriteStream(zipPath);
    out.on('close', resolve);
    out.on('error', reject);
    archive.on('error', reject);
    archive.pipe(out);
    archive.file(installer, { name: path.basename(installer) });
    archive.file(notesPath, { name: path.basename(notesPath) });
    archive.finalize();
  });
  return zipPath;
}

/** The version package.json actually carries right now, read fresh off
 * disk rather than tracked in a variable -- what matters after a failure
 * is the file's real state, not what this process last believed it to be. */
function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main(argv) {
  const args = argv.filter(a => a !== '--dry-run');
  const dryRun = argv.includes('--dry-run');
  if (args.length !== 1) {
    console.error('Usage: npm run release -- <version> [--dry-run]');
    process.exit(2);
  }
  const version = normalizeVersion(args[0]);
  console.log(`Releasing omni_keypad_designer ${version}${dryRun ? ' [DRY RUN]' : ''}`);

  console.log('[1/4] Bump version');
  bumpVersion(version, dryRun);
  console.log('[2/4] Release notes');
  const notesPath = await captureReleaseNotes(version, dryRun);
  console.log('[3/4] Build and sign the app and its installer (main process + bundled Python + electron-builder NSIS)');
  buildInstaller(dryRun);
  console.log('[4/4] Package zip');
  const zipPath = await packageZip(version, notesPath, dryRun);

  console.log(`\nDone. Artifact: ${zipPath}`);
  console.log(
    `Remaining manual steps: complete git flow (merge, tag ${version}, push the tag), then\n`
    + `  npm run release:publish -- ${version}`,
  );
}

const dryRunRequested = process.argv.includes('--dry-run');

main(process.argv.slice(2)).catch(error => {
  console.error(`\n${error.message}`);
  // Step 1 bumps package.json and package-lock.json before anything else
  // runs, so a failure in a later step leaves the tree at the new version
  // with no other sign of it. Say so, and say what to do about it -- a
  // dry run never touches package.json, so this only applies to a real run.
  if (!dryRunRequested) {
    console.error(`\nThe working tree is now at version ${readPackageVersion()}.`);
    console.error('Re-running the same release command is safe: the version bump uses --allow-same-version.');
    console.error(`Check ${OUTPUT_DIR} for files a partially completed release may have left behind.`);
  }
  process.exit(1);
});
