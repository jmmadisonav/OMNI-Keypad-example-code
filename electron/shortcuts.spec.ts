// electron/shortcuts.spec.ts
import { describe, expect, it } from 'vitest';
import { shortcutFor } from './shortcuts';

const key = (k: string, mods: Partial<{ control: boolean; shift: boolean; alt: boolean; meta: boolean }> = {}) =>
  ({ type: 'keyDown', key: k, control: false, shift: false, alt: false, meta: false, ...mods });

describe('shortcutFor', () => {
  it('maps the browser shortcuts people expect', () => {
    expect(shortcutFor(key('I', { control: true, shift: true }))).toBe('devtools');
    expect(shortcutFor(key('F12'))).toBe('devtools');
    expect(shortcutFor(key('r', { control: true }))).toBe('reload');
    expect(shortcutFor(key('F5'))).toBe('reload');
    expect(shortcutFor(key('=', { control: true }))).toBe('zoom-in');
    expect(shortcutFor(key('+', { control: true, shift: true }))).toBe('zoom-in');
    expect(shortcutFor(key('-', { control: true }))).toBe('zoom-out');
    expect(shortcutFor(key('0', { control: true }))).toBe('zoom-reset');
    expect(shortcutFor(key('F11'))).toBe('fullscreen');
  });

  it("leaves the designer's own keys to the page", () => {
    expect(shortcutFor(key('z', { control: true }))).toBeNull();
    expect(shortcutFor(key('y', { control: true }))).toBeNull();
    expect(shortcutFor(key('c', { control: true }))).toBeNull();
    expect(shortcutFor(key('r'))).toBeNull();
    expect(shortcutFor(key('i', { control: true }))).toBeNull();
  });

  it('acts on key presses only', () => {
    expect(shortcutFor({ ...key('F5'), type: 'keyUp' })).toBeNull();
  });
});
