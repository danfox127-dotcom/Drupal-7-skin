import React, { useState } from 'react';
import { FileCode, Loader2, Check, AlertCircle } from 'lucide-react';

export const HtmlExport = () => {
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const handleExport = async () => {
    setStatus('loading');
    setErrorMsg('');

    try {
      // 1. Parse Node ID from URL: /node/123/edit
      const match = window.location.pathname.match(/\/node\/(\d+)/);
      if (!match) throw new Error('Could not determine Node ID from URL');
      const nodeId = match[1];

      // 2. Fetch the public-facing URL
      // We use /node/{id} directly to bypass the admin theme
      const publicUrl = `${window.location.origin}/node/${nodeId}`;
      console.log(`📡 Fetching public content from: ${publicUrl}`);
      
      const response = await fetch(publicUrl);
      if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
      
      const html = await response.text();

      // 3. Parse and Extract Main Content
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      
      // Target common Drupal main content wrappers
      // We prefer <article>, but fallback to #content or .region-content
      const mainContent = doc.querySelector('article') || 
                          doc.querySelector('#content') || 
                          doc.querySelector('.region-content') ||
                          doc.querySelector('main');

      if (!mainContent) {
        throw new Error('Could not locate main content wrapper (<article> or #content) in the fetched page.');
      }

      // 4. Sanitize: Remove noise
      const selectorsToRemove = [
        'script', 'style', 'header', 'footer', 'nav', 
        '.admin-tabs', '.contextual-links-wrapper', 
        '#skip-link', '.breadcrumb'
      ];
      selectorsToRemove.forEach(s => {
        mainContent.querySelectorAll(s).forEach(el => el.remove());
      });

      // 5. Clean up attributes (optional but helpful for "Flattening")
      // Remove data-attributes and drupal-specific classes if needed
      mainContent.querySelectorAll('*').forEach(el => {
        el.removeAttribute('data-drupal-selector');
        el.removeAttribute('data-contextual-id');
      });

      const sanitizedHtml = mainContent.innerHTML.trim();

      // 6. Copy to Clipboard
      await navigator.clipboard.writeText(sanitizedHtml);
      
      setStatus('success');
      console.log('✅ HTML Exported and copied to clipboard.');
      
      // Reset after 3 seconds
      setTimeout(() => setStatus('idle'), 3000);

    } catch (err: any) {
      console.error('❌ Export failed:', err);
      setErrorMsg(err.message);
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
