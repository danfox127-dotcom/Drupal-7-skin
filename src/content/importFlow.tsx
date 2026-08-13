import React, { useState } from 'react';
import { FormSchema, FieldDescriptor } from '../lib/formSchema';
import { writeValue } from '../lib/fieldBinding';
import { Proposal, ProposedImage, readAllowedTags, extract, ExtractionResult } from '../lib/import/extract';
import { PendingImport, clearPendingImport, setPendingImport } from '../lib/import/pending';
import { ImportReview, ImportedBanner } from '../components/import/ImportReview';
import { injectOverlay } from './inject';

/**
 * Applies approved proposals to the node form, and shows the review that precedes it.
 *
 * Approval writes to the FORM ONLY. Nothing is sent to Drupal — the editor still has
 * to press Save, which is the guarantee the handoff is built around.
 */

/**
 * Maps a proposal key to a discovered field.
 *
 * Matches on the section and role the schema already worked out rather than on machine
 * names, so it survives the same name uncertainty everything else does.
 */
function findTarget(schema: FormSchema, key: string): FieldDescriptor | null {
  const byLabel = (pattern: RegExp) =>
    schema.fields.find(f => pattern.test(f.label.toLowerCase())) ?? null;

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

export interface ApplyOutcome {
  applied: string[];
  /** Proposals with nowhere to go on this content type. */
  unmatched: string[];
  /** Fields whose native control rejected the value. */
  failed: string[];
}

export function applyProposals(schema: FormSchema, accepted: Proposal[]): ApplyOutcome {
  const outcome: ApplyOutcome = { applied: [], unmatched: [], failed: [] };

  for (const proposal of accepted) {
    const field = findTarget(schema, proposal.key);
    if (!field) {
      // e.g. a byline proposal on a Page, which has no byline field.
      outcome.unmatched.push(proposal.label);
      continue;
    }

    if (writeValue(field, proposal.value)) outcome.applied.push(proposal.label);
    else outcome.failed.push(proposal.label);
  }

  return outcome;
}

/** Wraps the review so it can report its own outcome after applying. */
function ImportFlow({
  pending, result, schema, onDone,
}: {
  pending: PendingImport;
  result: ExtractionResult;
  schema: FormSchema;
  onDone: () => void;
}) {
  const [reviewing, setReviewing] = useState(true);
  const [outcome, setOutcome] = useState<ApplyOutcome | null>(null);

  const handleApply = (accepted: Proposal[], _images: ProposedImage[]) => {
    const result = applyProposals(schema, accepted);
    setOutcome(result);
    setReviewing(false);
    // Marked applied so a page reload does not re-open the review over a form the
    // user has since edited.
    void setPendingImport({ ...pending, applied: true });
  };

  if (reviewing) {
    return (
      <ImportReview
        result={result}
        targetType={schema.contentType}
        onApply={handleApply}
        onCancel={() => { void clearPendingImport(); onDone(); }}
      />
    );
  }

  return (
    <div className="fixed top-11 left-0 right-0 z-[2147483645] px-4">
      <ImportedBanner
        sourceUrl={result.sourceUrl}
        onBack={() => setReviewing(true)}
      />
      {outcome && (outcome.unmatched.length > 0 || outcome.failed.length > 0) && (
        <div className="mt-2 p-3 bg-white border border-burnt font-sans">
          {outcome.unmatched.length > 0 && (
            <p className="text-control text-ink">
              Not applied — this content type has no matching field:{' '}
              <span className="font-semibold">{outcome.unmatched.join(', ')}</span>.
            </p>
          )}
          {outcome.failed.length > 0 && (
            <p className="text-control text-ink mt-1">
              Rejected by the form field:{' '}
              <span className="font-semibold">{outcome.failed.join(', ')}</span>.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Opens the review if an unapplied import is waiting.
 *
 * Extraction runs HERE, not in the popup, so the body is filtered against this form's
 * own allowed-tag list — read from Drupal's filter guidelines on the page. That is how
 * the handoff's open question #4 is answered with real configuration rather than a
 * guessed tag list.
 */
export function maybeShowImportReview(pending: PendingImport, schema: FormSchema): boolean {
  if (pending.applied) return false;

  const allowed = readAllowedTags(document);
  const result = extract(pending.html, pending.sourceUrl, allowed);

  const overlay = injectOverlay(
    <ImportFlow
      pending={pending}
      result={result}
      schema={schema}
      onDone={() => overlay.unmount()}
    />
  );

  return true;
}
