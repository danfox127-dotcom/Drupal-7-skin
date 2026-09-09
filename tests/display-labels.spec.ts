import { test, expect } from '@playwright/test';
import { assignDisplayLabels, displayLabelFor, wasRelabelled } from '../src/lib/formSchema';
import { FieldDescriptor } from '../src/lib/formSchema/types';

/**
 * The generic collision fallback, tested directly.
 *
 * assignDisplayLabels has two paths. Named collisions go through OVERRIDES, and those are
 * covered against real captured markup in captured-types.spec.ts — the site's own
 * attributes/item_attributes pairs. This file covers the other path: a collision nobody
 * anticipated, where a qualifier has to be derived from the machine name.
 *
 * Deliberately constructed rather than driven off a fixture. It used to be tested through
 * `field_specialty_summary` in tests/fixtures/node-edit-specialty.html — a field the
 * captures proved does not exist on the real form. Testing an unanticipated-collision
 * fallback with an invented field in a fixture that claims to be real is the wrong shape:
 * the fixture lies about the site, and the coverage is incidental. Here the input is
 * obviously synthetic and the thing under test is obvious too.
 */

const field = (machineName: string, label: string, section = 'primary'): FieldDescriptor => ({
  machineName,
  baseName: machineName.split('[')[0],
  label,
  kind: 'text',
  section: section as FieldDescriptor['section'],
  matchedBy: 'test',
  elements: [],
  required: false,
  multiValue: false,
  advanced: false,
} as FieldDescriptor);

test.describe('collisions nobody anticipated', () => {
  test('a shared label gains the token that distinguishes the machine name', () => {
    const a = field('field_summary[und][0][value]', 'Summary');
    const b = field('field_teaser_summary[und][0][value]', 'Summary');
    assignDisplayLabels([a, b]);

    // The plain one keeps Drupal's wording, so anyone who knows the native form still
    // recognises it; the other takes its distinguishing token.
    expect(displayLabelFor(a)).toBe('Summary');
    expect(displayLabelFor(b)).toBe('Teaser summary');
    expect(wasRelabelled(a)).toBe(false);
    expect(wasRelabelled(b)).toBe(true);
  });

  test('a unique label is left exactly as Drupal wrote it', () => {
    // Renaming fields nobody asked about would be worse than the problem.
    const a = field('field_summary[und][0][value]', 'Summary');
    const b = field('body[und][0][value]', 'Body');
    assignDisplayLabels([a, b]);
    expect(displayLabelFor(a)).toBe('Summary');
    expect(displayLabelFor(b)).toBe('Body');
  });

  test('the same label in DIFFERENT sections is not a collision', () => {
    // Sections supply their own context, which is the whole reason they exist.
    const a = field('field_summary[und][0][value]', 'Summary', 'primary');
    const b = field('field_other_summary[und][0][value]', 'Summary', 'seo');
    assignDisplayLabels([a, b]);
    expect(displayLabelFor(a)).toBe('Summary');
    expect(displayLabelFor(b)).toBe('Summary');
  });

  test('noise tokens are not used as qualifiers', () => {
    // field/value/und carry no meaning; a qualifier built from them would read as noise.
    const a = field('field_summary[und][0][value]', 'Summary');
    const b = field('field_value_summary[und][0][value]', 'Summary');
    assignDisplayLabels([a, b]);
    expect(displayLabelFor(b)).toBe('Summary');
  });

  test('when neither name distinguishes, both keep Drupal\'s label', () => {
    /**
     * The honest limit of the derived approach, and why OVERRIDES exists.
     *
     * menu[options][attributes][class] and menu[options][item_attributes][class] collide,
     * and no token distinguishes the first — its name is a subset of the second's. The
     * fallback cannot help, so the real fix for those was to name what each one governs.
     */
    const a = field('field_summary[und][0][value]', 'Summary');
    const b = field('field_summary[und][1][value]', 'Summary');
    assignDisplayLabels([a, b]);
    expect(displayLabelFor(a)).toBe('Summary');
    expect(displayLabelFor(b)).toBe('Summary');
  });
});
