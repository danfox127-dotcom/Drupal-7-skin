import React, { useState } from 'react';
import { ExternalLink, Copy, Check } from 'lucide-react';
import { MediaRef } from '../../lib/clone/types';

/**
 * The images the source page used, for re-attaching by hand.
 *
 * Why by hand: every image field on these sites is a Media-module widget keyed by a file
 * id, and a file id names a row in the source site's database. There is no
 * `<input type="file">` on any of the nine content types to put bytes into, so the file
 * has to enter this site's library through Drupal's own Browse button.
 *
 * What this removes is the part that was actually tedious — going back to the old page to
 * work out which images it used and where each one went.
 */

interface Props {
  images: MediaRef[];
}

export const ImageChecklist = ({ images }: Props) => {
  const [copied, setCopied] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());

  const copyUrl = async (ref: MediaRef) => {
    if (!ref.url) return;
    try {
      await navigator.clipboard.writeText(ref.url);
      setCopied(ref.baseName);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // Clipboard access needs focus and a gesture; the URL is on screen either way.
    }
  };

  if (images.length === 0) {
    return (
      <p className="text-help text-ink-help">
        The source page had no images attached.
      </p>
    );
  }

  return (
    <div>
      <ul className="flex flex-col gap-2">
        {images.map(image => {
          const ticked = done.has(image.baseName);
          return (
            <li
              key={image.baseName}
              className={`flex items-center gap-3 p-2 border ${
                ticked ? 'border-rule-hair bg-legacy-100' : 'border-rule bg-white'
              }`}
            >
              <input
                type="checkbox"
                checked={ticked}
                onChange={() => setDone(prev => {
                  const next = new Set(prev);
                  if (next.has(image.baseName)) next.delete(image.baseName);
                  else next.add(image.baseName);
                  return next;
                })}
                aria-label={`Mark ${image.label} as attached`}
                className="shrink-0"
              />

              {image.thumbnailUrl && (
                <img
                  src={image.thumbnailUrl}
                  alt=""
                  className="w-16 h-12 object-cover bg-legacy-200 border border-rule shrink-0"
                />
              )}

              <div className="flex-1 min-w-0">
                <p className="text-eyebrow font-semibold uppercase text-ink-secondary">
                  {image.label}
                </p>
                <p className={`text-control truncate ${ticked ? 'text-ink-help line-through' : 'text-ink'}`}>
                  {image.filename || '(filename not readable)'}
                </p>
                {!image.url && (
                  <p className="text-help text-burnt">
                    This form did not expose a URL for the file — open the source page to find it.
                  </p>
                )}
              </div>

              {image.url && (
                <div className="flex items-center gap-1 shrink-0">
                  <a
                    href={image.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="px-2 py-1 inline-flex items-center gap-1 bg-white border border-rule-control text-ink rounded text-help font-semibold hover:bg-cu-tint transition-colors duration-200 ease-studio"
                  >
                    <ExternalLink size={12} aria-hidden="true" /> Open
                  </a>
                  <button
                    type="button"
                    onClick={() => void copyUrl(image)}
                    className="px-2 py-1 inline-flex items-center gap-1 bg-white border border-rule-control text-ink rounded text-help font-semibold hover:bg-cu-tint transition-colors duration-200 ease-studio"
                  >
                    {copied === image.baseName
                      ? <><Check size={12} aria-hidden="true" /> Copied</>
                      : <><Copy size={12} aria-hidden="true" /> Copy URL</>}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <p className="mt-2 text-help text-ink-help">
        Open each one, save it, then attach it with this form’s own Browse button. Nothing
        was uploaded — a file ID from the other site would point at the wrong file here, or
        at nothing.
      </p>
    </div>
  );
};
