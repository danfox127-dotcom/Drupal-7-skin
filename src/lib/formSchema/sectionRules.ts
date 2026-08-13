import { SectionId } from './types';

/**
 * The rules table that assigns a discovered field to a rail section.
 *
 * ORDERING MATTERS: the first matching rule wins, so specific rules precede
 * general ones.
 *
 * Design note — why labels come first. The reference screenshots of the live forms
 * show field *labels* and help text, but not `name` attributes, so the machine
 * names below are informed guesses while the labels are observed fact. Matching on
 * the label first means a wrong guess about `field_related_conditions` does not
 * misfile a field whose label plainly reads "Related Conditions". Name patterns
 * still run, as a second chance for fields whose labels are unusual.
 *
 * This is also why no rule is anchored to a content type: the same rules serve all
 * thirteen-plus types, and unclaimed fields land in `other` rather than vanishing.
 */

export interface SectionRule {
  id: string;
  section: SectionId;
  /** Matched against the lowercased label. */
  labels?: (string | RegExp)[];
  /** Matched against the lowercased base machine name. */
  names?: (string | RegExp)[];
  /** Matched against the lowercased enclosing fieldset/tab legend. */
  groups?: (string | RegExp)[];
}

/**
 * Legends that identify Drupal's vertical-tab block, i.e. configuration rather than
 * content. Used only by the fallback, to decide where an unclaimed field belongs.
 */
const VERTICAL_TAB_LEGENDS = [
  'meta tag', 'url path', 'url alias', 'xml sitemap', 'revision information',
  'shield settings', 'customize display', 'menu settings', 'comment settings',
  'authoring information', 'publishing options',
];

const matches = (value: string, patterns: (string | RegExp)[] | undefined): boolean => {
  if (!patterns || !value) return false;
  return patterns.some(p =>
    typeof p === 'string' ? value.includes(p) : p.test(value)
  );
};

/**
 * Ordered rules. Read top to bottom; first hit wins.
 */
export const SECTION_RULES: SectionRule[] = [
  /**
   * Framework fields, claimed by NAME before anything else.
   *
   * These must outrank the label rules below. On the live News form the Twitter card
   * meta tag is labelled simply "Title", so `primary.title` claimed it by label and a
   * meta tag was placed in the writing surface next to the real headline. Its name
   * (`metatags[…]`) is unambiguous where its label is not.
   *
   * The same reasoning covers `path`, `xmlsitemap`, `revision` and `log`: their labels
   * are generic, their names are not.
   */
  {
    id: 'seo.byName',
    section: 'seo',
    names: [/^metatags$/, /^path$/, /^xmlsitemap$/],
  },
  {
    id: 'revision.byName',
    section: 'revision',
    names: [/^revision$/, /^log$/],
  },
  {
    id: 'display.byName',
    section: 'display',
    names: [/^shield$/],
  },

  // --- Left column: the writing surface -----------------------------------
  // Exact names, because "title" as a substring appears in menu link title,
  // page title meta tag, and more.
  {
    id: 'primary.title',
    section: 'primary',
    names: [/^title$/],
    labels: [/^title$/],
  },
  {
    id: 'primary.subtitle',
    section: 'primary',
    names: [/subtitle/, /^field_sub_?title/],
    labels: [/^subtitle/],
  },
  {
    id: 'primary.summary',
    section: 'primary',
    names: [/\[summary\]/, /^field_summary/],
    labels: [/^summary$/],
  },
  {
    id: 'primary.body',
    section: 'primary',
    names: [/^body/],
    labels: [/^body$/],
  },

  // --- Vertical-tab blocks, matched by their tab legend --------------------
  // These come before field rules: anything inside the Meta tags or URL path tab
  // belongs to the SEO section regardless of what the individual field is called.
  {
    id: 'seo.verticalTabs',
    section: 'seo',
    groups: [/meta tag/, /url path/, /url alias/, /xml sitemap/, /search engine/],
    labels: [/^page title$/, /^url alias$/, /^generate automatic url alias$/],
  },
  {
    id: 'revision.verticalTab',
    section: 'revision',
    groups: [/revision information/],
    labels: [/^create new revision$/, /^revision log message$/],
  },
  {
    id: 'display.verticalTab',
    section: 'display',
    groups: [/customize display/, /display settings/, /shield settings/],
  },
  {
    id: 'menu.verticalTab',
    section: 'menu',
    groups: [/menu settings/],
  },

  // --- Topics & Tags -------------------------------------------------------
  // "Primary Topic" must precede the general topics rule so both land in the same
  // section, and the label rule catches it even if the machine name differs.
  {
    id: 'topics.primary',
    section: 'topics',
    labels: [/^primary topic/],
    names: [/primary_topic/],
  },
  {
    id: 'topics.terms',
    section: 'topics',
    labels: [/^topics?$/, /^tags?$/, /news topics/],
    names: [/field_topics/, /field_tags/, /_topic/, /taxonomy_vocabulary/],
  },

  // --- Related Content ----------------------------------------------------
  // Four separate autocompletes on the live form, collapsed into one search in the
  // rail. Matched broadly because each is a distinct field.
  {
    id: 'related.entityRefs',
    section: 'related',
    groups: [/related content/],
    /**
     * The entity types differ BY SITE, which is why this list is broad rather than a
     * fixed set of four.
     *
     * columbiadoctors.org has Conditions, Profiles/Providers, Treatments and
     * Specialties; cuimc.columbia.edu has a single "Related Services". Matching the
     * "Related …" prefix plus the bare entity nouns covers both without either site's
     * field list being hardcoded.
     *
     * "Providers" and "Profiles" are the same concept named differently depending on
     * who you ask, so both are here.
     */
    labels: [
      /^related /,
      /^conditions?$/, /^profiles?$/, /^providers?$/, /^treatments?$/,
      /^specialt/, /^services?$/,
    ],
    names: [
      /related_/,
      /field_conditions/, /field_profiles/, /field_providers/,
      /field_treatments/, /field_specialties/, /field_services/,
    ],
  },
  {
    id: 'related.references',
    section: 'related',
    labels: [/^references$/],
    names: [/field_references/],
  },

  // --- Multimedia ---------------------------------------------------------
  {
    id: 'multimedia.images',
    section: 'multimedia',
    groups: [/multimedia/, /^media$/],
    labels: [/teaser image/, /featured image/, /^image$/, /hero image/, /thumbnail/],
    names: [/field_teaser/, /field_featured/, /field_image/, /field_media/, /_image$/],
  },

  // --- Menu placement -----------------------------------------------------
  {
    id: 'menu.fields',
    section: 'menu',
    names: [/^menu\[/, /^menu$/],
    labels: [/^provide a menu link$/, /^menu link title$/, /^parent item$/, /^parent link$/],
  },

  // --- Display template ---------------------------------------------------
  {
    id: 'display.fullPageOverride',
    section: 'display',
    labels: [/full page override/, /display template/, /view mode/],
    // Anchored deliberately. A bare /field_display/ also matched
    // `field_display_date`, filing the News display date under Display Template.
    names: [/full_page/, /^field_display$/, /field_display_(mode|template|override)/, /_template$/, /view_mode/],
  },

  // --- Groups -------------------------------------------------------------
  // Organic Groups. The "Sitewide News" style flag lives here too: the handoff
  // groups the type's group flag with Groups rather than the type fields.
  {
    id: 'groups.og',
    section: 'groups',
    groups: [/^groups$/, /your groups/, /other groups/],
    labels: [/^groups?$/, /your groups/, /other groups/, /sitewide/],
    names: [/^og_/, /group_ref/, /field_sitewide/, /_group$/],
  },

  // --- Type-specific left-column fields -----------------------------------
  // Last, and deliberately broad: anything still unclaimed that looks like a
  // content field belongs in the left column beside the body, not in the rail.
  {
    id: 'typeFields.byline',
    section: 'typeFields',
    labels: [/^byline$/, /^author$/],
    names: [/field_byline/],
  },
  {
    id: 'typeFields.date',
    section: 'typeFields',
    labels: [/display date/, /^date$/, /publish date/],
    names: [/field_display_date/, /field_date/, /_date$/],
  },
  {
    id: 'typeFields.externalSource',
    section: 'typeFields',
    labels: [/external news source/, /external source/, /^publication/],
    names: [/external_source/, /external_news/],
  },
  {
    id: 'typeFields.externalUrl',
    section: 'typeFields',
    labels: [/external url/, /^link$/, /^url$/],
    names: [/external_url/, /field_link/],
  },
  {
    id: 'typeFields.paragraphs',
    section: 'typeFields',
    labels: [/paragraph type/, /add new paragraph/],
    names: [/field_paragraph/, /_paragraphs/],
  },
];

/**
 * Fields that are real but rarely touched, and should not dominate a rail section.
 *
 * These come mostly from menu-attribute and link modules: on the live Page form the rail
 * filled with ID, NAME, RELATIONSHIP, CLASSES, STYLE, TARGET, ACCESS KEY, SECTION STYLE
 * and MODAL NID, each with a paragraph of help text, pushing the fields an editor
 * actually uses off the screen.
 *
 * Marked rather than hidden: they stay reachable behind a disclosure, because "rarely"
 * is not "never" and silently dropping a field an editor needs is worse than a long list.
 */
const ADVANCED_LABEL_PATTERNS: RegExp[] = [
  /^id$/, /^name$/, /^relationship$/, /^rel$/,
  /^class(es)?$/, /^style$/, /^target$/, /^access key$/, /^accesskey$/,
  /^section style$/, /^modal\.? ?nid$/, /^weight/, /^language$/,
  /^expanded$/, /^show as expanded$/, /^description$/,
];

const ADVANCED_NAME_PATTERNS: RegExp[] = [
  /_attributes?$/, /^menu_attributes/, /\[attributes\]/, /_weight$/,
];

/**
 * True when a field belongs behind an "advanced" disclosure rather than inline.
 *
 * Deliberately label-driven like the section rules, since these come from contributed
 * modules whose machine names vary between sites.
 */
export function isAdvancedField(input: { label: string; baseName: string }): boolean {
  const label = input.label.trim().toLowerCase();
  const name = input.baseName.trim().toLowerCase();
  return ADVANCED_LABEL_PATTERNS.some(p => p.test(label))
    || ADVANCED_NAME_PATTERNS.some(p => p.test(name));
}

/**
 * Assigns a section. Returns the section and the rule id that claimed it, so a
 * misfiled field can be traced to a specific rule rather than guessed at.
 */
export function assignSection(input: {
  label: string;
  baseName: string;
  /** Ancestor fieldset/tab legends, nearest first. */
  groupPath: string[];
}): { section: SectionId; matchedBy: string } {
  const label = input.label.trim().toLowerCase();
  const name = input.baseName.trim().toLowerCase();
  const groups = input.groupPath.map(g => g.trim().toLowerCase()).filter(Boolean);

  for (const rule of SECTION_RULES) {
    if (matches(label, rule.labels)) {
      return { section: rule.section, matchedBy: `${rule.id}:label` };
    }
    if (matches(name, rule.names)) {
      return { section: rule.section, matchedBy: `${rule.id}:name` };
    }
    // Any ancestor legend may claim the field, not only the nearest one.
    const hit = groups.find(group => matches(group, rule.groups));
    if (hit) {
      return { section: rule.section, matchedBy: `${rule.id}:group(${hit})` };
    }
  }

  /**
   * Unclaimed fields degrade to a generic grouping, never disappear.
   *
   * Where they land depends on context. A field sitting in one of Drupal's vertical
   * tabs is configuration, so it goes to the `other` rail section. A field on a content
   * tab is content — the live News form has a `field_news_types` select labelled simply
   * "Type" that no rule claims — so it joins the left column beside the body rather
   * than being exiled to a rail section the editor may never open.
   */
  const inVerticalTab = groups.some(group => VERTICAL_TAB_LEGENDS.some(legend => group.includes(legend)));

  return inVerticalTab
    ? { section: 'other', matchedBy: 'fallback:verticalTab' }
    : { section: 'typeFields', matchedBy: 'fallback:contentTab' };
}
