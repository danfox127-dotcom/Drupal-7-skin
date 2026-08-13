import React, { useState, useMemo, useCallback } from 'react';
import { X } from 'lucide-react';
import { ExtractionResult, Proposal, ProposedImage, acceptedCount, matchSummary } from '../../lib/import/extract';

/**
 * Screen 6 — the mapping review.
 *
 * The rule the design encodes and this enforces: NOTHING is filled until the editor
 * approves it, and approving fills the editor only — never Drupal.
 */

interface Props {
  result: ExtractionResult;
  targetType: string | null;
  /** Applies the accepted proposals to the form. */
  onApply: (accepted: Proposal[], images: ProposedImage[]) => void;
  onCancel: () => void;
}

const CONFIDENCE_LABEL: Record<Proposal['confidence'], string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
};

export const ImportReview = ({ result, targetType, onApply, onCancel }: Props) => {
  const [proposals, setProposals] = useState<Proposal[]>(result.proposals);
  const [images, setImages] = useState<ProposedImage[]>(result.images);
  const [selectedKey, setSelectedKey] = useState<string | null>(result.proposals[0]?.key ?? null);

  const selected = proposals.find(p => p.key === selectedKey) ?? null;
  const accepted = acceptedCount(proposals);
  const summary = matchSummary(result);

  const update = (key: string, patch: Partial<Proposal>) => {
    setProposals(prev => prev.map(p => (p.key === key ? { ...p, ...patch } : p)));
  };

  /**
   * The source pane: our own sanitized copy in a sandboxed iframe, not a live frame of
   * the source URL. A live frame is blocked by X-Frame-Options on most sites, and
   * outlining a region inside it would need a cross-origin read. Rendering the
   * annotated copy makes both work.
   *
   * `sandbox` with no allow-scripts means the injected markup cannot execute anything.
   */
  const sourceDoc = useMemo(() => {
    const highlight = selected?.regionId
      ? `[data-d7-region="${selected.regionId}"] { outline: 2px solid #1D4F91; outline-offset: 3px; }`
      : '';
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body { font: 14px/1.6 Georgia, serif; color: #1A1A1A; margin: 16px; background: #fff; }
      img { max-width: 100%; height: auto; }
      a { color: #1D4F91; }
      ${highlight}
    </style></head><body>${result.annotatedHtml}</body></html>`;
  }, [result.annotatedHtml, selected?.regionId]);

  const apply = useCallback(() => {
    onApply(proposals.filter(p => p.accepted), images);
  }, [proposals, images, onApply]);

  return (
    <div className="fixed inset-0 z-[2147483646] bg-canvas overflow-auto font-sans">
      {/* Sticky bar */}
      <div className="sticky top-0 z-10 bg-white border-b border-rule px-4.5 py-3 flex items-center gap-4 flex-wrap">
        <h1 className="font-serif text-heading-sm text-ink shrink-0">Import from URL</h1>

        <input
          type="text"
          readOnly
          value={result.sourceUrl}
          className="flex-1 max-w-[520px] px-3 py-1.5 bg-legacy-100 border border-rule-control rounded text-control text-ink-secondary"
        />

        <span className="text-help text-ink-help">
          Fetched · {summary.matched} of {summary.total} fields matched
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
          disabled={accepted === 0}
          className="px-4 py-1.5 bg-cu-blue hover:bg-cu-navy text-white rounded text-control font-semibold transition-colors duration-200 ease-studio disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Fill the editor with {accepted} field{accepted === 1 ? '' : 's'}
        </button>
      </div>

      <div className="grid items-start" style={{ gridTemplateColumns: '1fr 560px' }}>
        {/* Source pane */}
        <div className="bg-legacy-100 p-4">
          <div className="border border-rule bg-white">
            <div className="flex items-center justify-between px-3 py-1.5 bg-legacy-300 border-b border-rule">
              <span className="font-mono text-help text-ink-secondary truncate">{result.sourceUrl}</span>
              <span className="text-eyebrow font-semibold uppercase text-ink-secondary shrink-0 ml-3">
                Source Page
              </span>
            </div>
            <iframe
              title="Sanitized copy of the source page"
              sandbox=""
              srcDoc={sourceDoc}
              className="w-full h-[720px] border-0"
            />
          </div>
          <p className="mt-2 text-help text-ink-help">
            Selecting a field on the right outlines the part of the source page it was read from.
            {selected ? ` Currently showing: ${selected.label}.` : ''}
            {' '}This is a sanitized copy rendered by the extension, not a live frame of the source.
          </p>
        </div>

        {/* Mapping pane */}
        <div className="bg-rail min-h-full">
          <div className="flex items-center gap-3 px-4.5 py-3 border-b border-rule">
            <span className="text-eyebrow-wide font-semibold uppercase text-ink-secondary">
              Proposed Mapping
            </span>
            <span className="text-help text-ink-help">{accepted} of {proposals.length} accepted</span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => setProposals(prev => prev.map(p => ({ ...p, accepted: true })))}
              className="text-help font-semibold text-cu-blue hover:underline"
            >
              Accept all
            </button>
          </div>

          <ul>
            {proposals.map(proposal => {
              const isSelected = proposal.key === selectedKey;
              return (
                <li
                  key={proposal.key}
                  onMouseDown={() => setSelectedKey(proposal.key)}
                  className={`px-4.5 py-3 border-b border-rule-hair cursor-pointer transition-colors duration-200 ease-studio ${
                    !proposal.accepted ? 'bg-legacy-100' : isSelected ? 'bg-cu-tint' : 'bg-rail'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-eyebrow font-semibold uppercase text-ink-secondary">
                      {proposal.label}
                    </span>
                    <span className={`text-help ${proposal.confidence === 'low' ? 'text-burnt' : 'text-ink-help'}`}>
                      {CONFIDENCE_LABEL[proposal.confidence]}
                    </span>
                    <div className="flex-1" />
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); update(proposal.key, { accepted: !proposal.accepted }); }}
                      className={`px-2 py-0.5 rounded text-help font-semibold border transition-colors duration-200 ease-studio ${
                        proposal.accepted
                          ? 'bg-cu-blue border-cu-blue text-white'
                          : 'bg-white border-rule-control text-ink-help'
                      }`}
                    >
                      {proposal.accepted ? 'Accepted' : 'Skipped'}
                    </button>
                  </div>

                  {/* Editable, per the handoff — the proposal is a starting point. */}
                  {proposal.key === 'body' ? (
                    <textarea
                      value={proposal.value}
                      onChange={e => update(proposal.key, { value: e.target.value })}
                      onMouseDown={e => e.stopPropagation()}
                      className={`w-full mt-1.5 min-h-[90px] px-2 py-1.5 bg-white border border-rule-control rounded font-mono text-help ${
                        proposal.accepted ? 'text-ink' : 'text-ink-placeholder'
                      }`}
                    />
                  ) : (
                    <input
                      type="text"
                      value={proposal.value}
                      onChange={e => update(proposal.key, { value: e.target.value })}
                      onMouseDown={e => e.stopPropagation()}
                      className={`w-full mt-1.5 px-2 py-1.5 bg-white border border-rule-control rounded text-control ${
                        proposal.accepted ? 'text-ink' : 'text-ink-placeholder'
                      }`}
                    />
                  )}

                  <p className="mt-1 text-help text-ink-help">{proposal.source}</p>
                </li>
              );
            })}
          </ul>

          {/* Images */}
          <div className="px-4.5 py-3 border-b border-rule-hair">
            <p className="text-eyebrow-wide font-semibold uppercase text-ink-secondary">
              Images found ({images.length})
            </p>
            {images.length === 0 ? (
              <p className="mt-1 text-help text-ink-help">No images on the source page.</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-2">
                {images.map(image => (
                  <li key={image.id} className="flex items-center gap-3">
                    {/* Sanitized copy only; nothing is uploaded here. */}
                    <img
                      src={image.src}
                      alt=""
                      className="w-16 h-12 object-cover bg-legacy-200 border border-rule shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-control text-ink truncate">{image.name}</p>
                      <p className="text-help text-ink-help truncate">
                        {image.meta}{image.reason ? `${image.meta ? ' · ' : ''}${image.reason}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {(['teaser', 'featured', 'skip'] as const).map(role => (
                        <button
                          key={role}
                          type="button"
                          onClick={() => setImages(prev => prev.map(i => (i.id === image.id ? { ...i, role } : i)))}
                          className={`px-2 py-0.5 rounded border text-help font-semibold capitalize transition-colors duration-200 ease-studio ${
                            image.role === role
                              ? 'bg-cu-tint border-cu-blue text-cu-blue'
                              : 'bg-white border-rule-control text-ink hover:bg-cu-tint'
                          }`}
                        >
                          {role}
                        </button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-help text-ink-help">
              Images are copied into the media library on first save; alt text is requested before Publish.
            </p>
          </div>

          {/* Left for you — the honesty of the feature. Keep it. */}
          <div className="px-4.5 py-3">
            <p className="text-eyebrow-wide font-semibold uppercase text-ink-secondary">Left for you</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {result.unmapped.map(item => (
                <li key={item.label}>
                  <p className="text-control font-semibold text-ink">{item.label}</p>
                  <p className="text-help text-ink-help">{item.reason}</p>
                </li>
              ))}
            </ul>
          </div>

          <p className="px-4.5 pb-4 text-help text-ink-help">
            Body markup was filtered to{' '}
            {result.allowedTags.source === 'drupal-filter-tips'
              ? "this site's own allowed-tag list, read from the form"
              : 'a conservative default list — this form did not publish its allowed tags, so some markup may still be stripped on save'}
            .
          </p>
        </div>
      </div>
    </div>
  );
};

/** The post-approval banner: eyebrow, source, and that nothing was written. */
export const ImportedBanner = ({ sourceUrl, onBack }: { sourceUrl: string; onBack: () => void }) => (
  <div className="flex items-start gap-3 p-3 bg-cu-light border border-cu-blue font-sans">
    <div className="flex-1">
      <p className="text-eyebrow font-semibold uppercase text-cu-onLight">Imported</p>
      <p className="text-control text-ink mt-0.5">
        Filled from <span className="font-mono">{sourceUrl}</span> — nothing written to Drupal yet.
      </p>
    </div>
    <button
      type="button"
      onClick={onBack}
      className="shrink-0 px-3 py-1 bg-white border border-cu-blue text-cu-blue rounded text-help font-semibold hover:bg-cu-tint transition-colors duration-200 ease-studio"
    >
      Back to the mapping
    </button>
  </div>
);
