// electron-builder's signing hook (signtoolOptions.sign in electron-builder.yml).
//
// electron-builder signs every .exe it copies in as an extra resource, and it
// doesn't check whether one is already signed. A plain `signtool sign`
// replaces the existing signature, so without this hook a signed build would
// strip the Python Software Foundation's signature from the bundled
// python.exe and pythonw.exe and put ours on them instead. They're Python's
// files, already signed by their publisher, so they keep that signature.
// Everything else is signed exactly as electron-builder would.
const path = require('node:path');

/** Whether `file` is part of the bundled Python runtime (resources/python). */
function isBundledPython(file) {
  const parts = path.normalize(file).split(/[\\/]/);
  const i = parts.lastIndexOf('resources');
  return i >= 0 && parts[i + 1] === 'python';
}

async function sign(configuration, packager) {
  // With a hook set, electron-builder calls it even when there's no
  // certificate to sign with -- an unsigned `npm run package`.
  if (!configuration.cscInfo) { return; }
  if (isBundledPython(configuration.path)) {
    console.log(`  • keeping the publisher's signature  file=${configuration.path}`);
    return;
  }
  const manager = await packager.signingManager.value;
  await manager.doSign(configuration, packager);
}

module.exports = sign;
module.exports.default = sign;
module.exports.isBundledPython = isBundledPython;
