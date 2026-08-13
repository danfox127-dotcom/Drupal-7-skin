import React, { useState } from 'react';
import { FileCode, Loader2, Check, AlertCircle } from 'lucide-react';
import { copyPublicHtml } from '../lib/extractPublicHtml';

export const HtmlExport = () => {
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const handleExport = async () => {
    setStatus('loading');
    setErrorMsg('');

    try {
      // Shared with the ⌘K "Copy public HTML of this node" command, so the two
      // paths cannot diverge. See src/lib/extractPublicHtml.ts.
      await copyPublicHtml();

      setStatus('success');
      setTimeout(() => setStatus('idle'), 3000);
    } catch (err) {
      console.error('[D7 Proxy] Export failed:', err);
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  };

  return (
    <div className="p-5 mb-8 bg-legacy-100 border border-rule flex flex-col gap-4 font-sans">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          {/* Status is carried by the icon's shape as well as its color, so it
              does not rely on color alone. */}
          <div className={`p-3 transition-colors duration-200 ease-studio ${
            status === 'success' ? 'bg-cu-tint text-olive' :
            status === 'error' ? 'bg-cu-tint text-burnt' :
            'bg-cu-tint text-cu-blue'
          }`}>
            {status === 'loading' ? <Loader2 size={24} className="animate-spin" /> :
             status === 'success' ? <Check size={24} /> :
             status === 'error' ? <AlertCircle size={24} /> :
             <FileCode size={24} />}
          </div>
          <div>
            <h3 className="font-serif text-heading-sm text-ink">Content Extraction Engine</h3>
            <p className="text-help text-ink-help">
              {status === 'success' ? 'Copied to clipboard!' : 'Export sanitized public HTML'}
            </p>
          </div>
        </div>

        <button
          disabled={status === 'loading'}
          onClick={handleExport}
          className={`px-6 py-2.5 rounded font-semibold text-control transition-colors duration-200 ease-studio flex items-center gap-2
            ${status === 'loading' ? 'bg-rule text-ink-muted cursor-not-allowed' :
              'bg-cu-blue text-white hover:bg-cu-navy'}
          `}
        >
          {status === 'loading' ? 'Processing...' :
           status === 'success' ? 'Done!' :
           status === 'error' ? 'Retry' :
           'Export Raw HTML'}
        </button>
      </div>

      {status === 'error' && (
        <div className="text-help text-burnt bg-white p-2 rounded border border-rule">
          Error: {errorMsg}
        </div>
      )}
    </div>
  );
};
