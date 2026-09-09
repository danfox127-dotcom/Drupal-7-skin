#!/usr/bin/env node
/**
 * Second gate on a captured fixture, before it is committed.
 *
 * captureFixture already scrubs, and it is tested. This exists anyway because the two
 * failure modes it cannot cover are the ones that matter:
 *
 *   - The scrubber runs in the browser. What gets committed is a file on disk, and
 *     anything can happen between the two — a hand edit, a paste from the wrong window,
 *     a stale clipboard.
 *   - The scrubber only knows the categories it was taught. This looks for the SHAPE of
 *     a secret instead, so something nobody anticipated still has a chance of being
 *     caught.
 *
 * The repository is public. A live Columbia admin form is the one artefact in this project
 * where a mistake is not recoverable by a later commit.
 *
 * Usage:
 *   node scripts/check-capture.mjs <file...>
 *   npm run check:capture -- tests/fixtures/node-add-page.html
 *
 * Exits 1 on anything that must not be committed, 0 otherwise. Warnings do not fail.
 */

import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Security fields, judged by their VALUE rather than their name.
 *
 * A first version of this check flagged the field name alone, and it was wrong. Several
 * hand-authored fixtures carry `name="form_token" value="tok-live"`, and they NEED to:
 * walkForm.ts deliberately skips those fields, and tests/form-schema.spec.ts verifies the
 * skip. Strip them from the fixtures and that test passes because the field is absent
 * rather than because the skip works — an unfalsifiable test, which is the failure mode
 * this project keeps hitting.
 *
 * So the question is not "is there a form_token" but "does it carry something real".
 * `tok-live` is obviously a fixture. 43 characters of base64url is a session token.
 */
const SECURITY_FIELDS = /name="(form_token|form_build_id|[^"]*honeypot[^"]*|[^"]*captcha[^"]*)"[^>]*value="([^"]*)"/gi;

/** Above this, a security field's value is not a placeholder someone typed. */
const REAL_VALUE_LENGTH = 20;

/**
 * Token-shaped strings.
 *
 * A Drupal form token is ~43 chars of base64url. Deliberately not matching anything
 * shorter: element ids, option values and class names are long but structured, and a
 * looser rule would cry wolf on every file until the check got ignored.
 */
const TOKEN_SHAPE = /\b[A-Za-z0-9_-]{32,}\b/g;

/**
 * Long strings that are structure, not secrets.
 *
 * Drupal names get genuinely long — `field_image_teaser_und_0_attach_button` is 38
 * characters — and an over-tight rule here is not harmless: a check that flags four
 * legitimate names on every run is a check that gets ignored, which costs more than the
 * narrow rule saves.
 *
 * The discriminator is structure. A token is unstructured base64url; a Drupal identifier
 * is lowercase words joined by separators. Anything with a capital letter mixed in, or no
 * separators at all, stays suspicious.
 *
 * Note the DOUBLED separators. Drupal emits `edit-field-image-teaser-und-0-upload--widget`
 * and `og-group-ref-add-more-wrapper--2` when a field appears more than once on a page,
 * and the first real capture tripped on seven of them — exactly the cry-wolf failure this
 * comment warns about, found the first time the check met a live form.
 *
 * The gap this leaves, stated rather than hidden: a token that happens to be all
 * lowercase AND contains an underscore or hyphen would pass. That is a narrow shape and
 * the field-value and identity checks are independent of it, but this rule alone is not
 * a guarantee. Read the file.
 */
const TOKEN_ALLOWED = [
  /^[a-z0-9]+([_-]+[a-z0-9]+)+$/,      // lowercase words joined by - or _, singly or doubled
  /^[a-z_]+(\[[a-z0-9_]*\])*$/i,       // Drupal field names with brackets
  /^(https?|data|javascript)$/i,
];

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const EMAIL_ALLOWED = /@example\.(com|edu|org)$/i;

/** Warn above this: the live menu parent select alone runs to 3,331 options. */
const BIG_FILE_KB = 400;

/**
 * Whoever is committing.
 *
 * Read from git rather than hardcoded, so the check is about the person running it. The
 * local part of the email is the Columbia UNI, which is exactly what Drupal renders into
 * "Authored by" and the admin toolbar.
 */
function identityStrings() {
  const out = new Set();

  for (const key of ['user.email', 'user.name']) {
    try {
      const value = execFileSync('git', ['config', '--get', key], { encoding: 'utf8' }).trim();
      if (!value) continue;
      out.add(value);
      const local = value.split('@')[0];
      if (local && local.length >= 4) out.add(local);
    } catch { /* not configured; nothing to check against */ }
  }

  /**
   * Extra identifiers, from a gitignored file.
   *
   * Git identity is not enough: a contributor's git email can be personal while the thing
   * that leaks is a work username. That gap is not hypothetical — a real Columbia UNI sat
   * in six fixtures in this repo, and the git identity here could never have matched it.
   *
   * Gitignored on purpose. The whole point is a list of strings that must not be
   * committed, so committing the list would defeat it.
   */
  try {
    const extra = readFileSync('.capture-identity', 'utf8');
    for (const line of extra.split('\n')) {
      const value = line.trim();
      if (value && !value.startsWith('#') && value.length >= 4) out.add(value);
    }
  } catch { /* optional */ }

  return [...out];
}

function checkFile(path, identity) {
  const text = readFileSync(path, 'utf8');
  const errors = [];
  const warnings = [];

  for (const [, field, value] of text.matchAll(SECURITY_FIELDS)) {
    if (value.length >= REAL_VALUE_LENGTH) {
      errors.push(`${field} carries a real-looking value (${value.length} chars)`);
    }
  }

  /**
   * Scripts, by content rather than presence.
   *
   * node-edit-specialty.html contains a CKEditor init script on purpose — the async
   * editor tests need it. What matters is whether a script carries a token or a uid, not
   * whether one exists.
   */
  for (const [, body] of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (/ajaxPageState|"uid"|form_token|csrf/i.test(body)) {
      errors.push('a <script> carries page state — Drupal inlines tokens and uids there');
    }
  }

  for (const candidate of new Set(text.match(TOKEN_SHAPE) ?? [])) {
    if (TOKEN_ALLOWED.some(ok => ok.test(candidate))) continue;
    // Reported as an error: a 32-char unstructured blob in a form fixture has no
    // legitimate reason to be there, and guessing wrong in the safe direction is cheap.
    errors.push(`token-shaped string: ${candidate.slice(0, 12)}… (${candidate.length} chars)`);
  }

  for (const address of new Set(text.match(EMAIL) ?? [])) {
    if (EMAIL_ALLOWED.test(address)) continue;
    errors.push(`real-looking email address: ${address}`);
  }

  for (const value of identity) {
    if (text.includes(value)) errors.push(`your own identity appears: ${value}`);
  }

  const kb = Math.round(statSync(path).size / 1024);
  if (kb > BIG_FILE_KB) {
    warnings.push(`${kb} KB — large. Fine if it is a full menu option list; check it is.`);
  }
  if (/PAGE TEXT WAS KEPT/.test(text)) {
    warnings.push('page text was kept — confirm none of it is unpublished.');
  }

  return { errors, warnings };
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: node scripts/check-capture.mjs <file...>');
  process.exit(1);
}

const identity = identityStrings();
let failed = false;

for (const path of files) {
  const { errors, warnings } = checkFile(path, identity);
  console.log(`\n${path}`);
  if (errors.length === 0 && warnings.length === 0) {
    console.log('  clean');
  }
  for (const w of warnings) console.log(`  warn:  ${w}`);
  for (const e of errors) console.log(`  ERROR: ${e}`);
  if (errors.length) failed = true;
}

console.log(
  failed
    ? '\nDo not commit. Fix or re-capture.'
    : '\nSafe to commit, as far as this check can tell. Still read it.'
);
process.exit(failed ? 1 : 0);
