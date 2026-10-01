import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';
import { FieldDescriptor, FieldOption } from '../../lib/formSchema';
import { readValue, writeValue } from '../../lib/fieldBinding';
import {
  fetchSiblingWeights, orderSiblings, parseOptionValue, positionOf, siblingsUnder,
  weightForPosition, WeightedSibling,
} from '../../lib/menuPosition';
import { FieldControl } from './FieldControl';
import { InfoTip } from './InfoTip';

/**
 * Where this page sits among the links under its parent, and a way to move it.
 *
 * The native control is a -50…50 weight select, which asks an editor to know the weights
 * of links they cannot see. This shows the siblings in Drupal's real order with this page
 * among them; clicking a link places the page above it, and the arrows nudge it. Only
 * THIS link's weight is ever written — see lib/menuPosition for why some slots cannot be
 * reached that way, and are shown but not clickable.
 */

interface Props {
  /** The parent select's options, in Drupal's tree order. */
  options: FieldOption[];
  /** The chosen parent's option value, e.g. `main-menu:950`. */
  parentValue: string;
  /** `menu[weight]`. */
  weight: FieldDescriptor;
  /** This link's own title, as Drupal will sort it. */
  selfTitle: string;
  /** Called after a placement is written, so the section can enable the link. */
  onPlaced: () => void;
}

/** Sibling weights already read this session, by parent option value. */
const weightCache = new Map<string, Map<string, number>>();

type Load =
  | { state: 'loading' }
  | { state: 'ready'; weights: Map<string, number> }
  | { state: 'unavailable' };

export function MenuPosition({ options, parentValue, weight, selfTitle, onPlaced }: Props) {
  const siblings = useMemo(() => siblingsUnder(options, parentValue), [options, parentValue]);
  const [load, setLoad] = useState<Load>(() => {
    const cached = weightCache.get(parentValue);
    return cached ? { state: 'ready', weights: cached } : { state: 'loading' };
  });
  const [, setTick] = useState(0);

  useEffect(() => {
    const cached = weightCache.get(parentValue);
    if (cached) { setLoad({ state: 'ready', weights: cached }); return; }

    const parsed = parseOptionValue(parentValue);
    if (!parsed) { setLoad({ state: 'unavailable' }); return; }

    let current = true;
    setLoad({ state: 'loading' });
    void fetchSiblingWeights(parsed.menuName, parsed.mlid, siblings.map(s => s.mlid)).then(weights => {
      if (!current) return;
      if (!weights) { setLoad({ state: 'unavailable' }); return; }
      weightCache.set(parentValue, weights);
      setLoad({ state: 'ready', weights });
    });
    return () => { current = false; };
  }, [parentValue, siblings]);

  const allowed = useMemo(
    () => (weight.options ?? []).map(o => Number(o.value)).filter(n => Number.isFinite(n)),
    [weight.options]
  );

  /** A saved link's own mlid, which breaks sort ties; absent on a link not saved yet. */
  const selfMlid = useMemo(() => {
    const form = weight.elements[0]?.closest('form');
    const value = form?.querySelector<HTMLInputElement>('input[name="menu[mlid]"]')?.value ?? '';
    return /^[1-9]\d*$/.test(value) ? value : undefined;
  }, [weight.elements]);

  const listRef = useRef<HTMLDivElement>(null);
  const selfRef = useRef<HTMLDivElement>(null);

  const ready = load.state === 'ready' ? load : null;
  const ordered: WeightedSibling[] = useMemo(
    () => (ready ? orderSiblings(siblings.map(s => ({ ...s, weight: ready.weights.get(s.mlid) ?? 0 }))) : []),
    [ready, siblings]
  );

  const self = { title: selfTitle, weight: Number(readValue(weight)) || 0, mlid: selfMlid };
  const pos = ready ? positionOf(ordered, self) : 0;

  // Keep this page's row in view inside the list — never scroll the page itself.
  useEffect(() => {
    const list = listRef.current;
    const row = selfRef.current;
    if (!list || !row) return;
    const top = row.offsetTop - list.offsetTop;
    if (top < list.scrollTop || top + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = Math.max(0, top - list.clientHeight / 2);
    }
  }, [pos, ready]);

  const placeAt = (index: number) => {
    const next = weightForPosition(ordered, self, index, allowed);
    if (next === null) return;
    writeValue(weight, String(next));
    onPlaced();
    setTick(t => t + 1);
  };

  if (load.state === 'unavailable') {
    return (
      <div className="flex flex-col gap-2" data-menu-position="unavailable">
        <p className="text-help text-ink-help">
          The current order of the links under this parent could not be read, so the page
          cannot be placed among them here. Its weight can still be set directly: lower
          weights sit higher in the menu.
        </p>
        <FieldControl field={weight} dense />
      </div>
    );
  }

  const rows = ready
    ? [...ordered.slice(0, pos).map((s, i) => ({ sibling: s, index: i })),
      null,
      ...ordered.slice(pos).map((s, i) => ({ sibling: s, index: pos + i }))]
    : [];
  const canUp = ready && pos > 0 && weightForPosition(ordered, self, pos - 1, allowed) !== null;
  const canDown = ready && pos < ordered.length && weightForPosition(ordered, self, pos + 1, allowed) !== null;

  return (
    <div className="flex flex-col gap-1.5" data-menu-position={load.state}>
      <div className="flex items-center gap-2">
        <span className="text-eyebrow font-semibold uppercase text-ink-secondary">Position</span>
        <InfoTip
          about="Position"
          text="Click a link to place this page above it, or use the arrows. The menu weight is written for you on save."
        />
        <span className="ml-auto text-help text-ink-help" data-menu-weight>
          Weight {self.weight}
        </span>
      </div>

      {load.state === 'loading' ? (
        <p className="px-3 py-2 bg-white border border-rule rounded text-help text-ink-help">
          Reading the order of {siblings.length} link{siblings.length === 1 ? '' : 's'} under this parent…
        </p>
      ) : (
        <div ref={listRef} className="max-h-[240px] overflow-y-auto bg-white border border-rule rounded">
          {rows.map((row, displayIndex) => {
            if (row === null) {
              return (
                <div
                  key="__self"
                  ref={selfRef}
                  data-position-self
                  className="flex items-center gap-2.5 px-2.5 py-1.5 border-b border-rule-faint border-l-[3px] border-l-cu-blue bg-cu-tint"
                >
                  <span className="w-5 shrink-0 text-right font-mono text-help text-ink-help">{displayIndex + 1}</span>
                  <span className="flex-1 min-w-0 truncate text-control font-semibold text-cu-blue">{selfTitle}</span>
                  <span className="flex gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => placeAt(pos - 1)}
                      disabled={!canUp}
                      aria-label="Move up"
                      className="w-6 h-6 inline-flex items-center justify-center border border-cu-light rounded bg-white text-cu-blue hover:border-cu-blue disabled:opacity-40 disabled:hover:border-cu-light"
                    >
                      <ArrowUp size={13} aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => placeAt(pos + 1)}
                      disabled={!canDown}
                      aria-label="Move down"
                      className="w-6 h-6 inline-flex items-center justify-center border border-cu-light rounded bg-white text-cu-blue hover:border-cu-blue disabled:opacity-40 disabled:hover:border-cu-light"
                    >
                      <ArrowDown size={13} aria-hidden />
                    </button>
                  </span>
                </div>
              );
            }

            // Clicking a sibling places this page directly above it.
            const reachable = weightForPosition(ordered, self, row.index, allowed) !== null;
            return (
              <button
                key={row.sibling.mlid}
                type="button"
                onClick={() => placeAt(row.index)}
                disabled={!reachable}
                data-position-sibling={row.sibling.mlid}
                title={reachable
                  ? `Place this page above “${row.sibling.title}”`
                  : 'Links around this spot share a weight, so only their titles order them. Reorder them in the menu manager to place this page here.'}
                className="w-full flex items-center gap-2.5 px-2.5 py-1.5 border-b border-rule-faint text-left hover:bg-cu-tint disabled:hover:bg-white disabled:cursor-not-allowed transition-colors duration-200 ease-studio"
              >
                <span className="w-5 shrink-0 text-right font-mono text-help text-ink-help">{displayIndex + 1}</span>
                <span className={`flex-1 min-w-0 truncate text-control ${row.sibling.disabled ? 'text-ink-muted italic' : 'text-ink'}`}>
                  {row.sibling.title}
                  {row.sibling.disabled && <span className="sr-only"> (disabled)</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
