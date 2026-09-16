import React, { useState } from 'react';
import { TaxonomyCombobox, Option } from './TaxonomyCombobox';
import { enableMenuLink } from '../lib/menuLink';

interface Props {
  options: Option[];
  defaultValue?: string;
  /** Writes the value into the native select the picker replaced. */
  onSelect: (value: string) => void;
}

/**
 * The searchable menu parent picker, plus the two things Drupal needs for a choice to
 * survive a save.
 *
 * The picker alone set `menu[parent]` and nothing else, and Drupal discards the parent
 * while "Provide a menu link" is unticked — without reporting anything. See
 * src/lib/menuLink.ts for why that gate exists and why the rule lives there rather than
 * here; this component's only job is to run it and say what it did.
 *
 * Saying what it did matters. The extension is filling in two controls the editor did not
 * touch, one of which is a visible text field. Doing that silently is how someone ends up
 * distrusting the tool, even when the write is correct.
 */
export const MenuParentField = ({ options, defaultValue, onSelect }: Props) => {
  const [note, setNote] = useState<string | null>(null);

  const handleSelect = (value: string) => {
    onSelect(value);

    const outcome = enableMenuLink(document);
    if (!outcome.ticked) {
      // Already in the menu, so nothing was changed on the editor's behalf.
      setNote(null);
      return;
    }
    setNote(
      outcome.titleWritten
        ? `Ticked "Provide a menu link" and set the link title to "${outcome.titleWritten}". Save to keep this placement.`
        : 'Ticked "Provide a menu link". Save to keep this placement.'
    );
  };

  return (
    <div className="flex flex-col gap-1.5">
      <TaxonomyCombobox options={options} defaultValue={defaultValue} onSelect={handleSelect} />
      {note && (
        <p role="status" aria-live="polite" data-menu-link-note className="text-help text-ink-secondary">
          {note}
        </p>
      )}
    </div>
  );
};
