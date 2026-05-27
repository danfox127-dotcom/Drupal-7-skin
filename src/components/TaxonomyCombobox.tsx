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
    <div className="p-4 mb-6 bg-white border border-slate-200 rounded-xl shadow-sm font-sans">
      <div className="flex items-center gap-2 mb-3 text-indigo-600 font-bold text-xs uppercase tracking-widest">
        <Search size={14} />
        Menu Parent Selector
      </div>
      
      <div className="relative">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="w-full flex items-center justify-between px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-lg text-left focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
        >
          <span className={selectedOption ? 'text-slate-900' : 'text-slate-400'}>
            {selectedOption ? selectedOption.label : 'Search for a parent...'}
          </span>
          <ChevronDown size={18} className={`text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>

        {isOpen && (
          <div className="absolute z-50 w-full mt-2 bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden">
            <div className="p-2 border-b border-slate-100 bg-slate-50">
              <input
                autoFocus
                type="text"
                placeholder="Type to filter..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full px-3 py-2 bg-white border border-slate-300 rounded-md text-sm outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            
            <div className="max-h-64 overflow-y-auto">
              {filteredOptions.length === 0 ? (
                <div className="px-4 py-3 text-sm text-slate-500 text-center italic">
                  No matching parents found
                </div>
              ) : (
                filteredOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => handleSelect(option)}
                    className={`w-full flex items-center justify-between px-4 py-2 text-sm text-left hover:bg-indigo-50 transition-colors ${
                      selectedValue === option.value ? 'bg-indigo-50 text-indigo-700 font-semibold' : 'text-slate-700'
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
        <div className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
        <span className="text-[10px] text-slate-400 font-medium uppercase tracking-tight">
          Proxy UI Active & Synced to Native Form
        </span>
      </div>
    </div>
  );
};
