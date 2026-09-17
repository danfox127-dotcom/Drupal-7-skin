import { FieldDescriptor, FormSchema, FieldKind } from '../formSchema';
import { FieldValue } from '../fieldBinding';
import { Confidence, Unmapped } from '../import/extract';
import { CapturedField, NodeSnapshot } from './types';
import { denyReason } from './denyList';
import {
  explodeTags, implodeTags, stripEntityId, labelKey, valueForLabels,
} from './values';

/**
 * Deciding which field on THIS form should receive each field from the copy.
 *
 * Pure logic over two schemas — no DOM writes, no network — so the hard part is
 * testable without a browser and without a live site.
 *
 * Two sites built from the same install profile agree on most machine names, which is
 * why this mostly works; but field lists genuinely differ per site, so name matching
 * alone leaves real fields on the floor. Hence the tiers: each one is a weaker claim
 * than the last, each says so in the provenance line, and the review is what makes
 * accepting a weak claim safe.
 */

export type MatchTier = 'machine-name' | 'base-name' | 'label' | 'label-normalized';

export interface FieldMatch {
  /** Stable key for the review list. */
  id: string;
  sourceLabel: string;
  sourceMachineName: string;
  /** The field on this form that will receive the value. */
  target: FieldDescriptor;
  /** Already translated for this form — ready to hand to writeValue. */
  value: FieldValue;
  /** Shown verbatim in the review, in the style of FieldDescriptor.matchedBy. */
  source: string;
  tier: MatchTier;
  confidence: Confidence;
  accepted: boolean;
  /** Option labels or reference titles this site does not have. */
  missing: string[];
  /**
   * An entity reference, whose title must be checked against this site before it is
   * written. See references.ts — writing an unresolvable title makes Drupal block the
   * save, which is the opposite of helpful.
   */
  needsProbe: boolean;
  /**
   * Leave blank rather than write when the check fails or cannot run.
   *
   * True for group membership, by explicit decision: groups rarely match across sites,
   * a wrong value changes who can see the page, and the instruction was that a
   * non-matching group should just be blank.
   */
  blankOnMiss: boolean;
}

export interface MatchResult {
  matches: FieldMatch[];
  /** Everything the paste will not fill, with the reason shown to a person. */
  unmapped: Unmapped[];
}

/** Widget shapes that can carry each other's values. */
const KIND_FAMILY: Record<FieldKind, string> = {
  text: 'text', textarea: 'text', wysiwyg: 'text',
  select: 'choice', radioGroup: 'choice', checkboxGroup: 'choice',
  autocomplete: 'reference',
  checkbox: 'flag',
  date: 'date',
  file: 'file',
  paragraphs: 'paragraphs',
  unknown: 'unknown',
};

/**
 * Whether a label match is plausible enough to act on.
 *
 * Only consulted for the LABEL tiers. A name match is the same field by definition, so
 * a site that rebuilt it as a different widget is still the same field and translation
 * handles the shape. But two fields that merely share a label and have nothing else in
 * common are not the same field, and filling one from the other is how a taxonomy term
 * ends up in a date box.
 */
function compatible(a: FieldKind, b: FieldKind): boolean {
  if (KIND_FAMILY[a] === 'file' || KIND_FAMILY[b] === 'file') return false;
  if (KIND_FAMILY[a] === 'paragraphs' || KIND_FAMILY[b] === 'paragraphs') return false;
  return KIND_FAMILY[a] === KIND_FAMILY[b];
}

/** Aggressive label key for the weakest tier: punctuation and a trailing plural dropped. */
export function normalizeLabel(label: string): string {
  return labelKey(label)
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/s$/, '');
}

/** True for a field that governs who can see the page. */
export function isGroupField(baseName: string): boolean {
  return /^og_group_ref$|^og_/.test(baseName) || /^group_/.test(baseName);
}

export interface Translation {
  value: FieldValue;
  missing: string[];
  needsProbe: boolean;
  /** Set when nothing could be produced; becomes an "unmapped" reason. */
  refusal: string | null;
}

/**
 * Turns a captured value into one this form's control will accept.
 *
 * Every branch here exists because the naive version writes something wrong:
 * an id into a rebuilt vocabulary, a `Title (1234)` into a site where 1234 is a
 * different node, a three-part date into a two-part widget.
 */
export function translate(captured: CapturedField, target: FieldDescriptor): Translation {
  const none = (refusal: string): Translation =>
    ({ value: '', missing: [], needsProbe: false, refusal });

  // --- Choice widgets: resolve labels to THIS site's own option values -------
  if (target.options && target.options.length > 0 && KIND_FAMILY[target.kind] === 'choice') {
    /**
     * Labels come from the snapshot when the source was also a choice field. When it was
     * a plain text field, its text is tried as a label — which is how a site that stores
     * a category as free text can still fill a site that stores it as a term.
     */
    const labels = captured.optionLabels
      ?? (typeof captured.value === 'string' ? explodeTags(captured.value) : []);

    if (labels.length === 0) return none('The source page had nothing selected here.');

    const { value, missing } = valueForLabels(target, labels);
    const resolvedAny = Array.isArray(value) ? value.length > 0 : value !== '';

    if (!resolvedAny) {
      return none(
        `This site has no option named ${missing.map(m => `“${m}”`).join(', ')}. `
        + 'Pick the closest match by hand.'
      );
    }
    return { value, missing, needsProbe: false, refusal: null };
  }

  // --- Entity references: carry the title, never the id ---------------------
  if (target.kind === 'autocomplete') {
    const raw = typeof captured.value === 'string' ? captured.value : String(captured.value ?? '');
    const titles = explodeTags(raw).map(stripEntityId).filter(Boolean);
    if (titles.length === 0) return none('The source page had nothing referenced here.');

    /**
     * The id is dropped here and NOT looked up later. Drupal appends `(1234)` and parses
     * it back on submit; 1234 on this site is a different node, or no node. So the title
     * travels and references.ts asks this site whether it has one.
     */
    return {
      value: implodeTags(titles),
      missing: [],
      needsProbe: true,
      refusal: null,
    };
  }

  // --- Flags ----------------------------------------------------------------
  if (target.kind === 'checkbox') {
    return { value: Boolean(captured.value), missing: [], needsProbe: false, refusal: null };
  }

  // --- Dates ----------------------------------------------------------------
  if (target.kind === 'date') {
    const parts = String(captured.value).split('-').filter(Boolean);
    if (parts.length === 0) return none('The source page had no date here.');
    /**
     * readValue joins a date widget's selects in element order, and writeValue splits on
     * the same separator. A destination that renders a different number of parts would
     * take the first few and silently drop the rest, so the mismatch is reported.
     */
    if (target.elements.length > 1 && parts.length !== target.elements.length) {
      return none(
        `The date widgets differ — the source had ${parts.length} parts and this form has `
        + `${target.elements.length}. Set the date by hand.`
      );
    }
    return { value: String(captured.value), missing: [], needsProbe: false, refusal: null };
  }

  // --- Text -----------------------------------------------------------------
  /**
   * A choice value arriving at a text field writes the LABELS, not the ids. Same rule as
   * everywhere else: the number means nothing here.
   */
  if (captured.optionLabels && captured.optionLabels.length > 0) {
    return {
      value: implodeTags(captured.optionLabels),
      missing: [], needsProbe: false, refusal: null,
    };
  }

  const text = Array.isArray(captured.value)
    ? captured.value.join(', ')
    : String(captured.value ?? '');

  if (text.trim() === '') return none('The source page had nothing in this field.');

  return { value: text, missing: [], needsProbe: false, refusal: null };
}

const TIER_CONFIDENCE: Record<MatchTier, Confidence> = {
  'machine-name': 'high',
  'base-name': 'high',
  label: 'medium',
  'label-normalized': 'low',
};

function provenance(tier: MatchTier, captured: CapturedField, target: FieldDescriptor): string {
  switch (tier) {
    case 'machine-name':
      return `Same field on both sites (${target.machineName}).`;
    case 'base-name':
      return `Same field, rendered differently here (${captured.baseName}).`;
    case 'label':
      return `Matched by name — the source calls this “${captured.label}” too.`;
    case 'label-normalized':
      return `Best guess: the source field “${captured.label}” looks like this form's “${target.label}”. Worth a look.`;
  }
}

/**
 * Matches a copied page onto the form currently open.
 *
 * Strongest tier first, and a target field can only be claimed once — so an exact name
 * match always beats a label guess for the same box, whatever order the source fields
 * happen to be in.
 */
export function matchFields(snapshot: NodeSnapshot, schema: FormSchema): MatchResult {
  /** Targets a paste may write to. */
  const targets = schema.fields.filter(field => {
    if (denyReason(field.machineName)) return false;
    if (field.kind === 'file') return false;          // images are never written
    if (field.kind === 'paragraphs') return false;    // rebuilt, not written
    return true;
  });

  const claimed = new Set<string>();
  const matches: FieldMatch[] = [];
  const unmapped: Unmapped[] = [];
  const unmatchedSources = new Set(snapshot.fields.map(f => f.machineName));

  const free = () => targets.filter(t => !claimed.has(t.machineName));

  const finders: { tier: MatchTier; find: (c: CapturedField) => FieldDescriptor | undefined }[] = [
    {
      tier: 'machine-name',
      find: c => free().find(t => t.machineName === c.machineName),
    },
    {
      tier: 'base-name',
      find: c => free().find(t => t.baseName === c.baseName),
    },
    {
      tier: 'label',
      find: c => free().find(t =>
        labelKey(t.label) === labelKey(c.label) && compatible(t.kind, c.kind)),
    },
    {
      tier: 'label-normalized',
      find: c => free().find(t =>
        normalizeLabel(t.label) === normalizeLabel(c.label) && compatible(t.kind, c.kind)),
    },
  ];

  for (const { tier, find } of finders) {
    for (const captured of snapshot.fields) {
      if (!unmatchedSources.has(captured.machineName)) continue;

      // Defence in depth: a snapshot written by another build might carry a field this
      // one refuses, and the deny list is the authority at write time as well as capture.
      if (denyReason(captured.machineName)) {
        unmatchedSources.delete(captured.machineName);
        continue;
      }

      const target = find(captured);
      if (!target) continue;

      unmatchedSources.delete(captured.machineName);
      claimed.add(target.machineName);

      const translated = translate(captured, target);
      if (translated.refusal) {
        unmapped.push({ label: captured.label, reason: translated.refusal });
        continue;
      }

      matches.push({
        id: `${captured.machineName}->${target.machineName}`,
        sourceLabel: captured.label,
        sourceMachineName: captured.machineName,
        target,
        value: translated.value,
        source: provenance(tier, captured, target),
        tier,
        confidence: TIER_CONFIDENCE[tier],
        /**
         * Accepted by default at EVERY tier, including the weakest.
         *
         * This inverts the import flow, where low confidence means skipped. The purpose
         * of this feature is to stop someone retyping a page, so a value shown but not
         * filled has done none of the work; the review is the guard, and a low-confidence
         * match says so in its provenance line.
         */
        accepted: true,
        missing: translated.missing,
        needsProbe: translated.needsProbe,
        blankOnMiss: isGroupField(captured.baseName) || isGroupField(target.baseName),
      });
    }
  }

  // Source fields this content type simply does not have.
  for (const captured of snapshot.fields) {
    if (!unmatchedSources.has(captured.machineName)) continue;
    unmapped.push({
      label: captured.label,
      reason: `This content type has no matching field${
        snapshot.contentType && schema.contentType && snapshot.contentType !== schema.contentType
          ? ` — the copy came from a ${snapshot.contentType} page and this is a ${schema.contentType}`
          : ''
      }.`,
    });
  }

  // Everything the capture already decided not to carry.
  unmapped.push(...snapshot.omitted.map(o => ({ label: o.label, reason: o.reason })));

  return { matches, unmapped };
}

/** How many fields the primary button will fill. */
export function acceptedMatches(matches: FieldMatch[]): FieldMatch[] {
  return matches.filter(m => m.accepted);
}
