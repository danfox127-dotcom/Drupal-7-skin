/**
 * Columbia University visual identity tokens — the single source of truth.
 *
 * Plain JS (not TS) so `tailwind.config.js` and the design-token tests can both
 * import it. Components must NOT import this file; they use the Tailwind classes
 * it generates, so the palette can never drift from what ships.
 *
 * Values are from the D7 Studio handoff, which takes them from the Columbia
 * design system. Constraints that ride along with them:
 *   - Max three colors per composition. Grays are structural, not a color.
 *   - No gradients.
 *   - WCAG 2.2 AA is mandatory. See FORBIDDEN_PAIRS below.
 */

/** Columbia blues. */
export const cu = {
  /** Primary Blue — primary actions, links, focus ring. */
  blue: '#1D4F91',
  /** Darker navy — hover state for primary. */
  navy: '#003087',
  /** Columbia Blue — banners, borders. Never a background for white text. */
  light: '#B9D9EB',
  /** Columbia Blue tint — chips, row hover, fills. */
  tint: '#EAF2F9',
  /** Deeper tint. */
  tintDeep: '#DCEBF6',
  /** The only permitted text color on a Columbia Blue field. */
  onLight: '#12365F',
}

/** Structural grays. */
export const canvas = '#E9E9E6'
export const rail = '#FAFAF8'
export const legacy = { 100: '#F5F5F2', 200: '#F2F2EF', 300: '#EDEDEA' }
export const ink = {
  DEFAULT: '#1A1A1A',
  secondary: '#53565A',
  /**
   * The handoff's muted gray. Measures 4.44:1 on white — just under AA for
   * normal text — so it is restricted to icons, borders, and large text, all of
   * which need only 3:1. For small text use `ink.help`.
   */
  muted: '#75787B',
  /**
   * AA-safe muted text. 10% darker than `ink.muted`, clearing 4.5:1 on every
   * background small text sits on (see CONTRAST_PAIRS). Use this for the 11–13px
   * help, caption, and eyebrow text the handoff assigns to #75787B.
   */
  help: '#696C6F',
  /**
   * Placeholder / disabled only — 2.82:1 on white, far below AA. WCAG exempts
   * inactive controls, so this is legitimate for disabled rows and input
   * placeholders, but it must never carry live content. The handoff specifies it
   * for menu-item paths; those use `ink.help` instead, since a path is content.
   */
  placeholder: '#9A9A97',
}
/**
 * Rules and borders.
 *
 * DEFAULT/hair/faint are decorative separators — card edges, row dividers. WCAG
 * 1.4.11 does not apply to them, and at 1.54:1 on white they could not satisfy
 * it anyway; they are not what identifies a component.
 *
 * `control` is different: the border of an input or a button IS the visual
 * information that identifies the control, so 1.4.11's 3:1 does apply. The
 * handoff specifies #D0D0CE there, which fails. This darkened variant clears 3:1
 * on every surface a control sits on while staying a neutral warm gray.
 */
export const rule = {
  DEFAULT: '#D0D0CE',
  hair: '#E6E6E3',
  faint: '#F2F2EF',
  control: '#8B8B8A',
}

/**
 * Status colors. Deliberately only two.
 *
 * `olive` is the ONLY permitted green — #4A8B3A was used in an earlier draft and
 * fails AA. But the handoff's own #76881D measures 3.96:1 on white, which also
 * fails AA for normal text, so it splits by role: the brand value for fills and
 * dots (3:1 suffices), and a darkened `text` variant for status labels.
 */
export const olive = {
  DEFAULT: '#76881D',
  text: '#637218',
}

/** Required / dirty / low confidence. 5.30:1 on white — AA-safe as specified. */
export const burnt = '#B94700'

export const colors = {
  cu,
  canvas,
  rail,
  legacy,
  ink,
  rule,
  olive,
  burnt,
}

/** Every background small text is placed on. */
export const TEXT_BACKGROUNDS = [
  '#FFFFFF',
  rail,
  legacy[100],
  legacy[200],
  legacy[300],
  cu.tint,
]

/**
 * Foreground/background pairs this UI actually renders, asserted against WCAG
 * 2.2 AA for normal text (4.5:1) by tests/design-tokens.spec.ts. Add a row here
 * whenever a new combination ships.
 */
export const CONTRAST_PAIRS = [
  [ink.DEFAULT, '#FFFFFF', 'body text on white'],
  [ink.secondary, '#FFFFFF', 'secondary text on white'],
  [ink.help, '#FFFFFF', 'help text on white'],
  [cu.blue, '#FFFFFF', 'link / primary text on white'],
  [burnt, '#FFFFFF', 'required marker on white'],
  [ink.DEFAULT, canvas, 'body text on canvas'],
  [ink.DEFAULT, rail, 'body text on rail'],
  [ink.secondary, rail, 'secondary text on rail'],
  [ink.help, rail, 'help text on rail'],
  [ink.DEFAULT, legacy[100], 'body text on legacy surface'],
  [ink.secondary, legacy[200], 'secondary text on legacy surface'],
  [ink.help, legacy[300], 'help text on deepest legacy surface'],
  [cu.blue, cu.tint, 'chip text on tint'],
  [cu.onLight, cu.light, 'text on Columbia Blue'],
  [cu.onLight, cu.tint, 'deep blue text on tint'],
  [ink.DEFAULT, cu.light, 'ink on Columbia Blue banner'],
  ['#FFFFFF', cu.blue, 'white on Primary Blue'],
  ['#FFFFFF', cu.navy, 'white on navy hover'],
  ['#FFFFFF', ink.DEFAULT, 'white on toast'],
  [olive.text, '#FFFFFF', 'published status on white'],
  [olive.text, rail, 'enabled status on rail'],
  [burnt, rail, 'dirty count on rail'],
  [burnt, legacy[100], 'low confidence on legacy surface'],
  [cu.light, cu.blue, 'muted header text on Primary Blue'],
]

/**
 * Pairs used only for icons, borders, dots, and fills — non-text UI components,
 * which WCAG 1.4.11 holds to 3:1 rather than 4.5:1. These are the handoff's
 * original values, kept at brand strength where AA permits it.
 */
export const NON_TEXT_PAIRS = [
  [ink.muted, '#FFFFFF', 'muted icon on white'],
  [ink.muted, rail, 'muted icon on rail'],
  [olive.DEFAULT, '#FFFFFF', 'enabled toggle fill on white'],
  [olive.DEFAULT, rail, 'enabled toggle fill on rail'],
  [rule.control, '#FFFFFF', 'control border on white'],
  [rule.control, legacy[100], 'control border on legacy surface'],
  [cu.blue, '#FFFFFF', 'focus ring on white'],
]

/**
 * Decorative separators, exempt from 1.4.11 because they do not identify a
 * component or its state. Asserted to be BELOW 3:1 so that nobody "fixes" them
 * into control borders by accident — if a rule needs to identify a control, the
 * correct token is `rule.control`.
 */
export const DECORATIVE_PAIRS = [
  [rule.DEFAULT, '#FFFFFF', 'card edge on white'],
  [rule.hair, '#FFFFFF', 'hairline on white'],
]

/**
 * Combinations the identity forbids outright. The test asserts these really do
 * fail AA, so the rule is enforced by measurement rather than by comment.
 */
export const FORBIDDEN_PAIRS = [
  ['#FFFFFF', cu.light, 'white text on Columbia Blue'],
  ['#4A8B3A', '#FFFFFF', 'the rejected earlier-draft green'],
  // Documented here so the reason these tokens were split by role cannot be
  // lost: the handoff assigns both to small text, and both fail AA there.
  ['#75787B', '#FFFFFF', "the handoff's muted gray as small text"],
  ['#76881D', '#FFFFFF', "the handoff's olive as small text"],
]
