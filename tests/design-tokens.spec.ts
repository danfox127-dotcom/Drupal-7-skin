import { test, expect } from '@playwright/test';
// @ts-expect-error - tokens.js is plain JS, excluded from tsconfig (allowJs: false)
import { CONTRAST_PAIRS, NON_TEXT_PAIRS, DECORATIVE_PAIRS, FORBIDDEN_PAIRS, TEXT_BACKGROUNDS, cu, ink, olive, rule } from '../src/styles/tokens.js';

/**
 * The handoff makes WCAG 2.2 AA mandatory and singles out two traps: white text
 * on Columbia Blue, and greens other than #76881D. Comments do not enforce that,
 * so these tests measure it. A new foreground/background combination is added to
 * CONTRAST_PAIRS in tokens.js, and fails here if it does not clear AA.
 *
 * Pure computation — no browser is launched.
 */

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Not a 6-digit hex color: ${hex}`);
  const int = parseInt(m[1], 16);
  const r = srgbToLinear((int >> 16) & 0xff);
  const g = srgbToLinear((int >> 8) & 0xff);
  const b = srgbToLinear(int & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, 1–21. */
function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

/** AA for normal-size text. Large text (>=18.66px bold / 24px) needs only 3.0. */
const AA_NORMAL = 4.5;
const AA_LARGE = 3.0;

test.describe('design tokens: WCAG 2.2 AA', () => {
  test('contrast helper matches known reference values', () => {
    // Sanity-check the math before trusting it on the palette: black on white
    // is exactly 21:1, and identical colors are exactly 1:1.
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    // Order must not matter.
    expect(contrastRatio('#1D4F91', '#FFFFFF')).toBeCloseTo(
      contrastRatio('#FFFFFF', '#1D4F91'), 5
    );
  });

  for (const [fg, bg, label, isLarge] of CONTRAST_PAIRS as [string, string, string, boolean?][]) {
    test(`${label} (${fg} on ${bg}) clears AA`, () => {
      const ratio = contrastRatio(fg, bg);
      const threshold = isLarge ? AA_LARGE : AA_NORMAL;
      expect(
        ratio,
        `${label}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${threshold}:1`
      ).toBeGreaterThanOrEqual(threshold);
    });
  }

  for (const [fg, bg, label] of NON_TEXT_PAIRS as [string, string, string][]) {
    test(`${label} (${fg} on ${bg}) clears the 3:1 non-text threshold`, () => {
      const ratio = contrastRatio(fg, bg);
      expect(
        ratio,
        `${label}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${AA_LARGE}:1`
      ).toBeGreaterThanOrEqual(AA_LARGE);
    });
  }

  for (const [fg, bg, label] of DECORATIVE_PAIRS as [string, string, string][]) {
    test(`${label} (${fg} on ${bg}) is decorative, below the 3:1 control threshold`, () => {
      // Deliberately asserting it is LOW. These are separators, not control
      // boundaries; if one needs to identify a control, use rule.control.
      expect(contrastRatio(fg, bg)).toBeLessThan(AA_LARGE);
    });
  }

  test('control borders clear 3:1 where decorative rules do not', () => {
    expect(rule.control).toBe('#8B8B8A');
    expect(contrastRatio(rule.control, '#FFFFFF')).toBeGreaterThanOrEqual(AA_LARGE);
    expect(contrastRatio(rule.DEFAULT, '#FFFFFF')).toBeLessThan(AA_LARGE);
  });

  for (const [fg, bg, label] of FORBIDDEN_PAIRS as [string, string, string][]) {
    test(`${label} really does fail AA, so the ban is justified`, () => {
      // If one of these ever passes, the value it is based on changed and the
      // rule should be revisited rather than silently ignored.
      expect(contrastRatio(fg, bg)).toBeLessThan(AA_NORMAL);
    });
  }

  test('the text-safe muted gray clears AA on every text background', () => {
    expect(ink.help).toBe('#696C6F');
    for (const bg of TEXT_BACKGROUNDS as string[]) {
      expect(contrastRatio(ink.help, bg), `ink.help on ${bg}`).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });

  test('olive keeps its brand value for fills and a text-safe variant for labels', () => {
    expect(olive.DEFAULT).toBe('#76881D');
    expect(olive.text).toBe('#637218');
    for (const bg of TEXT_BACKGROUNDS as string[]) {
      expect(contrastRatio(olive.text, bg), `olive.text on ${bg}`).toBeGreaterThanOrEqual(AA_NORMAL);
    }
    // The brand fill is still legitimate as a non-text element.
    expect(contrastRatio(olive.DEFAULT, '#FFFFFF')).toBeGreaterThanOrEqual(AA_LARGE);
  });

  test('text on Columbia Blue uses the permitted color', () => {
    expect(cu.onLight).toBe('#12365F');
    expect(contrastRatio(cu.onLight, cu.light)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  test('placeholder gray is never treated as AA-passing text', () => {
    // Documents intent: #9A9A97 is legitimate only for disabled/placeholder
    // content, which WCAG exempts. If someone raises it to pass AA, that is a
    // palette change that should be deliberate.
    expect(contrastRatio(ink.placeholder, '#FFFFFF')).toBeLessThan(AA_NORMAL);
  });
});
