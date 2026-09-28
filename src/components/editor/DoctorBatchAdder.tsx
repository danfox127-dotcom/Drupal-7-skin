import React, { useState, useCallback } from 'react';
import { Loader2, Check, X, HelpCircle } from 'lucide-react';
import { FieldDescriptor } from '../../lib/formSchema';
import { writeValue } from '../../lib/fieldBinding';
import { autocompletePathFor, probeReference } from '../../lib/clone/references';
import { addAnotherRow, widgetBaseName } from '../../lib/clone/paragraphs';

/**
 * Fast-adds several profiles at once to a plain multi-value entityreference table —
 * List's "Individual Profiles", one name/row at a time via Drupal's native UI otherwise.
 *
 * Each name is checked against this site's own autocomplete endpoint before a row is
 * created, same technique the cross-site paste flow uses in clone/references.ts: writing
 * an unresolved title straight into the field would make Drupal refuse the whole save.
 * A name with no match is reported rather than silently dropped, so nothing added here
 * disappears without the user knowing why.
 *
 * Sequential, never parallel — every add-more is a server round trip that rebuilds the
 * table, so firing several at once would race and drop rows, same reasoning as
 * rebuildParagraphs.
 */

type RowStatus = 'pending' | 'checking' | 'added' | 'not-found' | 'unavailable';

interface Row {
  name: string;
  status: RowStatus;
}

interface Props {
  /** Any control already known to belong to this widget's current last row. */
  anyElement: HTMLElement;
  fieldLabel: string;
}

function splitNames(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map(s => s.trim())
    .filter(Boolean);
}

export function DoctorBatchAdder({ anyElement, fieldLabel }: Props) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    const names = splitNames(text);
    if (names.length === 0) return;

    setBusy(true);
    setRows(names.map(name => ({ name, status: 'pending' })));

    const baseName = widgetBaseName(
      (anyElement as HTMLInputElement).name ?? anyElement.id
    );

    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      setRows(prev => prev.map((r, idx) => idx === i ? { ...r, status: 'checking' } : r));

      // Re-read on every iteration: the previous add-more just rebuilt the table, so
      // the element from props may already be detached. Highest delta = the last row,
      // since deltas are only ever appended, never removed, by this widget.
      const rowsSoFar = baseName
        ? Array.from(document.querySelectorAll<HTMLInputElement>(
            `[name^="${cssPrefix(baseName)}[und]"][name$="[target_id]"]`
          ))
        : [];
      const currentInput = rowsSoFar[rowsSoFar.length - 1] ?? (anyElement as HTMLInputElement);

      const path = autocompletePathFor({ elements: [currentInput] } as unknown as FieldDescriptor);
      if (!path || !baseName) {
        setRows(prev => prev.map((r, idx) => idx === i ? { ...r, status: 'unavailable' } : r));
        continue;
      }

      const result = await probeReference(path, name);
      if (result.status !== 'match' || !result.value) {
        setRows(prev => prev.map((r, idx) =>
          idx === i ? { ...r, status: result.status === 'match' ? 'unavailable' : result.status === 'no-match' ? 'not-found' : 'unavailable' } : r
        ));
        continue;
      }

      const added = await addAnotherRow(currentInput, baseName);
      if (!added.ok || added.delta === null) {
        setRows(prev => prev.map((r, idx) => idx === i ? { ...r, status: 'unavailable' } : r));
        continue;
      }

      const newInput = document.querySelector<HTMLInputElement>(
        `[name=${JSON.stringify(`${baseName}[und][${added.delta}][target_id]`)}]`
      );
      if (!newInput) {
        setRows(prev => prev.map((r, idx) => idx === i ? { ...r, status: 'unavailable' } : r));
        continue;
      }

      writeValue({ kind: 'autocomplete', elements: [newInput] } as unknown as FieldDescriptor, result.value);
      setRows(prev => prev.map((r, idx) => idx === i ? { ...r, status: 'added' } : r));
    }

    setBusy(false);
  }, [text, anyElement]);

  const icon = (status: RowStatus) => {
    switch (status) {
      case 'added': return <Check className="w-3.5 h-3.5 text-green-700 shrink-0" />;
      case 'not-found': return <X className="w-3.5 h-3.5 text-burnt shrink-0" />;
      case 'checking': return <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-secondary shrink-0" />;
      case 'unavailable': return <HelpCircle className="w-3.5 h-3.5 text-ink-secondary shrink-0" />;
      default: return <span className="w-3.5 h-3.5 shrink-0" />;
    }
  };

  const label = (status: RowStatus) => {
    switch (status) {
      case 'added': return 'Added';
      case 'not-found': return 'No match on this site';
      case 'checking': return 'Checking…';
      case 'unavailable': return 'Could not check — add by hand';
      default: return '';
    }
  };

  return (
    <div className="bg-cu-tint border-l-2 border-l-cu-blue rounded p-3 mb-3">
      <p className="text-eyebrow font-semibold uppercase text-ink-secondary mb-1">
        Add several {fieldLabel.toLowerCase()} at once
      </p>
      <p className="text-help text-ink-secondary mb-2">
        One name per line, or comma-separated. Each is checked against this site before a
        row is added — a name with no match is reported, not written.
      </p>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        disabled={busy}
        placeholder={'Jane Smith\nJohn Doe'}
        className="w-full min-h-[70px] px-3 py-2 bg-white border border-rule-control rounded text-input text-ink placeholder:text-ink-placeholder"
      />
      <button
        type="button"
        onClick={run}
        disabled={busy || splitNames(text).length === 0}
        className="mt-2 px-3 py-1.5 bg-cu-blue text-white rounded text-control disabled:opacity-50"
      >
        {busy ? 'Adding…' : 'Add all'}
      </button>
      {rows.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {rows.map((row, i) => (
            <li key={`${row.name}-${i}`} className="flex items-center gap-2 text-control text-ink">
              {icon(row.status)}
              <span>{row.name}</span>
              {row.status !== 'pending' && (
                <span className="text-help text-ink-secondary">— {label(row.status)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Escapes a Drupal name prefix for a CSS attribute selector — brackets need no escaping
 *  inside a quoted attribute value, but the string still has to be a valid selector. */
function cssPrefix(baseName: string): string {
  return baseName.replace(/"/g, '\\"');
}
