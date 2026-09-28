import { test, expect } from '@playwright/test';
import { preciseBaseName, belongsToPreciseBase } from '../src/lib/formSchema/walkForm';

/**
 * widgetWrapperFor's relocation climb (src/content/inject.tsx) needs to tell whether a
 * control belongs to the field being relocated. baseNameOf collapses to the OUTERMOST
 * field name — right for Media's launcher/fid pairing, wrong the moment a field sits
 * inside a Paragraphs item beside SIBLING fields, since every sibling shares that same
 * outer name. These are the real name shapes involved, taken from a real capture of
 * List's "Individual Profiles" table sitting beside five unrelated filter selects
 * inside the same fixed-config paragraph item (tests/fixtures/captured/list-populated.html).
 */

test.describe('preciseBaseName', () => {
  test('a field nested in a paragraph item keeps its own delta, not just the outer one', () => {
    expect(preciseBaseName(
      'field_generic_paragraphs_single[und][0][field_cola_cups_profiles][und][0][target_id]'
    )).toBe('field_generic_paragraphs_single_und_0_field_cola_cups_profiles');
  });

  test('Media\'s bracket-wrapped launcher still resolves the loose way, delta-independent', () => {
    expect(preciseBaseName('media[field_image_teaser_und_0]')).toBe('field_image_teaser');
  });

  test('a name with no delta segment at all falls back to its whole canonical form', () => {
    expect(preciseBaseName('field_list_type[und]')).toBe('field_list_type_und');
  });

  test('an unbracketed name with no delta marker is returned as-is', () => {
    expect(preciseBaseName('op')).toBe('op');
  });
});

test.describe('belongsToPreciseBase', () => {
  const PROFILES_BASE = preciseBaseName(
    'field_generic_paragraphs_single[und][0][field_cola_cups_profiles][und][0][target_id]'
  );

  test('a second row of the SAME field still belongs, at a different delta', () => {
    expect(belongsToPreciseBase(
      'field_generic_paragraphs_single[und][0][field_cola_cups_profiles][und][1][target_id]',
      PROFILES_BASE
    )).toBe(true);
  });

  test('the field\'s own row-weight select belongs', () => {
    expect(belongsToPreciseBase(
      'field_generic_paragraphs_single[und][0][field_cola_cups_profiles][und][0][_weight]',
      PROFILES_BASE
    )).toBe(true);
  });

  test('the field\'s own "Add another item" button belongs, despite its underscore-joined name', () => {
    expect(belongsToPreciseBase(
      'field_generic_paragraphs_single_und_0_field_cola_cups_profiles_add_more',
      PROFILES_BASE
    )).toBe(true);
  });

  test('a SIBLING filter field nested in the same paragraph item does not belong', () => {
    expect(belongsToPreciseBase(
      'field_generic_paragraphs_single[und][0][field_cups_specialties_raw][und][]',
      PROFILES_BASE
    )).toBe(false);
  });

  test('another sibling filter field does not belong either', () => {
    expect(belongsToPreciseBase(
      'field_generic_paragraphs_single[und][0][field_cups_expertise][und][]',
      PROFILES_BASE
    )).toBe(false);
  });

  test('a field whose name merely starts with the same characters is not a false match', () => {
    // Guards the underscore-boundary check: "field_cola_cups_profiles2" must not pass
    // for "field_cola_cups_profiles".
    expect(belongsToPreciseBase('field_cola_cups_profiles2[und][0][value]', 'field_cola_cups_profiles')).toBe(false);
  });

  test('Media: the hidden fid belongs with the bracket-wrapped launcher', () => {
    const base = preciseBaseName('media[field_image_teaser_und_0]');
    expect(belongsToPreciseBase('field_image_teaser[und][0][fid]', base)).toBe(true);
  });

  test('Media: the launcher belongs with ITSELF — the climb\'s very first candidate ancestor always contains it', () => {
    // This is the one that actually broke: widgetWrapperFor's climb tests every
    // control under each candidate ancestor, and the very first candidate always
    // contains the launcher's own input. If the launcher's own name did not resolve
    // against its own base name, the climb rejected its own starting point and never
    // moved anything at all — exactly what shipped and was caught by re-running the
    // extension suite (Feature 5's Media tests) after this fix, not by this file.
    const base = preciseBaseName('media[field_image_teaser_und_0]');
    expect(belongsToPreciseBase('media[field_image_teaser_und_0]', base)).toBe(true);
  });

  test('Media: a second image field on the same form does not belong', () => {
    const base = preciseBaseName('media[field_image_teaser_und_0]');
    expect(belongsToPreciseBase('field_image_hero[und][0][fid]', base)).toBe(false);
  });
});
