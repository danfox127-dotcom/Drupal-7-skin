import { colors } from './src/styles/tokens.js'

/**
 * Columbia identity constraints are encoded here rather than documented, so
 * off-brand utilities simply do not exist:
 *
 *  - borderRadius has no md/lg/xl/2xl/3xl. Large surfaces are 0, inputs / chips /
 *    buttons are 4px (`rounded`). `rounded-full` survives only for toggle knobs.
 *  - boxShadow has only `card` and `modal`. There is no shadow-lg/xl/2xl.
 *  - No gradient utilities: backgroundImage is emptied.
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors,
      fontFamily: {
        // Source Sans 3 substitutes for Proxima Nova; EB Garamond for Garamond
        // Premier Pro; Cinzel for Trajan. Local woff2 files are not bundled yet
        // — see src/styles/fonts.css. Until they are, these stacks resolve to
        // the real faces if the OS or Adobe Fonts provides them, else to a
        // metrically similar fallback.
        sans: ['"Source Sans 3"', '"Source Sans Pro"', '"Proxima Nova"', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Helvetica', 'Arial', 'sans-serif'],
        serif: ['"EB Garamond"', '"Garamond Premier Pro"', 'Garamond', 'Georgia', '"Times New Roman"', 'serif'],
        display: ['Cinzel', '"Trajan Pro"', '"EB Garamond"', 'Georgia', 'serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        // The sizes the handoff actually specifies, named by role so components
        // stop inventing one-off bracket values.
        'title': ['40px', { lineHeight: '1.15' }],
        'heading': ['26px', { lineHeight: '1.2' }],
        'heading-sm': ['24px', { lineHeight: '1.2' }],
        'subtitle': ['21px', { lineHeight: '1.3' }],
        'body-surface': ['18px', { lineHeight: '1.6' }],
        'input': ['15px', { lineHeight: '1.4' }],
        'row-title': ['14.5px', { lineHeight: '1.4' }],
        'section': ['13.5px', { lineHeight: '1.4' }],
        'control': ['13px', { lineHeight: '1.4' }],
        'help': ['12.5px', { lineHeight: '1.45' }],
        'eyebrow': ['11px', { lineHeight: '1.2', letterSpacing: '.1em' }],
        'eyebrow-wide': ['11px', { lineHeight: '1.2', letterSpacing: '.12em' }],
      },
      spacing: {
        // 8-point scale plus the specific values in use.
        '4.5': '18px',
        '5.5': '22px',
        '6.5': '26px',
        '8.5': '34px',
        '11': '44px',
        '15': '60px',
        'rail': '392px',
      },
      transitionTimingFunction: {
        studio: 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
    },

    // --- Overrides that remove off-brand options entirely ---

    borderRadius: {
      none: '0',
      DEFAULT: '4px',
      // Toggle knobs only. Not for buttons — the identity forbids pills.
      full: '9999px',
    },
    boxShadow: {
      none: 'none',
      card: '0 2px 8px rgba(20, 32, 64, .08)',
      modal: '0 12px 40px rgba(20, 32, 64, .18)',
    },
    backgroundImage: {},
    transitionDuration: {
      DEFAULT: '200ms',
      200: '200ms',
      300: '300ms',
      400: '400ms',
    },
  },
  plugins: [],
}
