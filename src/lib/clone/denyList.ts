/**
 * Fields a cross-site copy must never write, each with the reason a person is shown.
 *
 * This is the safety core of the feature, so it is a table with reasons rather than a
 * scatter of `if` statements: a reason that has to be shown cannot be quietly forgotten,
 * and the review renders these under "Left for you" instead of pretending the field was
 * not there.
 *
 * walkForm's collectFieldGroups already drops form_token, form_build_id, form_id, op,
 * changed and [_weight], so those are covered twice on purpose — this module is the one
 * that states intent, and it should still be correct if that filter ever changes.
 *
 * Decisions recorded here came from the feature discussion, not from guesswork:
 *   - menu placement is skipped because the destination's menu structure differs
 *   - URL alias and authored by/on were called rarely used and irrelevant
 *   - publish status is NEVER copied; a paste is saved as a draft and published by hand
 */

export interface DenyRule {
  /** Matched against the field's full Drupal name. */
  pattern: RegExp;
  /** Shown in the review, so it must read as an explanation rather than a code. */
  reason: string;
  /** Grouped in the review under one heading. */
  label: string;
}

export const DENY_RULES: DenyRule[] = [
  {
    pattern: /^menu\[/,
    label: 'Menu placement',
    reason: "The destination site's menu structure is different, so a copied position would be wrong.",
  },
  {
    pattern: /^path\[/,
    label: 'URL alias',
    reason: 'Left to the destination site to generate.',
  },
  {
    pattern: /^name$/,
    label: 'Authored by',
    reason: 'The author is whoever creates the page here.',
  },
  {
    pattern: /^date$/,
    label: 'Authored on',
    reason: 'The creation date is when this page is saved here.',
  },
  {
    pattern: /^(status|promote|sticky)$/,
    label: 'Publishing options',
    reason: 'A paste is never published. Save it as a draft, check it, then press Publish.',
  },
  {
    pattern: /^(revision|revision_log|log)$|^revision_information/,
    label: 'Revision log',
    reason: 'A revision message describes an edit on the source site.',
  },
  {
    pattern: /moderation_state|^workbench_moderation/,
    label: 'Moderation state',
    reason: 'A paste is never published. Save it as a draft, check it, then press Publish.',
  },
  {
    /**
     * A file id names a row in the source site's database. Written here it would point at
     * a different file, or at nothing. Images travel as filenames and URLs instead — see
     * media.ts.
     */
    pattern: /\[fid\]$/,
    label: 'Attached file',
    reason: 'A file ID only means something on the site it came from. The image is listed with its URL instead.',
  },
  {
    pattern: /^(media|files)\[/,
    label: 'Media widget',
    reason: 'Images are attached with Drupal’s own Browse button. The source images are listed with their URLs.',
  },
  {
    /**
     * Text formats are configured per site, and are permission-gated. Writing the
     * source's format could name one that does not exist here, or one this account may
     * not use — and the consequence of getting it wrong is content stripped on save.
     */
    pattern: /\[format\]$/,
    label: 'Text format',
    reason: "Text formats are configured separately on each site, so the destination's own format is kept.",
  },
  {
    pattern: /^(form_token|form_build_id|form_id|op|changed)$/,
    label: 'Form security tokens',
    reason: 'Belongs to the form it was rendered in and is never copied.',
  },
];

/** The reason this field must not be copied, or null when it may be. */
export function denyReason(machineName: string): DenyRule | null {
  return DENY_RULES.find(rule => rule.pattern.test(machineName)) ?? null;
}
