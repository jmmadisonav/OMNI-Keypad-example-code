// electron/license/serial.spec.ts
import { describe, expect, it } from 'vitest';
import { validateSerial } from './serial';

// Z three times (270) plus seventeen Ys (1513) scores 1783: inside 1773-1800.
const VALID = 'ZYYY-YYYY-YYYY-YYYZ-YYYZ';

describe('validateSerial', () => {
  it('accepts a well-formed serial, trimmed', () => {
    expect(validateSerial(VALID)).toBe(VALID);
    expect(validateSerial(`  ${VALID}\n`)).toBe(VALID);
  });

  it('returns empty for an empty serial', () => {
    expect(validateSerial('   ')).toBe('');
  });

  it('rejects a chunk that is not four characters', () => {
    expect(validateSerial('ZYYY-YYYY-YYYY-YYYZ-YYZ')).toBe('');
  });

  it('rejects a check digit that does not appear exactly three times', () => {
    expect(validateSerial('ZYYY-YYYY-YYYY-YYYY-YYYZ')).toBe('');
  });

  it('rejects a score outside 1773-1800', () => {
    // Same shape, but As in place of Ys score far too low.
    expect(validateSerial('ZAAA-AAAA-AAAA-AAAZ-AAAZ')).toBe('');
  });
});
