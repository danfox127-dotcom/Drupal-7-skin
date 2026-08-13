import { FormSchema } from './types';
import { buildSchema, findNodeForm } from './walkForm';

export * from './types';
export { walkForm, findNodeForm, readVerticalTabs, baseNameOf } from './walkForm';
export { assignSection, SECTION_RULES } from './sectionRules';

/**
 * Detects the content type.
 *
 * Two sources, in order of reliability:
 *   1. `/node/add/{type}` — unambiguous, and Drupal converts underscores to
 *      hyphens in the URL, so `timeline_entry` appears as `timeline-entry`.
 *   2. The `node-type-{type}` body class on `/node/{nid}/edit`, which is how the
 *      handoff says to read it there.
 *
 * Returns null rather than guessing; callers fall back to a generic grouping.
 */
export function detectContentType(
  location: Pick<Location, 'pathname'> = window.location,
  body: Element | null = document.body
): { contentType: string | null; detectedFrom: FormSchema['detectedFrom'] } {
  const addMatch = location.pathname.match(/\/node\/add\/([a-z0-9-_]+)/i);
  if (addMatch) {
    // URL uses hyphens; Drupal machine names use underscores.
    return { contentType: addMatch[1].replace(/-/g, '_').toLowerCase(), detectedFrom: 'url-add' };
  }

  const classes = body?.className ?? '';
  const classMatch = classes.match(/(?:^|\s)node-type-([a-z0-9-_]+)/i);
  if (classMatch) {
    return { contentType: classMatch[1].replace(/-/g, '_').toLowerCase(), detectedFrom: 'body-class' };
  }

  return { contentType: null, detectedFrom: null };
}

/**
 * True for the two paths that carry a node form. Deliberately excludes
 * `/node/add` with no type, which is the content-type chooser rather than a form.
 */
export function isNodeFormPath(location: Pick<Location, 'pathname'> = window.location): boolean {
  const path = location.pathname;
  if (/\/node\/add\/[a-z0-9-_]+/i.test(path)) return true;
  return /\/node\/\d+\/edit/.test(path);
}

/**
 * Discovers the schema for the current page.
 *
 * Returns null when there is no node form to read, which is the signal for the
 * caller to leave Drupal's own form alone.
 */
export function discoverSchema(
  root: ParentNode = document,
  location: Pick<Location, 'pathname'> = window.location
): FormSchema | null {
  if (!isNodeFormPath(location)) return null;

  const form = findNodeForm(root);
  if (!form) return null;

  const body = (root as Document).body ?? null;
  const { contentType, detectedFrom } = detectContentType(location, body);

  const schema = buildSchema(form, contentType, detectedFrom);

  // A form we cannot read any fields from is not a form we should replace.
  if (schema.fields.length === 0) return null;

  return schema;
}

/**
 * Diagnostic summary — which rule claimed each field, grouped by section.
 *
 * The rules table is inference over markup that has not been validated against the
 * live site, so being able to print this from the console on a real page is how a
 * misfiled field gets traced to a specific rule instead of guessed at.
 */
export function explainSchema(schema: FormSchema): string {
  const lines: string[] = [
    `content type: ${schema.contentType ?? '(undetected)'} (via ${schema.detectedFrom ?? 'nothing'})`,
    `fields: ${schema.fields.length}, vertical tabs: ${schema.verticalTabs.length}`,
    '',
  ];

  const sections = [...new Set(schema.fields.map(f => f.section))];
  for (const section of sections) {
    lines.push(`[${section}]`);
    for (const field of schema.fields.filter(f => f.section === section)) {
      const flags = [
        field.required ? 'required' : null,
        field.multiValue ? 'multi' : null,
        field.options ? `${field.options.length} options` : null,
      ].filter(Boolean).join(', ');
      lines.push(
        `  ${field.label} — ${field.kind}${flags ? ` (${flags})` : ''}` +
        `\n    name=${field.machineName} rule=${field.matchedBy}` +
        (field.group ? ` group="${field.group}"` : '')
      );
    }
    lines.push('');
  }

  if (schema.verticalTabs.length) {
    lines.push('[vertical tabs]');
    schema.verticalTabs.forEach(tab => lines.push(`  ${tab.legend} — ${tab.summary || '(no summary)'}`));
  }

  return lines.join('\n');
}
