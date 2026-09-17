import React, { useState } from 'react';
import { discoverSchema, FormSchema } from '../lib/formSchema';
import { latestCopy } from '../lib/clone/clipboard';
import { matchFields, FieldMatch } from '../lib/clone/match';
import { applyMatches, CloneOutcome, summarise } from '../lib/clone/apply';
import { NodeSnapshot } from '../lib/clone/types';
import { Unmapped } from '../lib/import/extract';
import { PasteReview } from '../components/clone/PasteReview';
import { ImageChecklist } from '../components/clone/ImageChecklist';
import { injectOverlay } from './inject';

/**
 * Pasting a copied page into the form on screen.
 *
 * Mirrors src/content/importFlow.tsx: the review is mounted over the page, approval
 * writes to the FORM only, and Drupal is untouched until the editor presses Save. The
 * publish state is never written, so what lands is a draft.
 */

/** What the editor sees once the form has been filled. */
const PastedBanner = ({
  snapshot, outcome, onBack,
}: {
  snapshot: NodeSnapshot;
  outcome: CloneOutcome;
  onBack: () => void;
}) => {
  const attention = [...outcome.failed, ...outcome.blanked, ...outcome.partial];

  return (
    <div className="fixed top-11 left-0 right-0 z-[2147483645] px-4 font-sans">
      <div className="max-w-[860px] mx-auto">
        <div className="flex items-start gap-3 p-3 bg-cu-light border border-cu-blue">
          <div className="flex-1 min-w-0">
            <p className="text-eyebrow font-semibold uppercase text-cu-onLight">Pasted</p>
            <p className="text-control text-ink mt-0.5">
              {summarise(outcome)} — from{' '}
              <span className="font-semibold">{snapshot.title || snapshot.sourceUrl}</span>.
            </p>
            <p className="text-help text-ink-help mt-0.5">
              Nothing has been written to Drupal. Check the form, then press Save — it saves
              as a draft, and you publish it afterwards.
            </p>
          </div>
          <button
            type="button"
            onClick={onBack}
            className="shrink-0 px-3 py-1 bg-white border border-cu-blue text-cu-blue rounded text-help font-semibold hover:bg-cu-tint transition-colors duration-200 ease-studio"
          >
            Back to the review
          </button>
        </div>

        {attention.length > 0 && (
          <div className="mt-2 p-3 bg-white border border-burnt max-h-[40vh] overflow-auto">
            <p className="text-eyebrow font-semibold uppercase text-ink-secondary">
              Worth a look
            </p>
            <ul className="mt-1.5 flex flex-col gap-1">
              {attention.map(item => (
                <li key={item.machineName}>
                  <span className="text-control font-semibold text-ink">{item.label}</span>
                  {item.note && <span className="text-help text-ink-help"> — {item.note}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {outcome.images.length > 0 && (
          <div className="mt-2 p-3 bg-white border border-rule max-h-[40vh] overflow-auto">
            <p className="text-eyebrow font-semibold uppercase text-ink-secondary">
              Images to attach ({outcome.images.length})
            </p>
            <div className="mt-2">
              <ImageChecklist images={outcome.images} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

function CloneFlow({
  snapshot, matches, unmapped, schema, onDone,
}: {
  snapshot: NodeSnapshot;
  matches: FieldMatch[];
  unmapped: Unmapped[];
  schema: FormSchema;
  onDone: () => void;
}) {
  const [reviewing, setReviewing] = useState(true);
  const [outcome, setOutcome] = useState<CloneOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  const handleApply = async (accepted: FieldMatch[]) => {
    if (busy) return;
    setBusy(true);
    try {
      /**
       * Reference lookups happen in here, so this is genuinely asynchronous and the
       * review stays up until it finishes. Closing first would leave the editor looking
       * at a form filling itself a field at a time.
       */
      const result = await applyMatches(accepted, snapshot.media);
      setOutcome(result);
      setReviewing(false);
    } finally {
      setBusy(false);
    }
  };

  if (reviewing) {
    return (
      <PasteReview
        snapshot={snapshot}
        matches={matches}
        unmapped={unmapped}
        targetType={schema.contentType}
        onApply={accepted => { void handleApply(accepted); }}
        onCancel={onDone}
      />
    );
  }

  return outcome
    ? <PastedBanner snapshot={snapshot} outcome={outcome} onBack={() => setReviewing(true)} />
    : null;
}

/**
 * Opens the review for the most recent copy.
 *
 * Throws with something an editor can act on, rather than returning false: this is
 * invoked from the command palette, which reports a thrown message.
 *
 * The copy is deliberately NOT consumed. The same page often goes to more than one site,
 * and a paste that silently emptied the clipboard would mean re-copying between them.
 */
export async function pastePage(): Promise<void> {
  const schema = discoverSchema();
  if (!schema) {
    throw new Error(
      'The fields on this form could not be read, so there is nothing to paste into. '
      + 'Turn on "Log Form Schema" in the extension popup and reload to see why.'
    );
  }

  const snapshot = await latestCopy();
  if (!snapshot) {
    throw new Error(
      'No copied page is waiting. Open the page you want to duplicate on the other site, '
      + 'press ⌘K and choose "Copy this page for pasting on another site".'
    );
  }

  const { matches, unmapped } = matchFields(snapshot, schema);

  const overlay = injectOverlay(
    <CloneFlow
      snapshot={snapshot}
      matches={matches}
      unmapped={unmapped}
      schema={schema}
      onDone={() => overlay.unmount()}
    />
  );
}
