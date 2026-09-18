import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { discoverSchema, FormSchema } from '../lib/formSchema';
import { latestCopy } from '../lib/clone/clipboard';
import { matchFields, FieldMatch } from '../lib/clone/match';
import { applyMatches, CloneOutcome, summarise, paragraphProblems } from '../lib/clone/apply';
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
  snapshot, outcome, onBack, onDismiss,
}: {
  snapshot: NodeSnapshot;
  outcome: CloneOutcome;
  onBack: () => void;
  onDismiss: () => void;
}) => {
  const attention = [...outcome.failed, ...outcome.blanked, ...outcome.partial];
  const itemProblems = paragraphProblems(outcome);

  return (
    /**
     * pointer-events-none on the full-width strip, auto on the panel inside it.
     *
     * This wrapper spans left-0 to right-0 while the panel it holds is 860px and
     * centred, so its left and right thirds are invisible AND were still swallowing
     * clicks. Drupal's own "Save draft to Drupal" and "Publish" buttons sit in that
     * vertical band on a wide window, which made them unclickable — reported as "I can't
     * save a draft of what I have", with nothing on screen to suggest why.
     */
    <div className="fixed top-11 left-0 right-0 z-[2147483645] px-4 font-sans pointer-events-none">
      <div className="max-w-[860px] mx-auto pointer-events-auto">
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
            <p className="text-help text-ink-help mt-0.5">
              Press <kbd className="font-mono">Esc</kbd> or Dismiss to close this and get
              back to the form.
            </p>
          </div>
          <div className="shrink-0 flex items-center gap-2">
            <button
              type="button"
              onClick={onBack}
              className="px-3 py-1 bg-white border border-cu-blue text-cu-blue rounded text-help font-semibold hover:bg-cu-tint transition-colors duration-200 ease-studio"
            >
              Back to the review
            </button>
            {/**
              * A way out. This banner sits over the form until the page is reloaded, and
              * the images list under it can run to several rows — so without this it is
              * something covering the work rather than something reporting on it.
              */}
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss this summary"
              title="Dismiss (Esc)"
              className="px-2 py-1 inline-flex items-center gap-1 bg-white border border-rule-control text-ink-secondary rounded text-help font-semibold hover:bg-legacy-200 transition-colors duration-200 ease-studio"
            >
              <X size={12} aria-hidden="true" /> Dismiss
            </button>
          </div>
        </div>

        {(attention.length > 0 || itemProblems.length > 0) && (
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
              {itemProblems.map((problem, index) => (
                <li key={`item-${index}`} className="text-control text-ink">{problem}</li>
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

  /**
   * Escape closes whichever of the two screens is up.
   *
   * There were previously no keyboard route out and — because of the click-swallowing
   * wrapper — no reliable mouse route either, which is how this came to be reported as
   * "I cannot exit the media review" and "I click and nothing happens". A modal that
   * covers someone's work needs more than one exit.
   *
   * Capture phase, for the same reason the command palette uses it: Drupal's own key
   * handlers and CKEditor's bind plenty and would otherwise swallow the chord first.
   * Not while a write is in flight, since abandoning halfway through would leave the
   * form half-filled with nothing reporting on it.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return;
      event.preventDefault();
      event.stopPropagation();
      onDone();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [busy, onDone]);

  const handleApply = async (accepted: FieldMatch[]) => {
    if (busy) return;
    setBusy(true);
    try {
      /**
       * Reference lookups happen in here, so this is genuinely asynchronous and the
       * review stays up until it finishes. Closing first would leave the editor looking
       * at a form filling itself a field at a time.
       */
      const result = await applyMatches(accepted, snapshot.media, window.location, snapshot.paragraphs);
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
    ? (
      <PastedBanner
        snapshot={snapshot}
        outcome={outcome}
        onBack={() => setReviewing(true)}
        onDismiss={onDone}
      />
    )
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
