// Stages what the installed app runs: Python's official embeddable runtime
// in build/python, and the designer's own files in build/designer.
// electron-builder.yml ships both as extra resources, and electron/paths.ts
// finds them there. The designer uses only the standard library, so the
// embeddable runtime is all it needs: users don't install Python.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT } from './project-config.mjs';

/** Python 3.10 or later runs the designer. Change this to move to a newer
 * one; the download is cached under build/cache by version. */
export const PYTHON_VERSION = '3.13.9';

export const BUILD_DIR = path.join(ROOT, 'build');
const CACHE_DIR = path.join(BUILD_DIR, 'cache');

export function embedZipName(version = PYTHON_VERSION) {
  return `python-${version}-embed-amd64.zip`;
}

export function embedZipUrl(version = PYTHON_VERSION) {
  return `https://www.python.org/ftp/python/${version}/${embedZipName(version)}`;
}

/** The files the designer's server needs, relative to the repo root: the
 * shared modules it imports, the designer package with its models, page and
 * vendored fonts and icons, and the Keypad Graphics artwork. */
export const DESIGNER_SOURCES = [
  'hcontrol.py',
  'keypad_design.py',
  '03_upload_design.py',
  'designer',
  'docs/Keypad Graphics.zip',
];

/** Whether a path under designer/ ships. Not your projects, backups, or
 * library, which live in Documents; not tests, caches, or the render check. */
export function shipsInDesigner(relative) {
  const parts = relative.split(/[\\/]/);
  if (parts.some(part => part === '__pycache__')) { return false; }
  if (['projects', 'backups', 'library'].includes(parts[1])) { return false; }
  const name = parts.at(-1);
  return !name.endsWith('.test.mjs') && name !== 'render-check.html';
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.error) { throw new Error(`Couldn't run ${command}: ${result.error.message}`); }
  if (result.status !== 0) { throw new Error(`${command} exited with ${result.status}`); }
}

async function downloadPython() {
  mkdirSync(CACHE_DIR, { recursive: true });
  const zip = path.join(CACHE_DIR, embedZipName());
  if (existsSync(zip) && statSync(zip).size > 0) {
    console.log(`  Python ${PYTHON_VERSION}: using the cached ${path.relative(ROOT, zip)}`);
    return zip;
  }
  console.log(`  Python ${PYTHON_VERSION}: downloading ${embedZipUrl()}`);
  const response = await fetch(embedZipUrl());
  if (!response.ok) { throw new Error(`Download failed (${response.status}): ${embedZipUrl()}`); }
  writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
  return zip;
}

function stagePython(zip) {
  const target = path.join(BUILD_DIR, 'python');
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  // Windows' own tar (bsdtar) reads zip files. Named by its full path: in a
  // Git Bash shell, plain `tar` is GNU tar, which reads "C:" as a host name.
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  run(existsSync(tar) ? tar : 'tar', ['-xf', zip, '-C', target]);
  return path.join(target, 'python.exe');
}

function stageDesigner() {
  const target = path.join(BUILD_DIR, 'designer');
  rmSync(target, { recursive: true, force: true });
  for (const source of DESIGNER_SOURCES) {
    const from = path.join(ROOT, source);
    if (!existsSync(from)) { throw new Error(`Missing ${source}`); }
    cpSync(from, path.join(target, source), {
      recursive: true,
      filter: file => shipsInDesigner(path.relative(ROOT, file)),
    });
  }
  console.log(`  Designer: ${countFiles(target)} files in ${path.relative(ROOT, target)}`);
  return target;
}

function countFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .reduce((n, entry) => n + (entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1), 0);
}

async function main() {
  console.log('Staging the bundled Python and the designer');
  const python = stagePython(await downloadPython());
  const designer = stageDesigner();
  // Precompile with the bundled Python, so the installed app doesn't try to
  // write bytecode into Program Files on every start.
  run(python, ['-I', '-m', 'compileall', '-q', designer]);
  // A quick check that the bundled Python can load the server and everything
  // it imports, before electron-builder packs it.
  run(python, ['-I', '-c',
    `import sys; sys.path.insert(0, ${JSON.stringify(designer)}); import designer.server; print("  Server imports OK")`]);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`\n${error.message}`);
    process.exit(1);
  });
}
