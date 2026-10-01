import React, { useState } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { FieldDescriptor } from '../../lib/formSchema';
import { readValue } from '../../lib/fieldBinding';

/**
 * Search & Social: what a search result for this page will look like, the two fields that
 * shape it, and — folded in from the old "URL, SEO & Sitemap" block — one line each for
 * the URL alias and the sitemap, with every other SEO field behind "Override".
 *
 * The URL alias and sitemap are nearly always left on their defaults, which is why they
 * are summarised rather than listed; they are still one click away, and a validation
 * error on any of them opens the override list by itself.
 */

interface Props {
  /** The search result title and description fields (`search` section). */
  search: FieldDescriptor[];
  /** Everything from the old URL, SEO & Sitemap block (`seo` section). */
  seo: FieldDescriptor[];
  nodeTitle?: FieldDescriptor;
  summary?: FieldDescriptor;
  errorFor: (field: FieldDescriptor) => string | null;
  /** Renders a list of fields the way the rest of the rail does. */
  renderFields: (fields: FieldDescriptor[], section: 'search' | 'seo') => React.ReactNode;
}

const text = (field?: FieldDescriptor) => (field ? String(readValue(field) ?? '').trim() : '');

/** A metatag default like `[node:title] | [site:name]` is a token, not a preview. */
const isToken = (value: string) => /\[[a-z_-]+:[^\]]+\]/i.test(value);

/** The selected option's label, which says "Default (included)" where the value says "2". */
const optionLabel = (field?: FieldDescriptor) => {
  if (!field) return '';
  const value = String(readValue(field));
  return field.options?.find(o => o.value === value)?.label.trim() ?? value;
};

const byName = (fields: FieldDescriptor[], pattern: RegExp) =>
  fields.find(f => pattern.test(f.machineName));

/** Header summary for the rail: whether a description of its own is set. */
export function searchSummary(search: FieldDescriptor[]): string {
  const description = byName(search, /\[description\]/);
  if (!description) return '';
  const value = text(description);
  return value && !isToken(value) ? 'Description set' : 'Uses the summary';
}

export function SearchSocialSection({ search, seo, nodeTitle, summary, errorFor, renderFields }: Props) {
  const seoHasError = seo.some(f => errorFor(f));
  const [overriding, setOverriding] = useState(false);
  const showSeo = overriding || seoHasError;

  const metaTitle = text(byName(search, /\[title\]/));
  const metaDescription = text(byName(search, /\[description\]/));
  const shownTitle = (metaTitle && !isToken(metaTitle) ? metaTitle : text(nodeTitle)) || 'Untitled page';
  const shownDescription = (metaDescription && !isToken(metaDescription) ? metaDescription : text(summary))
    || 'No description yet. Search engines will pick a sentence from the page.';

  const pathauto = byName(seo, /^path\[pathauto\]$/);
  const alias = text(byName(seo, /^path\[alias\]$/));
  const aliasAutomatic = pathauto ? readValue(pathauto) === true : !alias;
  const shownPath = aliasAutomatic ? ' › address set automatically on save' : `/${alias.replace(/^\//, '')}`;

  const sitemapStatus = byName(seo, /^xmlsitemap\[status\]/);
  const sitemapPriority = byName(seo, /^xmlsitemap\[priority\]/);

  const compact: { label: string; value: string }[] = [];
  if (pathauto || byName(seo, /^path\[alias\]$/)) {
    compact.push({ label: 'URL alias', value: aliasAutomatic ? 'Automatic' : `/${alias.replace(/^\//, '')}` });
  }
  if (sitemapStatus) {
    compact.push({
      label: 'XML sitemap',
      value: [optionLabel(sitemapStatus), sitemapPriority && optionLabel(sitemapPriority)].filter(Boolean).join(' · '),
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div data-search-preview className="flex flex-col gap-0.5 px-3 py-2.5 bg-white border border-rule rounded">
        <span className="truncate text-row-title text-cu-blue">{shownTitle}</span>
        <span className="truncate text-help text-olive-text">{window.location.host}{shownPath}</span>
        <span className="text-help text-ink-secondary line-clamp-3">{shownDescription}</span>
      </div>

      {search.length > 0 && renderFields(search, 'search')}

      {seo.length > 0 && (
        <div className="flex flex-col pt-1.5 border-t border-rule-hair">
          {compact.map(row => (
            <div key={row.label} data-seo-summary={row.label} className="flex items-center gap-2.5 py-1">
              <span className="flex-1 text-control text-ink-secondary">{row.label}</span>
              <span className="text-control font-medium text-ink truncate">{row.value}</span>
            </div>
          ))}

          <button
            type="button"
            onClick={() => setOverriding(v => !v)}
            aria-expanded={showSeo}
            data-seo-override
            className="self-start mt-1 flex items-center gap-1.5 text-help font-semibold text-cu-blue hover:underline"
          >
            {showSeo ? <ChevronUp size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
            {showSeo ? 'Hide URL and sitemap settings' : 'Override URL and sitemap defaults'}
            {seoHasError && <span className="text-burnt">· needs attention</span>}
          </button>

          {showSeo && (
            <div data-seo-fields className="mt-3">
              {renderFields(seo, 'seo')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
