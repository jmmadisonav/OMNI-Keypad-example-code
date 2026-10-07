// electron/shortcuts.ts
//
// The window has no menu: the designer's own header is the app's menu. These
// are the shortcuts a menu would otherwise have provided, handled before the
// page sees the key. Cut, copy, paste, and select all work without a menu on
// Windows, and Ctrl+Z and Ctrl+Y belong to the designer's own undo.

export type Shortcut = 'devtools' | 'reload' | 'zoom-in' | 'zoom-out' | 'zoom-reset' | 'fullscreen';

/** The parts of Electron's `Input` this reads. */
export interface KeyInput {
  type: string;
  key: string;
  control: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

export function shortcutFor(input: KeyInput): Shortcut | null {
  if (input.type !== 'keyDown' || input.alt || input.meta) { return null; }
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  if (!input.control) {
    if (input.shift) { return null; }
    return ({ F5: 'reload', F11: 'fullscreen', F12: 'devtools' } as Record<string, Shortcut>)[key] ?? null;
  }
  if (input.shift && key === 'i') { return 'devtools'; }
  if (key === '=' || key === '+') { return 'zoom-in'; }
  if (input.shift) { return null; }
  return ({ r: 'reload', '-': 'zoom-out', '0': 'zoom-reset' } as Record<string, Shortcut>)[key] ?? null;
}
