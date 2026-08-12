import React, { useState, useMemo } from 'react';
import { Search, ChevronDown, Check } from 'lucide-react';

interface Option {
  value: string;
  label: string;
  originalLabel: string;
  depth: number;
}

interface Props {
  options: Option[];
  defaultValue?: string;
  onSelect: (value: string) => void;
}

export const TaxonomyCombobox = ({ options, defaultValue, onSelect }: Props) => {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedValue, setSelectedValue] = useState(defaultValue || '');

  const filteredOptions = useMemo(() => {
    return options.filter(opt =>
      opt.label.toLowerCase().includes(search.toLowerCase())
    );
  }, [options, search]);

  const selectedOption = useMemo(() =>
    options.find(opt => opt.value === selectedValue),
  [options, selectedValue]);

  const handleSelect = (option: Option) => {
    setSelectedValue(option.value);
    onSelect(option.value);
    setIsOpen(false);
    setSearch('');
  };

  return (
    <div className="p-4 mb-6 bg-white border border-rule font-sans">
      <div className="flex items-center gap-2 mb-3 text-cu-blue font-semibold text-eyebrow uppercase">
        <Search size={14} />
        Menu Parent Selector
      </div>

      <div className="relative">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="w-full flex items-center justify-between px-4 py-2.5 bg-legacy-100 border border-rule-control rounded text-left text-input transition-colors duration-200 ease-studio hover:bg-cu-tint"
        >
          {/* The empty state is visible content on a button, not an input
              placeholder, so it needs AA contrast rather than placeholder gray. */}
          <span className={selectedOption ? 'text-ink' : 'text-ink-help'}>
            {selectedOption ? selectedOption.label : 'Search for a parent...'}
          </span>
          <ChevronDown size={18} className={`text-ink-muted transition-transform duration-200 ease-studio ${isOpen ? 'rotate-180' : ''}`} />
        </button>

        {isOpen && (
          <div className="absolute z-50 w-full mt-2 bg-white border border-rule shadow-modal overflow-hidden">
            <div className="p-2 border-b border-rule-hair bg-rail">
              <input
                autoFocus
                type="text"
                placeholder="Type to filter..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full px-3 py-2 bg-white border border-rule-control rounded text-control text-ink placeholder:text-ink-placeholder"
              />
            </div>

            <div className="max-h-64 overflow-y-auto">
              {filteredOptions.length === 0 ? (
                <div className="px-4 py-3 text-control text-ink-help text-center italic">
                  No matching parents found
                </div>
              ) : (
                filteredOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => handleSelect(option)}
                    className={`w-full flex items-center justify-between px-4 py-2 text-control text-left transition-colors duration-200 ease-studio hover:bg-cu-tint ${
                      selectedValue === option.value ? 'bg-cu-tint text-cu-blue font-semibold' : 'text-ink'
                    }`}
                  >
                    <span style={{ paddingLeft: `${option.depth * 12}px` }}>
                      {option.label}
                    </span>
                    {selectedValue === option.value && <Check size={16} />}
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <div className="h-1.5 w-1.5 rounded-full bg-olive" />
        <span className="text-eyebrow text-ink-help font-semibold uppercase">
          Proxy UI Active &amp; Synced to Native Form
        </span>
      </div>
    </div>
  );
};
