import { test, expect } from '@playwright/test';
import {
  explodeTags, implodeTags, stripEntityId, entityIdOf, labelKey,
  optionLabelsFor, valueForLabels,
} from '../src/lib/clone/values';
import { FieldDescriptor, FieldOption } from '../src/lib/formSchema';

/**
 * Value translation between two sites.
 *
 * The whole cross-site copy rests on this file being right: Drupal submits ids, ids are
 * local to one database, and the only thing both sites agree on is the human-readable
 * label. Everything here is about not writing a number that means something else on the
 * other side.
 */

/** A field descriptor with only the parts these functions read. */
const field = (kind: FieldDescriptor['kind'], options?: FieldOption[]): FieldDescriptor => ({
  machineName: 'field_x[und]', baseName: 'field_x', label: 'X', kind,
  required: false, help: '', section: 'typeFields', matchedBy: 'test',
  group: null, groupPath: [], elements: [], options, multiValue: false, advanced: false,
});

const opts = (pairs: [string, string][]): FieldOption[] =>
  pairs.map(([value, label]) => ({ value, label, depth: 0, selected: false }));

test.describe('Drupal tag splitting', () => {
  test('a comma inside a quoted tag does not split it', () => {
    /**
     * The case that makes naive splitting wrong on real content. Drupal quotes any tag
     * containing a comma, so "Smith, John" is ONE author. Split on commas and it becomes
     * two references, neither of which resolves on the destination.
     */
    expect(explodeTags('"Smith, John", Jones')).toEqual(['Smith, John', 'Jones']);
  });

  test('a doubled quote is an escaped quote', () => {
    expect(explodeTags('"He said ""hi""", Plain')).toEqual(['He said "hi"', 'Plain']);
  });

  test('unquoted tags split and trim', () => {
    expect(explodeTags('Nephrology,  Cardiology ,Oncology'))
      .toEqual(['Nephrology', 'Cardiology', 'Oncology']);
  });

  test('empty parts are dropped rather than becoming blank tags', () => {
    expect(explodeTags('A,,B,')).toEqual(['A', 'B']);
  });

  test('a comma-bearing tag survives a round trip', () => {
    const tags = ['Smith, John', 'Plain', 'Quote"Inside'];
    expect(explodeTags(implodeTags(tags))).toEqual(tags);
  });

  test('imploding only quotes the tags that need it', () => {
    expect(implodeTags(['Plain', 'Smith, John'])).toBe('Plain, "Smith, John"');
  });
});

test.describe('entity id suffixes', () => {
  test('the id Drupal appends is stripped, and recorded', () => {
    expect(stripEntityId('IgA Nephropathy (8821)')).toBe('IgA Nephropathy');
    expect(entityIdOf('IgA Nephropathy (8821)')).toBe('8821');
  });

  test('a parenthetical that is not an id is left alone', () => {
    /**
     * Guards against a greedy regex eating real title text. "Study (Phase 2)" is the
     * whole title; stripping it would write a title the destination cannot match, and
     * Drupal would block the save.
     */
    expect(stripEntityId('Kidney Study (Phase 2)')).toBe('Kidney Study (Phase 2)');
    expect(entityIdOf('Kidney Study (Phase 2)')).toBeNull();
  });

  test('a title that is only an id is handled without throwing', () => {
    expect(stripEntityId('(12)')).toBe('');
  });
});

test.describe('option labels are the cross-site identity', () => {
  test('selected labels come from the current value, not the captured flags', () => {
    /**
     * The `selected` flags are a snapshot taken at discovery, which may predate anything
     * the user did. The value is what Drupal would actually submit, so it wins.
     */
    const f = field('select', [
      { value: '101', label: 'Nephrology', depth: 0, selected: true },
      { value: '102', label: 'Cardiology', depth: 0, selected: false },
    ]);
    expect(optionLabelsFor(f, '102')).toEqual(['Cardiology']);
  });

  test('a multi-select checkbox group reports every selected label', () => {
    const f = field('checkboxGroup', opts([['1', 'Allergy'], ['2', 'Asthma'], ['3', 'Eczema']]));
    expect(optionLabelsFor(f, ['1', '3'])).toEqual(['Allergy', 'Eczema']);
  });

  test("Drupal's placeholder option is not a label", () => {
    const f = field('select', opts([['_none', '- None -'], ['5', 'Real']]));
    expect(optionLabelsFor(f, '_none')).toEqual([]);
  });

  test('a field with no options reports null rather than an empty list', () => {
    // Null means "not a choice field"; [] would mean "a choice field with nothing
    // selected". The matcher treats those differently.
    expect(optionLabelsFor(field('text'), 'hello')).toBeNull();
  });
});

test.describe('resolving labels onto another site', () => {
  test('the same term resolves to a different id on the destination', () => {
    /**
     * This single assertion is the reason the feature works at all. Source id 101,
     * destination id 88, same term name.
     */
    const destination = field('select', opts([['88', 'Nephrology'], ['89', 'Cardiology']]));
    expect(valueForLabels(destination, ['Nephrology'])).toEqual({ value: '88', missing: [] });
  });

  test('a term the destination does not have is reported by name', () => {
    const destination = field('checkboxGroup', opts([['1', 'Allergy']]));
    expect(valueForLabels(destination, ['Allergy', 'Asthma']))
      .toEqual({ value: ['1'], missing: ['Asthma'] });
  });

  test('matching ignores case and spacing but not identity', () => {
    const destination = field('select', opts([['7', 'Head  and Neck']]));
    expect(valueForLabels(destination, ['head and neck']).value).toBe('7');
    expect(valueForLabels(destination, ['Head']).missing).toEqual(['Head']);
  });

  test('a checkbox group returns an array and a select returns a string', () => {
    // writeValue dispatches on shape, so returning the wrong one silently writes nothing.
    const group = field('checkboxGroup', opts([['1', 'A']]));
    const single = field('select', opts([['1', 'A']]));
    expect(valueForLabels(group, ['A']).value).toEqual(['1']);
    expect(valueForLabels(single, ['A']).value).toBe('1');
  });

  test('nothing resolves to the placeholder option', () => {
    const destination = field('select', opts([['_none', '- Select -'], ['3', 'Real']]));
    expect(valueForLabels(destination, ['- Select -']).missing).toEqual(['- Select -']);
  });

  test('a duplicated label resolves to the first option, not the last', () => {
    const destination = field('select', opts([['10', 'Summary'], ['20', 'Summary']]));
    expect(valueForLabels(destination, ['Summary']).value).toBe('10');
  });
});

test('label keys normalise the things that differ between sites', () => {
  expect(labelKey('  Head  and\nNeck ')).toBe('head and neck');
});
