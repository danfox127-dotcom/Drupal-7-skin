import { test, expect } from '@playwright/test';
import { isNewer, evaluateUpdate, parseLatest } from '../src/lib/updateCheck';

/**
 * Version comparison and the update decision.
 *
 * Pure logic, so this imports the module directly rather than bundling it into a page
 * the way the DOM-dependent specs have to.
 *
 * The reason it is worth testing at all: a string compare gets "0.10.0" wrong against
 * "0.9.0", and an extension that wrongly believes itself current is silent forever —
 * which is the exact failure the notifier exists to prevent.
 */

test.describe('version comparison', () => {
  test('a higher patch, minor or major is newer', () => {
    expect(isNewer('0.1.1', '0.1.0')).toBe(true);
    expect(isNewer('0.2.0', '0.1.9')).toBe(true);
    expect(isNewer('1.0.0', '0.9.9')).toBe(true);
  });

  test('the same version is not newer', () => {
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
  });

  test('an older version is not newer', () => {
    expect(isNewer('0.1.0', '0.1.1')).toBe(false);
    expect(isNewer('0.9.0', '1.0.0')).toBe(false);
  });

  test('components compare numerically, not as strings', () => {
    // "0.10.0" < "0.9.0" as text. This is the bug the whole function exists to avoid.
    expect(isNewer('0.10.0', '0.9.0')).toBe(true);
    expect(isNewer('0.9.0', '0.10.0')).toBe(false);
    expect(isNewer('1.0.0', '0.100.0')).toBe(true);
  });

  test('missing trailing components count as zero', () => {
    // Chrome allows 1-4 dot-separated integers, so "1.2" is a legal extension version.
    expect(isNewer('1.2', '1.2.0')).toBe(false);
    expect(isNewer('1.2.1', '1.2')).toBe(true);
    expect(isNewer('2', '1.9.9')).toBe(true);
  });

  test('a fourth component is respected, as Chrome permits', () => {
    expect(isNewer('1.0.0.2', '1.0.0.1')).toBe(true);
    expect(isNewer('1.0.0.1', '1.0.0.2')).toBe(false);
  });

  test('unparseable input is never treated as newer', () => {
    // Better to stay quiet than to nag on every browser start because a served file
    // was malformed or an error page came back as text.
    expect(isNewer('', '0.1.0')).toBe(false);
    expect(isNewer('not-a-version', '0.1.0')).toBe(false);
    expect(isNewer('<!DOCTYPE html>', '0.1.0')).toBe(false);
  });
});

test.describe('reading the published version file', () => {
  test('accepts a well-formed payload', () => {
    const parsed = parseLatest({
      version: '0.2.0',
      notes: 'Publish now publishes.',
      download: 'https://example.org/x.zip',
    });
    expect(parsed).toEqual({
      version: '0.2.0',
      notes: 'Publish now publishes.',
      download: 'https://example.org/x.zip',
    });
  });

  test('notes and download are optional', () => {
    expect(parseLatest({ version: '0.2.0' })?.version).toBe('0.2.0');
  });

  test('rejects anything without a usable version', () => {
    expect(parseLatest(null)).toBeNull();
    expect(parseLatest('0.2.0')).toBeNull();
    expect(parseLatest({})).toBeNull();
    expect(parseLatest({ version: 42 })).toBeNull();
    expect(parseLatest({ version: 'banana' })).toBeNull();
  });

  test('a download link must be https, not javascript: or http:', () => {
    // The popup renders this as an anchor the user clicks, so the scheme is a real
    // decision rather than a formality.
    expect(parseLatest({ version: '0.2.0', download: 'javascript:alert(1)' })?.download)
      .toBeUndefined();
    expect(parseLatest({ version: '0.2.0', download: 'http://example.org/x.zip' })?.download)
      .toBeUndefined();
    expect(parseLatest({ version: '0.2.0', download: 'https://example.org/x.zip' })?.download)
      .toBe('https://example.org/x.zip');
  });
});

test.describe('the update decision', () => {
  test('reports an available update', () => {
    const state = evaluateUpdate('0.1.0', { version: '0.2.0', notes: 'stuff' });
    expect(state.available).toBe(true);
    expect(state.latest).toBe('0.2.0');
    expect(state.notes).toBe('stuff');
  });

  test('reports nothing when current', () => {
    expect(evaluateUpdate('0.2.0', { version: '0.2.0' }).available).toBe(false);
  });

  test('reports nothing when the installed build is ahead of the published one', () => {
    // A developer running a local build must not be told to downgrade.
    expect(evaluateUpdate('0.3.0', { version: '0.2.0' }).available).toBe(false);
  });

  test('an unreadable payload is not an update', () => {
    expect(evaluateUpdate('0.1.0', null).available).toBe(false);
  });
});
