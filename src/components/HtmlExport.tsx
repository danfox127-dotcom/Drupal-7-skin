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
    <div className="p-5 mb-8 bg-gradient-to-br from-slate-50 to-slate-100 border border-slate-200 rounded-2xl flex flex-col gap-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4 text-slate-700">
          <div className={`p-3 rounded-xl transition-colors ${
            status === 'success' ? 'bg-green-100 text-green-600' : 
            status === 'error' ? 'bg-red-100 text-red-600' : 
            'bg-indigo-100 text-indigo-600'
          }`}>
            {status === 'loading' ? <Loader2 size={24} className="animate-spin" /> : 
             status === 'success' ? <Check size={24} /> :
             status === 'error' ? <AlertCircle size={24} /> :
             <FileCode size={24} />}
          </div>
          <div>
            <h3 className="font-extrabold text-slate-900 tracking-tight">Content Extraction Engine</h3>
            <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">
              {status === 'success' ? 'Copied to clipboard!' : 'Export sanitized public HTML'}
            </p>
          </div>
        </div>

        <button 
          disabled={status === 'loading'}
          onClick={handleExport}
          className={`px-6 py-2.5 rounded-xl font-bold text-sm shadow-sm transition-all flex items-center gap-2
            ${status === 'loading' ? 'bg-slate-300 text-slate-500 cursor-not-allowed' : 
              status === 'success' ? 'bg-green-600 text-white hover:bg-green-700' :
              status === 'error' ? 'bg-red-600 text-white hover:bg-red-700' :
              'bg-indigo-600 text-white hover:bg-indigo-700 hover:shadow-indigo-200 active:scale-95'}
          `}
        >
          {status === 'loading' ? 'Processing...' : 
           status === 'success' ? 'Done!' :
           status === 'error' ? 'Retry' :
           'Export Raw HTML'}
        </button>
      </div>

      {status === 'error' && (
        <div className="text-xs text-red-600 bg-red-50 p-2 rounded-lg border border-red-100 italic">
          Error: {errorMsg}
        </div>
      )}
    </div>
  );
};
