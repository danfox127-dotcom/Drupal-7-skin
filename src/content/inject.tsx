import React from 'react';
import ReactDOM from 'react-dom/client';
import stylesheet from '../styles/main.css?inline';

export function injectComponent(
  targetElement: HTMLElement,
  component: React.ReactNode,
  position: 'before' | 'after' | 'replace' = 'before'
) {
  const container = document.createElement('div');
  container.id = 'd7-proxy-ui-container';

  if (position === 'before') {
    targetElement.parentNode?.insertBefore(container, targetElement);
  } else if (position === 'after') {
    targetElement.parentNode?.insertBefore(container, targetElement.nextSibling);
  } else {
    targetElement.parentNode?.replaceChild(container, targetElement);
  }

  const shadow = container.attachShadow({ mode: 'open' });
  
  // Inject tailwind styles into shadow root
  const style = document.createElement('style');
  style.textContent = stylesheet;
  shadow.appendChild(style);

  // Root element for React
  const rootElement = document.createElement('div');
  shadow.appendChild(rootElement);

  const root = ReactDOM.createRoot(rootElement);
  root.render(<React.StrictMode>{component}</React.StrictMode>);
  
  return root;
}
