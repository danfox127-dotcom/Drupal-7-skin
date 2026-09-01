import { FormSchema, FieldDescriptor } from '../formSchema';

/**
 * Maps a proposal key to the field on this form that should receive it.
 *
 * Matches on the label and role the schema already worked out rather than on machine
 * names, so it survives the same name uncertainty everything else does — a site can call
 * its body field anything, but it labels it "Body".
 *
 * Lives here rather than in importFlow.tsx because it is pure logic over a schema, and
 * burying it in a React module is why it went untested while quietly picking the wrong
 * field on a form with three fields sharing a label.
 */
export function findTarget(schema: FormSchema, key: string): FieldDescriptor | null {
  /**
   * When several fields share a label, the required one wins.
   *
   * Specialty carries THREE fields labelled "Summary" — core's body summary, field_summary,
   * and field_specialty_summary — and only one is required. That is the one the site treats
   * as the real summary, and the one feeding the page's meta description. Taking the first
   * match instead made the outcome depend on DOM order and on whether the body-summary fold
   * had run, which is luck rather than a rule.
   *
   * This only changes anything when a label is ambiguous, which is exactly the case where
   * position was never a defensible tiebreak. With no required match, first wins as before.
   */
  const byLabel = (pattern: RegExp) => {
    const matches = schema.fields.filter(f => pattern.test(f.label.toLowerCase()));
    if (matches.length === 0) return null;
    return matches.find(f => f.required) ?? matches[0];
  };

  switch (key) {
    case 'title': return byLabel(/^title$/);
    case 'subtitle': return byLabel(/^subtitle/);
    case 'summary': return byLabel(/^summary$/);
    case 'body': return byLabel(/^body$/);
    case 'byline': return byLabel(/^byline$/);
    case 'date': return byLabel(/display date|^date$/);
    default: return null;
  }
}
