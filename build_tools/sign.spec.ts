import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const sign = require('./sign.cjs');

describe('isBundledPython', () => {
  it("is true for the bundled Python's executables and libraries", () => {
    expect(sign.isBundledPython('C:\\b\\output\\win-unpacked\\resources\\python\\python.exe')).toBe(true);
    expect(sign.isBundledPython('C:\\b\\output\\win-unpacked\\resources\\python\\pythonw.exe')).toBe(true);
  });

  it('is false for the app, its installer, and the rest of resources', () => {
    expect(sign.isBundledPython('C:\\b\\output\\win-unpacked\\omni_keypad_designer.exe')).toBe(false);
    expect(sign.isBundledPython('C:\\b\\output\\omni_keypad_designer_setup_v0.1.0.exe')).toBe(false);
    expect(sign.isBundledPython('C:\\b\\output\\win-unpacked\\resources\\elevate.exe')).toBe(false);
    expect(sign.isBundledPython('C:\\b\\python\\resources\\app.exe')).toBe(false);
  });
});

describe('sign', () => {
  const packagerWith = (doSign: ReturnType<typeof vi.fn>) =>
    ({ signingManager: { value: Promise.resolve({ doSign }) } });
  const cert = { file: 'MyKey.pfx' };

  it('signs the app with the default signing', async () => {
    const doSign = vi.fn();
    const config = { path: 'C:\\b\\win-unpacked\\omni_keypad_designer.exe', cscInfo: cert };
    await sign(config, packagerWith(doSign));
    expect(doSign).toHaveBeenCalledWith(config, expect.anything());
  });

  it("leaves the bundled Python's own signature alone", async () => {
    const doSign = vi.fn();
    await sign({ path: 'C:\\b\\win-unpacked\\resources\\python\\python.exe', cscInfo: cert }, packagerWith(doSign));
    expect(doSign).not.toHaveBeenCalled();
  });

  it('does nothing without a certificate', async () => {
    const doSign = vi.fn();
    await sign({ path: 'C:\\b\\win-unpacked\\omni_keypad_designer.exe', cscInfo: null }, packagerWith(doSign));
    expect(doSign).not.toHaveBeenCalled();
  });
});
