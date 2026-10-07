import { describe, expect, it } from 'vitest';
import {
  formatCommand,
  ghReleaseArgs,
  hasSigningPassword,
  normalizeVersion,
  notesAreEmpty,
  notesAreStale,
  quoteForShell,
  releaseNotesBody,
  releaseNotesTemplate,
} from './release-steps.mjs';

describe('normalising a version', () => {
  it('accepts a bare version and adds the v', () => {
    expect(normalizeVersion('0.2.5')).toBe('v0.2.5');
  });

  it('accepts one that already has the v', () => {
    expect(normalizeVersion('v0.2.5')).toBe('v0.2.5');
  });

  it('ignores surrounding whitespace', () => {
    expect(normalizeVersion('  0.2.5 ')).toBe('v0.2.5');
  });

  // A mislabelled release is worse than a refused one: the installer, the
  // zip and the exe resource all take their name from this string.
  it.each(['0.2', '0.2.5.1', 'v', 'latest', '0.2.x', ''])('rejects %o', bad => {
    expect(() => normalizeVersion(bad)).toThrow(/expected/i);
  });
});

describe('release notes', () => {
  it('starts the template with the version, so a stale file is detectable', () => {
    expect(releaseNotesTemplate('v0.2.5').split('\n')[0]).toBe('v0.2.5');
  });

  it('offers a Features heading to write under', () => {
    expect(releaseNotesTemplate('v0.2.5')).toContain('Features:');
  });

  it('treats notes with nothing under the heading as empty', () => {
    expect(notesAreEmpty('v0.2.5\n\nFeatures:\n\n')).toBe(true);
  });

  it('treats notes with anything under the heading as written', () => {
    expect(notesAreEmpty('v0.2.5\n\nFeatures:\n\n- Mute from the matrix row\n')).toBe(false);
  });
});

describe('formatting a command for logging', () => {
  it('renders the plain command line when no secrets are given', () => {
    expect(formatCommand('npm', ['run', 'package'])).toBe('npm run package');
  });

  it('masks a secret that appears as its own argument', () => {
    expect(formatCommand('signtool', ['/p', 'hunter2'], ['hunter2'])).toBe('signtool /p ***');
  });

  it('masks a secret embedded inside a longer argument', () => {
    expect(formatCommand('cmd', ['/DMyAppVersion=hunter2'], ['hunter2'])).toBe(
      'cmd /DMyAppVersion=***',
    );
  });

  it('ignores an empty-string secret instead of matching everywhere', () => {
    expect(formatCommand('npm', ['run', 'package'], [''])).toBe('npm run package');
  });

  it('ignores an undefined secret', () => {
    expect(formatCommand('npm', ['run', 'package'], [undefined])).toBe('npm run package');
  });
});

describe('checking whether saved release notes are stale', () => {
  it('treats notes for a different version as stale', () => {
    expect(notesAreStale('v0.2.4\n\nFeatures:\n\n', 'v0.2.5')).toBe(true);
  });

  it('treats notes for the current version as current', () => {
    expect(notesAreStale('v0.2.5\n\nFeatures:\n\n', 'v0.2.5')).toBe(false);
  });

  // A file saved with CRLF line endings puts a trailing '\r' on line 0. A
  // bare string comparison would call that stale and silently overwrite
  // notes the user just finished writing.
  it('treats notes for the current version as current even with CRLF endings', () => {
    expect(notesAreStale('v0.2.5\r\n\r\nFeatures:\r\n\r\n', 'v0.2.5')).toBe(false);
  });

  it('treats an empty file (no notes yet) as stale', () => {
    expect(notesAreStale('', 'v0.2.5')).toBe(true);
  });
});

describe('checking whether .env carries a signing password', () => {
  it('is true when SIGNING_PASSWORD has a value', () => {
    expect(hasSigningPassword('SIGNING_PASSWORD=hunter2\n')).toBe(true);
  });

  it('is false when SIGNING_PASSWORD is empty', () => {
    expect(hasSigningPassword('SIGNING_PASSWORD=\n')).toBe(false);
  });

  it('is false when SIGNING_PASSWORD is absent entirely', () => {
    expect(hasSigningPassword('SOME_OTHER_VAR=1\n')).toBe(false);
  });

  it('is false for an empty file', () => {
    expect(hasSigningPassword('')).toBe(false);
  });

  it('finds the value among other lines, CRLF endings included', () => {
    expect(hasSigningPassword('FOO=1\r\nSIGNING_PASSWORD=hunter2\r\nBAR=2\r\n')).toBe(true);
  });
});

describe('quoting an argument for a Windows shell command line', () => {
  it('leaves a plain argument alone', () => {
    expect(quoteForShell('run')).toBe('run');
  });

  it('quotes an argument containing a space', () => {
    expect(quoteForShell('C:\\Program Files (x86)\\Windows Kits\\10\\bin\\x64\\signtool.exe')).toBe(
      '"C:\\Program Files (x86)\\Windows Kits\\10\\bin\\x64\\signtool.exe"',
    );
  });

  it('leaves an already-short argument with no whitespace alone', () => {
    expect(quoteForShell('--allow-same-version')).toBe('--allow-same-version');
  });
});

describe('the GitHub release description', () => {
  it('drops the version line, which the title already carries', () => {
    expect(releaseNotesBody('v0.2.5\r\n\r\nFeatures:\r\n- Faster loads\r\n')).toBe('Features:\n- Faster loads');
  });
});

describe('the gh release command', () => {
  it('uploads the installer against a tag that must already exist', () => {
    expect(ghReleaseArgs('v0.2.5', 'output/setup.exe', 'Features:')).toEqual([
      'release', 'create', 'v0.2.5', 'output/setup.exe',
      '--verify-tag',
      '--title', 'OMNI Keypad Designer v0.2.5',
      '--notes', 'Features:',
    ]);
  });
});
