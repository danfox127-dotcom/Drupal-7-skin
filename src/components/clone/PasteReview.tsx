import React, { useState, useMemo, useCallback } from 'react';
import { FieldMatch, MatchTier } from '../../lib/clone/match';
import { NodeSnapshot } from '../../lib/clone/types';
import { Unmapped } from '../../lib/import/extract';
import { SectionId } from '../../lib/formSchema';
import { hasAttachment } from '../../lib/clone/media';
import { ImageChecklist } from './ImageChecklist';

/**
 * Review before anything is written.
 *
 * The rule this enforces is the same one the import review enforces: nothing is filled
 * until the editor approves it, and approving fills the FORM only, never Drupal.
 *
 * The one deliberate difference is the default. Every match arrives accepted, including
 * the weakest guess, because the point of the feature is to stop someone retyping a page
 * — a value shown but not filled has done none of the work. So this panel is built for
 * SCANNING and rejecting, not for opting in one field at a time: the confidence of each
 * claim is on the row, the weak ones are visually distinct, and the count of what is
 * about to happen is in the button.
 */

interface Props {
  snapshot: NodeSnapshot;
  matches: FieldMatch[];
  unmapped: Unmapped[];
  targetType: string | null;
  onApply: (accepted: FieldMatch[]) => void;
  onCancel: () => void;
}

const TIER_LABEL: Record<MatchTier, string> = {
  'machine-name': 'Same field',
  'base-name': 'Same field',
  label: 'Matched by name',
  'label-normalized': 'Best guess',
};

/** Reading order for the sections, matching the node editor's rail. */
const SECTION_ORDER: SectionId[] = [
  'primary', 'typeFields', 'search', 'topics', 'related', 'multimedia',
  'menu', 'display', 'seo', 'groups', 'revision', 'other',
];

const SECTION_TITLE: Partial<Record<SectionId, string>> = {
  primary: 'The page itself',
  typeFields: 'This content type’s fields',
  search: 'Search and social',
  topics: 'Topics',
  related: 'Related content',
  multimedia: 'Multimedia',
  display: 'Display',
  seo: 'SEO',
  groups: 'Groups',
  revision: 'Revision',
  other: 'Everything else',
};

/** A value rendered for a human, whatever shape it is in. */
function displayValue(value: FieldMatch['value']): string {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'Ticked' : 'Not ticked';
  return String(value ?? '');
}

export const PasteReview = ({
  snapshot, matches, unmapped, targetType, onApply, onCancel,
}: Props) => {
  const [rows, setRows] = useState<FieldMatch[]>(matches);

  const update = (id: string, patch: Partial<FieldMatch>) => {
    setRows(prev => prev.map(row => (row.id === id ? { ...row, ...patch } : row)));
  };

  const accepted = rows.filter(row => row.accepted);
  const guesses = rows.filter(row => row.tier === 'label-normalized').length;

  const grouped = useMemo(() => {
    const bySection = new Map<SectionId, FieldMatch[]>();
    for (const row of rows) {
      const section = row.target.section;
      const list = bySection.get(section);
      if (list) list.push(row);
      else bySection.set(section, [row]);
    }
    return SECTION_ORDER
      .filter(section => bySection.has(section))
      .map(section => ({ section, rows: bySection.get(section)! }));
  }, [rows]);

  const apply = useCallback(() => onApply(rows.filter(r => r.accepted)), [rows, onApply]);

  /**
   * Only the image fields the source actually filled. Via the shared helper, so the
   * review and the post-apply banner cannot disagree about what counts as attached.
   */
  const attached = useMemo(() => snapshot.media.filter(hasAttachment), [snapshot.media]);

  const sourceName = snapshot.title || snapshot.sourceUrl;
  const crossType = Boolean(
    snapshot.contentType && targetType && snapshot.contentType !== targetType
  );

  return (
    <div className="fixed inset-0 z-[2147483646] bg-canvas overflow-auto font-sans">
      {/* Sticky bar */}
      <div className="sticky top-0 z-10 bg-white border-b border-rule px-4.5 py-3 flex items-center gap-4 flex-wrap">
        <h1 className="font-serif text-heading-sm text-ink shrink-0">Paste a page</h1>

        <div className="min-w-0 flex-1 max-w-[520px]">
          <p className="text-control text-ink truncate" title={sourceName}>{sourceName}</p>
          <p className="text-help text-ink-help truncate" title={snapshot.sourceUrl}>
            {snapshot.sourceOrigin}
          </p>
        </div>

        <span className="text-help text-ink-help">
          {accepted.length} of {matches.length + unmapped.length} fields will be filled
        </span>

        {targetType && (
          <span className="px-2 h-[22px] inline-flex items-center bg-cu-blue text-white font-semibold text-eyebrow uppercase">
            {targetType}
          </span>
        )}

        <div className="flex-1" />

        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 bg-white border border-rule-control text-ink rounded text-control font-semibold hover:bg-legacy-200 transition-colors duration-200 ease-studio"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={apply}
          disabled={accepted.length === 0}
          className="px-4 py-1.5 bg-cu-blue hover:bg-cu-navy text-white rounded text-control font-semibold transition-colors duration-200 ease-studio disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Fill this form with {accepted.length} field{accepted.length === 1 ? '' : 's'}
        </button>
      </div>

      <div className="max-w-[1000px] mx-auto p-4.5">
        {/* Nothing is saved. Said once, plainly, at the top. */}
        <p className="p-3 bg-cu-light border border-cu-blue text-control text-ink">
          This fills the form only — nothing is sent to Drupal. Press <strong>Save</strong>{' '}
          yourself when you have checked it, and publish after that.
          {crossType && (
            <>
              {' '}You copied a <strong>{snapshot.contentType}</strong> page into a{' '}
              <strong>{targetType}</strong> form, so expect fields that have no home here.
            </>
          )}
        </p>

        {guesses > 0 && (
          <p className="mt-2 text-help text-ink-help">
            {guesses} field{guesses === 1 ? ' is a' : 's are'} best guess
            {guesses === 1 ? '' : 'es'}, matched on a similar name rather than the same one.
            {' '}They are marked below and accepted by default — skip any that look wrong.
          </p>
        )}

        {/* Bulk controls */}
        <div className="mt-4 flex items-center gap-3 pb-2 border-b border-rule">
          <span className="text-eyebrow-wide font-semibold uppercase text-ink-secondary">
            Proposed fields
          </span>
          <span className="text-help text-ink-help">
            {accepted.length} of {rows.length} accepted
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setRows(prev => prev.map(r => ({ ...r, accepted: true })))}
            className="text-help font-semibold text-cu-blue hover:underline"
          >
            Accept all
          </button>
          <button
            type="button"
            onClick={() => setRows(prev => prev.map(r => ({ ...r, accepted: false })))}
            className="text-help font-semibold text-cu-blue hover:underline"
          >
            Skip all
          </button>
        </div>

        {rows.length === 0 && (
          <p className="mt-3 text-control text-ink">
            Nothing on the copied page matched a field on this form. Check you are on the
            right content type.
          </p>
        )}

        {grouped.map(({ section, rows: sectionRows }) => (
          <section key={section} className="mt-4">
            <h2 className="text-eyebrow font-semibold uppercase text-ink-secondary">
              {SECTION_TITLE[section] ?? section}
            </h2>

            <ul className="mt-1.5">
              {sectionRows.map(row => {
                const isGuess = row.tier === 'label-normalized';
                const editable = typeof row.value === 'string';

                return (
                  <li
                    key={row.id}
                    className={`px-3 py-2.5 border-b border-rule-hair ${
                      !row.accepted ? 'bg-legacy-100' : isGuess ? 'bg-cu-tint' : 'bg-white'
                    }`}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-control font-semibold text-ink">
                        {row.target.label}
                      </span>
                      {row.target.required && (
                        <span className="text-help text-burnt font-semibold">Required</span>
                      )}
                      <span className={`text-help ${isGuess ? 'text-burnt font-semibold' : 'text-ink-help'}`}>
                        {TIER_LABEL[row.tier]}
                      </span>
                      {row.needsProbe && (
                        <span className="text-help text-ink-help">
                          checked against this site when you fill
                        </span>
                      )}
                      <div className="flex-1" />
                      <button
                        type="button"
                        onClick={() => update(row.id, { accepted: !row.accepted })}
                        className={`px-2 py-0.5 rounded text-help font-semibold border transition-colors duration-200 ease-studio ${
                          row.accepted
                            ? 'bg-cu-blue border-cu-blue text-white'
                            : 'bg-white border-rule-control text-ink-help'
                        }`}
                      >
                        {row.accepted ? 'Accepted' : 'Skipped'}
                      </button>
                    </div>

                    {editable ? (
                      <textarea
                        value={row.value as string}
                        onChange={e => update(row.id, { value: e.target.value })}
                        rows={(row.value as string).length > 120 ? 4 : 1}
                        className={`w-full mt-1.5 px-2 py-1.5 bg-white border border-rule-control rounded text-control resize-y ${
                          row.accepted ? 'text-ink' : 'text-ink-placeholder'
                        }`}
                      />
                    ) : (
                      /**
                       * A checkbox group holds this site's own option values, and a tick
                       * holds a boolean. Neither is meaningful to edit as text, so they
                       * are shown rather than offered — the row can still be skipped.
                       */
                      <p className="mt-1.5 px-2 py-1.5 bg-legacy-100 border border-rule-hair rounded text-control text-ink-secondary">
                        {displayValue(row.value)}
                      </p>
                    )}

                    <p className="mt-1 text-help text-ink-help">
                      {row.source}
                      {row.sourceLabel !== row.target.label && (
                        <> The old page called this “{row.sourceLabel}”.</>
                      )}
                    </p>

                    {row.missing.length > 0 && (
                      <p className="mt-0.5 text-help text-burnt">
                        Not available here: {row.missing.join(', ')}.
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}

        {/* Images */}
        <section className="mt-6">
          <h2 className="text-eyebrow-wide font-semibold uppercase text-ink-secondary">
            Images to attach yourself ({attached.length})
          </h2>
          <div className="mt-2">
            <ImageChecklist images={attached} />
          </div>
        </section>

        {/* Left for you — the honesty of the feature, same as the import review. */}
        {unmapped.length > 0 && (
          <section className="mt-6 pb-8">
            <h2 className="text-eyebrow-wide font-semibold uppercase text-ink-secondary">
              Left for you ({unmapped.length})
            </h2>
            <ul className="mt-2 flex flex-col gap-1.5">
              {unmapped.map((item, index) => (
                <li key={`${item.label}-${index}`}>
                  <p className="text-control font-semibold text-ink">{item.label}</p>
                  <p className="text-help text-ink-help">{item.reason}</p>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
};
