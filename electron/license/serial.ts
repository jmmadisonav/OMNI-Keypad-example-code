// electron/license/serial.ts

/**
 * The serial number with surrounding whitespace removed, or `''` when it is
 * not a well-formed serial.
 *
 * This is license_base's offline format check, unchanged: groups of four
 * characters separated by hyphens, the first character appearing exactly
 * three times in total, and the character codes (hyphens excluded) summing to
 * between 1773 and 1800. Passing it means only that the serial COULD be
 * genuine; the server decides whether it is.
 */
export function validateSerial(serial: string): string {
  const trimmed = serial.trim();
  if (trimmed === '') { return ''; }
  const checkDigit = [...trimmed][0];
  let score = 0;
  let checkDigitCount = 0;
  for (const chunk of trimmed.split('-')) {
    // Spread, not .length: Python counts code points, not UTF-16 units.
    const chars = [...chunk];
    if (chars.length !== 4) { return ''; }
    for (const char of chars) {
      if (char === checkDigit) { checkDigitCount++; }
      score += char.codePointAt(0) ?? 0;
    }
  }
  return score >= 1773 && score <= 1800 && checkDigitCount === 3 ? trimmed : '';
}
