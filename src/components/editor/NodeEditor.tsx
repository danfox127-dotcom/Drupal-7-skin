import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { ChevronUp, ChevronDown, AlertCircle } from 'lucide-react';
import {
  FormSchema, FieldDescriptor, SectionId,
} from '../../lib/formSchema';
import { readAll, writeAll, submitForm, syncRichEditorsToDom, readValue } from '../../lib/fieldBinding';
import {
  Draft, ConflictState, draftKey, readChangedStamp, loadDraft, saveDraft,
  clearDraft, assessDraft, formatAge,
} from '../../lib/autosave';
import { readFormErrors, hasErrors, FormErrors } from '../../lib/validationErrors';
import { FieldControl, SlottedFieldsContext, EMPTY_SLOTTED } from './FieldControl';
import { PrimaryField, primaryRole } from './PrimaryField';
import { TopicsSection } from './TopicsSection';
import { MenuSection, menuSummary } from './MenuSection';
import { SearchSocialSection, searchSummary } from './SearchSocialSection';
import { HelpAsTipContext } from './InfoTip';
import { displayLabelFor } from '../../lib/formSchema/displayLabels';
import { Toast } from '../Toast';

/**
 * The two-pane node editor overlay — screen 1, the handoff's lead direction.
 *
 * Replaces the five-tab form: writing on the left, everything else in a persistent
 * right rail. Every control writes to the native input beneath it, and Drupal's own
 * submit performs the save; nothing is written to Drupal implicitly.
 */

interface Props {
  schema: FormSchema;
  /** machineNames whose native widget was relocated and is projected via a slot. */
  slottedFields?: Set<string>;
}

/** Rail section titles and the plain-language note of what each replaced. */
const SECTION_META: Record<SectionId, { title: string; replaced?: string }> = {
  primary: { title: 'Content' },
  typeFields: { title: 'Details' },
  topics: { title: 'Topics', replaced: 'the checkbox list and the separate Primary Topic select' },
  related: { title: 'Related Content', replaced: 'the Related Content and Groups tabs, where each field needed an exact title' },
  multimedia: { title: 'Multimedia', replaced: 'the Multimedia tab' },
  menu: { title: 'Menu Placement', replaced: 'the Menu settings vertical tab' },
  display: { title: 'Display template', replaced: 'a select buried in a vertical tab' },
  search: { title: 'Search & Social', replaced: 'two fields buried in the Meta tags tab' },
  seo: { title: 'URL, SEO & Sitemap', replaced: 'the Meta tags, URL path and XML sitemap tabs' },
  groups: { title: 'Groups', replaced: 'the Groups tab' },
  revision: { title: 'Revision', replaced: 'the Revision information tab' },
  other: { title: 'Other Fields' },
};

/**
 * Sections rendered in the LEFT column, under the writing surface.
 *
 * Multimedia is here rather than in the rail because the teaser and hero images are part
 * of the thing being written, not a setting about it — and because "I'm not seeing an
 * option to change the image" was reported twice while it sat behind a rail toggle. A
 * collapsed section renders no `<slot>`, so a relocated Media widget inside one is not
 * merely small, it is absent from the page until clicked.
 */
const LEFT_ORDER: SectionId[] = ['multimedia'];

/**
 * Rail sections reached on most saves, listed openly.
 *
 * 'search' leads, and opens by default: the meta description was previously ten fields
 * deep inside a collapsed URL/SEO/Sitemap block, which is no place for the sentence that
 * appears under every Google result.
 */
const RAIL_PRIMARY: SectionId[] = ['search', 'topics', 'related', 'menu'];

/**
 * Rail sections for the occasional save, listed flat inside one "More settings" panel.
 *
 * Ten stacked headers make the rail a wall to be scanned every time, and the ones that
 * matter get no more weight than Revision. These are grouped rather than removed — one
 * extra click for a display template — and anything holding a validation error forces the
 * panel open so a rejected save is never hidden. URL, SEO & Sitemap used to be here too;
 * it now folds into Search & Social, where the URL and sitemap are what a search result
 * is made of.
 *
 * Menu Placement is deliberately NOT here. It is the section with the most machinery
 * behind it — a filterable parent picker over a menu thousands of items deep — and on the
 * Page type it is touched on most saves, so a disclosure in front of it costs more than it
 * saves.
 */
const RAIL_SECONDARY: SectionId[] = ['display', 'revision', 'other'];

/**
 * Sections folded into another section's panel instead of getting their own.
 *
 * Groups is one audience autocomplete plus a "Sitewide News" flag — both cross-references
 * like everything else in Related Content, and not enough to earn a header of its own.
 */
const MERGED_INTO: Partial<Record<SectionId, SectionId>> = {
  groups: 'related',
  seo: 'search',
};

const panelOf = (section: SectionId): SectionId => MERGED_INTO[section] ?? section;

/**
 * The one panel open when the page loads, before any remembered choice.
 *
 * Search & Social, so the description is on screen without a click — it was reported
 * as buried when it sat ten fields deep. Page is the exception, as designed: a Page is
 * placed in the menu on most saves, so Menu Placement opens instead. Only Page, not every
 * type with a menu: Specialty and the rest are edited far more often than they are moved.
 */
const defaultPanel = (panels: SectionId[], contentType: string | null): string =>
  (contentType === 'page' && panels.includes('menu') ? 'menu' : 'search');

/**
 * Remembered open panel, per content type. Versioned because the rail used to allow
 * several open at once, and a stored map from then would reopen all of them.
 */
const SECTION_STATE_KEY = 'railSections:v2';

/**
 * Opens every rail panel at once, overriding one-at-a-time until the next header click.
 *
 * One-at-a-time is the right behaviour for a person and the wrong one for anything that
 * must see every field together: the debug slot check (which verifies every relocated
 * widget has a <slot> once everything is open) and the extension tests. Clicking each
 * header in turn would leave only the last one open, so they dispatch this instead.
 */
export const EXPAND_RAIL_EVENT = 'd7-studio:expand-rail';

/** Open/closed key for the secondary rail group. Not a SectionId, so it cannot collide. */
const MORE_KEY = '__more';

const countOf = (fields: FieldDescriptor[]) =>
  `${fields.length} field${fields.length === 1 ? '' : 's'}`;

/** How many related items are filled in, across every related field and delta. */
const linkedCount = (fields: FieldDescriptor[]) =>
  fields.reduce((n, field) => {
    const value = readValue(field);
    if (Array.isArray(value)) return n + value.length;
    return n + (typeof value === 'string' && value.trim() ? 1 : 0);
  }, 0);

/**
 * "Sitewide News on", "Group off", plus a count of audience groups when there are any.
 *
 * The flag's own label is used because it differs per type and per site; there is no
 * general name for it.
 */
const groupsSummary = (fields: FieldDescriptor[]) => {
  const parts: string[] = [];
  for (const flag of fields.filter(f => f.kind === 'checkbox')) {
    parts.push(`${displayLabelFor(flag)} ${readValue(flag) === true ? 'on' : 'off'}`);
  }
  const audience = linkedCount(fields.filter(f => f.kind !== 'checkbox'));
  if (audience) parts.push(`${audience} group${audience === 1 ? '' : 's'}`);
  return parts.join(', ');
};

/**
 * A rail section's fields, with the rarely-used ones behind a disclosure.
 *
 * On the live Page form the Menu Placement section filled with ID, NAME, RELATIONSHIP,
 * CLASSES, STYLE, TARGET, ACCESS KEY, SECTION STYLE and MODAL NID — each with a paragraph
 * of help text — which pushed the fields an editor actually uses off the screen.
 *
 * They are collapsed, not removed: a field an editor occasionally needs must still be
 * reachable, and a section that silently omits fields is worse than a long one. Anything
 * carrying a validation error is forced open, so a rejected save is never hidden.
 */
function SectionFields({
  fields, section, errorFor, slottedFields, onChange,
}: {
  fields: FieldDescriptor[];
  section: SectionId;
  errorFor: (field: FieldDescriptor) => string | null;
  slottedFields?: Set<string>;
  onChange?: () => void;
}) {
  const common = fields.filter(f => !f.advanced);
  const advanced = fields.filter(f => f.advanced);
  const advancedHasError = advanced.some(f => errorFor(f));
  const [showAdvanced, setShowAdvanced] = useState(false);

  const render = (field: FieldDescriptor) => (
    <FieldControl
      key={field.machineName}
      field={field}
      dense
      error={errorFor(field)}
      slotted={slottedFields?.has(field.machineName)}
      onChange={onChange}
    />
  );

  return (
    <div className="flex flex-col gap-3">
      {common.map(render)}

      {advanced.length > 0 && (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setShowAdvanced(v => !v)}
            aria-expanded={showAdvanced || advancedHasError}
            className="self-start flex items-center gap-1.5 text-help font-semibold text-cu-blue hover:underline"
          >
            {showAdvanced || advancedHasError ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {showAdvanced || advancedHasError
              ? `Hide ${advanced.length} rarely-used field${advanced.length === 1 ? '' : 's'}`
              : `Show ${advanced.length} rarely-used field${advanced.length === 1 ? '' : 's'}`}
            {advancedHasError && (
              <span className="text-burnt">· needs attention</span>
            )}
          </button>

          {(showAdvanced || advancedHasError) && (
            <div
              data-advanced-fields={section}
              className="flex flex-col gap-3 pl-2 border-l-2 border-rule"
            >
              {advanced.map(render)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const NodeEditor = ({ schema, slottedFields }: Props) => {
  const key = useMemo(() => draftKey(window.location), []);
  const baseChanged = useMemo(() => readChangedStamp(schema.form), [schema.form]);

  /**
   * The one rail panel the editor opened: undefined until chosen (the type's default
   * applies), null once they close it. Panels holding a validation error are `forced`
   * open on top of it, and EXPAND_RAIL_EVENT opens everything.
   */
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  const [forced, setForced] = useState<ReadonlySet<string>>(() => new Set());
  const [expandAll, setExpandAll] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [conflict, setConflict] = useState<ConflictState>({ kind: 'none' });
  const [errors, setErrors] = useState<FormErrors | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const dirtyRef = useRef(false);

  /**
   * Where the sticky rail starts: under the action bar, which is itself sticky at 44px
   * and wraps to two lines when the draft banners or a long status line need it.
   */
  const barRef = useRef<HTMLDivElement>(null);
  const [railTop, setRailTop] = useState(105);
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const measure = () => setRailTop(44 + bar.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  const fieldsBySection = useMemo(() => {
    const map = new Map<SectionId, FieldDescriptor[]>();
    for (const field of schema.fields) {
      const list = map.get(field.section) ?? [];
      list.push(field);
      map.set(field.section, list);
    }
    return map;
  }, [schema.fields]);

  /**
   * A panel's fields, its own plus any section folded into it.
   *
   * Folding at the presentation layer only: a Groups field is still `section: 'groups'` in
   * the schema, so `matchedBy` and the debug dump keep telling the truth about which rule
   * claimed it. Only where it is drawn changed.
   */
  const panelFields = useCallback((panel: SectionId): FieldDescriptor[] => {
    const folded = (Object.keys(MERGED_INTO) as SectionId[])
      .filter(from => MERGED_INTO[from] === panel)
      .flatMap(from => fieldsBySection.get(from) ?? []);
    return [...(fieldsBySection.get(panel) ?? []), ...folded];
  }, [fieldsBySection]);

  const leftSections = useMemo(
    () => LEFT_ORDER.filter(s => (fieldsBySection.get(s) ?? []).length > 0),
    [fieldsBySection]
  );
  const primaryPanels = useMemo(
    () => RAIL_PRIMARY.filter(s => panelFields(s).length > 0),
    [panelFields]
  );
  const secondaryPanels = useMemo(
    () => RAIL_SECONDARY.filter(s => panelFields(s).length > 0),
    [panelFields]
  );

  // --- Validation errors from the previous submit -------------------------
  useEffect(() => {
    const found = readFormErrors(schema.fields);
    if (!hasErrors(found)) return;

    setErrors(found);
    // Auto-open the offending sections: the native fields are hidden, so a rejected
    // save would otherwise point at something invisible. Through panelOf, or an error on
    // a Groups field would open a panel that no longer exists while Related Content —
    // where the field is actually drawn — stayed shut. Several may open at once: an
    // error outranks one-panel-at-a-time.
    setForced(new Set(found.sections.map(section =>
      RAIL_SECONDARY.includes(panelOf(section)) ? MORE_KEY : panelOf(section))));
  }, [schema.fields]);

  // --- Which panel is open, remembered per content type -------------------
  const storeKey = `${SECTION_STATE_KEY}:${schema.contentType ?? 'unknown'}`;
  useEffect(() => {
    // By key, not with a defaults object: `{ [key]: undefined }` serializes to `{}`, which
    // asks for nothing and would never return the remembered panel.
    chrome.storage.local.get(storeKey, result => {
      const stored = result[storeKey];
      // Only if nothing was clicked while storage was being read.
      if (stored === null || typeof stored === 'string') {
        setChosen(prev => (prev === undefined ? stored : prev));
      }
    });
  }, [storeKey]);

  useEffect(() => {
    const expand = () => setExpandAll(true);
    document.addEventListener(EXPAND_RAIL_EVENT, expand);
    return () => document.removeEventListener(EXPAND_RAIL_EVENT, expand);
  }, []);

  /**
   * Re-renders on any change to the form, so the one-line panel summaries stay current.
   *
   * Several controls write to Drupal's inputs without going through this component —
   * the topic picker, the menu picker, a relocated native widget — and each of those
   * dispatches a bubbling change event, which is the one signal they all share.
   */
  const [, setFormTick] = useState(0);
  useEffect(() => {
    let queued = 0;
    const onEdit = () => {
      if (queued) return;
      queued = requestAnimationFrame(() => { queued = 0; setFormTick(t => t + 1); });
    };
    schema.form.addEventListener('input', onEdit);
    schema.form.addEventListener('change', onEdit);
    return () => {
      schema.form.removeEventListener('input', onEdit);
      schema.form.removeEventListener('change', onEdit);
      if (queued) cancelAnimationFrame(queued);
    };
  }, [schema.form]);

  // --- Draft assessment on mount; nothing is applied automatically -------
  useEffect(() => {
    void (async () => {
      const draft = await loadDraft(key);
      setConflict(assessDraft(draft, baseChanged));
    })();
  }, [key, baseChanged]);

  // --- Autosave, local only ---------------------------------------------
  /**
   * Last persisted snapshot, so the beat can detect changes made in a NATIVE widget.
   *
   * `dirtyRef` only trips when one of this overlay's own React controls fires onChange.
   * Drupal's relocated editor is not one of those, so typing a whole body produced no
   * dirty flag and the draft was never written. Comparing snapshots catches edits from
   * either side; null means "no baseline yet", which avoids writing a phantom draft
   * identical to the form as loaded.
   */
  const lastSnapshot = useRef<string | null>(null);

  const persist = useCallback(async () => {
    // Rich editors keep their content to themselves until submit; make the DOM current
    // before reading it, or the draft records an empty body.
    await syncRichEditorsToDom();

    const values = readAll(schema.fields);
    const snapshot = JSON.stringify(values);

    if (lastSnapshot.current === null) {
      lastSnapshot.current = snapshot;
      return;
    }
    if (snapshot === lastSnapshot.current) return;
    lastSnapshot.current = snapshot;

    const draft: Draft = {
      values,
      savedAt: Date.now(),
      baseChanged,
      contentType: schema.contentType,
      sourceUrl: window.location.href,
    };
    await saveDraft(key, draft);
    setSavedAt(draft.savedAt);
  }, [key, baseChanged, schema.fields, schema.contentType]);

  const handleFieldChange = useCallback(() => {
    dirtyRef.current = true;
  }, []);

  useEffect(() => {
    // The handoff specifies the status text refreshes every 5s; the draft is written
    // on the same beat, but only when something actually changed.
    const id = window.setInterval(() => {
      setNow(Date.now());
      // Unconditional now: persist() is a no-op when nothing changed, and gating on
      // dirtyRef alone missed every edit made in a relocated native editor.
      dirtyRef.current = false;
      void persist();
    }, 5000);
    return () => window.clearInterval(id);
  }, [persist]);

  const restoreDraft = useCallback((draft: Draft) => {
    const failed = writeAll(schema.fields, draft.values);
    setConflict({ kind: 'none' });
    setToast(failed.length === 0
      ? 'Draft restored into the form. Nothing has been sent to Drupal.'
      : `Draft restored, but ${failed.length} field${failed.length === 1 ? '' : 's'} could not be applied: ${failed.join(', ')}.`);
  }, [schema.fields]);

  const discardDraft = useCallback(() => {
    void clearDraft(key);
    setConflict({ kind: 'none' });
    setToast('Local draft discarded.');
  }, [key]);

  const save = useCallback((publish: boolean) => {
    const ok = submitForm(schema.form, { publish });
    if (!ok) setToast('Could not find the form’s save button, so nothing was submitted.');
  }, [schema.form]);

  // --- Completion hint ---------------------------------------------------
  const missingRequired = useMemo(
    () => schema.fields.filter(f => {
      if (!f.required) return false;
      const el = f.elements[0] as HTMLInputElement | undefined;
      return !el?.value;
    }),
    [schema.fields]
  );

  const errorFor = useCallback((field: FieldDescriptor): string | null => {
    const hit = errors?.fieldErrors.find(e => e.field === field);
    if (!hit) return null;
    return hit.message ?? 'Drupal rejected this field.';
  }, [errors]);

  const left = fieldsBySection.get('primary') ?? [];
  const typeFields = fieldsBySection.get('typeFields') ?? [];

  /**
   * Hands out each primary role once, in document order, so the first field labelled
   * "Summary" is the summary and any later one falls through to a normal control.
   * Rebuilt per render deliberately: it must not carry state between renders.
   */
  const claimedRoles = new Set<string>();
  const claimPrimaryRole = (field: FieldDescriptor) => {
    const role = primaryRole(field);
    if (!role || claimedRoles.has(role)) return null;
    claimedRoles.add(role);
    return role;
  };

  const effectiveChosen = chosen === undefined ? defaultPanel(primaryPanels, schema.contentType) : chosen;
  const isPanelOpen = (key: string) => expandAll || forced.has(key) || effectiveChosen === key;

  /** Opens one panel and closes the rest; clicking the open one closes it. */
  const toggleSection = (key: string) => {
    const wasOpen = isPanelOpen(key);
    setExpandAll(false);
    setForced(prev => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    const next = wasOpen ? null : key;
    setChosen(next);
    chrome.storage.local.set({ [storeKey]: next });
  };

  const nodeTitleField = left.find(f => primaryRole(f) === 'title');
  const summaryField = left.find(f => primaryRole(f) === 'summary');

  /**
   * The one-line state shown at the right of a panel header.
   *
   * The header used to carry a field count and a note of what the panel replaced — true,
   * but nothing an editor needs on the hundredth save. What they need is the answer the
   * panel holds: which parent, how many topics, whether a description is set.
   */
  const panelSummary = (section: SectionId): string => {
    const own = fieldsBySection.get(section) ?? [];
    switch (section) {
      case 'search':
        return searchSummary(own) || countOf(panelFields(section));
      case 'topics': {
        const topics = own.find(f => f.kind === 'checkboxGroup');
        if (!topics) return countOf(own);
        const n = (readValue(topics) as string[]).length;
        return n ? `${n} selected` : 'None';
      }
      case 'related': {
        const parts: string[] = [];
        if (own.length) parts.push(`${linkedCount(own)} linked`);
        const group = groupsSummary(fieldsBySection.get('groups') ?? []);
        if (group) parts.push(group);
        return parts.join(' · ');
      }
      case 'menu': {
        const parent = own.find(f => /parent/i.test(f.label));
        return menuSummary(parent, own.filter(f => f !== parent)) || countOf(own);
      }
      default:
        return countOf(panelFields(section));
    }
  };

  const renderFields = (fields: FieldDescriptor[], section: SectionId) => (
    <SectionFields
      fields={fields}
      section={section}
      errorFor={errorFor}
      slottedFields={slottedFields}
      onChange={handleFieldChange}
    />
  );

  /** One rail header row: name, current value on the right, chevron. */
  const railHeader = (key: string, title: string, summary: string, hasError: boolean) => {
    const isOpen = isPanelOpen(key);
    return (
      <button
        type="button"
        onClick={() => toggleSection(key)}
        aria-expanded={isOpen}
        data-rail-toggle={key}
        className="w-full flex items-center gap-2.5 px-4.5 py-2.5 text-left hover:bg-legacy-200 transition-colors duration-200 ease-studio"
      >
        <span className="shrink-0 text-section font-semibold text-ink">{title}</span>
        {hasError && (
          <span className="shrink-0 text-help font-semibold text-burnt">needs attention</span>
        )}
        <span data-panel-summary className="flex-1 min-w-0 text-right truncate text-help text-ink-help">
          {summary}
        </span>
        {isOpen
          ? <ChevronUp size={14} className="text-ink-muted shrink-0" aria-hidden />
          : <ChevronDown size={14} className="text-ink-muted shrink-0" aria-hidden />}
      </button>
    );
  };

  /** One collapsible rail panel: a one-line header, and its fields when open. */
  const renderPanel = (section: SectionId) => {
    const fields = panelFields(section);
    const meta = SECTION_META[section];
    const isOpen = isPanelOpen(section);
    const sectionHasError = Boolean(errors?.fieldErrors.some(e => panelOf(e.field.section) === section));

    return (
      <div key={section} data-rail-panel={section} className="border-b border-rule-hair">
        {railHeader(section, meta.title, panelSummary(section), sectionHasError)}

        {isOpen && (
          <div className="px-4.5 pb-4">
            {section === 'topics' && fields.some(f => f.kind === 'checkboxGroup')
              ? (() => {
                  const topics = fields.find(f => f.kind === 'checkboxGroup')!;
                  const primary = fields.find(f => f.kind === 'select');
                  const others = fields.filter(f => f !== topics && f !== primary);
                  return <TopicsSection topics={topics} primary={primary} others={others} errorFor={errorFor} />;
                })()
              : section === 'menu'
                ? (() => {
                    const parent = fields.find(f => /parent/i.test(f.label));
                    const others = fields.filter(f => f !== parent);
                    /**
                     * The node's title comes from the PRIMARY section, not from the whole
                     * schema.
                     *
                     * Several fields on these forms carry the label "Title" — the metatag
                     * title, the Twitter card title, and menu[options][attributes][title],
                     * which Drupal labels "Title" and we display as "Link tooltip". Display
                     * labels disambiguate them for the reader, but field.label is still
                     * "Title" on all of them, so searching every field for that label can
                     * land on an empty metatag field and silently write nothing.
                     *
                     * The primary section is where the node's own title lives, and it is the
                     * same field PrimaryField renders in the title role.
                     */
                    const nodeTitle = left.find(f => primaryRole(f) === 'title');
                    return (
                      <MenuSection
                        parent={parent}
                        others={others}
                        nodeTitle={nodeTitle}
                        errorFor={errorFor}
                      />
                    );
                  })()
                : section === 'related'
                  ? renderRelated()
                  : section === 'search'
                    ? (
                      <SearchSocialSection
                        search={fieldsBySection.get('search') ?? []}
                        seo={fieldsBySection.get('seo') ?? []}
                        nodeTitle={nodeTitleField}
                        summary={summaryField}
                        errorFor={errorFor}
                        renderFields={renderFields}
                      />
                    )
                    : renderFields(fields, section)}
          </div>
        )}
      </div>
    );
  };

  /**
   * Related Content, with the folded-in Groups fields as their own sub-disclosure.
   *
   * Separate rather than silently mixed in: an Organic Groups audience is a different
   * kind of thing from "Related Treatments", and an editor who was told to "set the
   * group" needs to recognise it. Groups starts shut — it is set once, when a page is
   * created — and Linked items open. With only one of the two present, there is nothing
   * to choose between and its fields are listed directly.
   */
  const [linkedOpen, setLinkedOpen] = useState(true);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const renderRelated = () => {
    const own = fieldsBySection.get('related') ?? [];
    const groups = fieldsBySection.get('groups') ?? [];
    if (own.length === 0 || groups.length === 0) {
      return renderFields(own.length ? own : groups, own.length ? 'related' : 'groups');
    }

    const hasError = (fields: FieldDescriptor[]) => fields.some(f => errorFor(f));
    const sub = (
      name: string, summary: string, open: boolean, toggle: () => void,
      fields: FieldDescriptor[], section: SectionId
    ) => {
      const shown = open || hasError(fields);
      return (
        <div data-panel-subgroup={section} className="flex flex-col border-t border-rule-hair first:border-t-0">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={shown}
            className="w-full flex items-center gap-2 py-2 text-left"
          >
            <span className="shrink-0 text-eyebrow font-semibold uppercase text-ink-secondary">{name}</span>
            {hasError(fields) && <span className="shrink-0 text-help font-semibold text-burnt">needs attention</span>}
            <span className="flex-1 min-w-0 text-right truncate text-help text-ink-help">{summary}</span>
            {shown
              ? <ChevronUp size={12} className="text-ink-muted shrink-0" aria-hidden />
              : <ChevronDown size={12} className="text-ink-muted shrink-0" aria-hidden />}
          </button>
          {shown && <div className="pb-3">{renderFields(fields, section)}</div>}
        </div>
      );
    };

    return (
      <div className="flex flex-col">
        {sub('Linked items', `${linkedCount(own)} linked`, linkedOpen, () => setLinkedOpen(v => !v), own, 'related')}
        {sub(SECTION_META.groups.title, groupsSummary(groups), groupsOpen, () => setGroupsOpen(v => !v), groups, 'groups')}
      </div>
    );
  };

  const moreHasError = Boolean(errors?.fieldErrors.some(
    e => secondaryPanels.includes(panelOf(e.field.section))
  ));

  return (
    <SlottedFieldsContext.Provider value={slottedFields ?? EMPTY_SLOTTED}>
    <div className="bg-canvas font-sans">
      {/* Sticky action bar */}
      <div ref={barRef} className="sticky top-11 z-40 bg-white border-b border-rule px-4.5 py-3 flex items-center gap-4 flex-wrap">
        <span className="px-2 h-[22px] inline-flex items-center bg-cu-blue text-white font-semibold text-eyebrow uppercase">
          {schema.contentType ?? 'node'}
        </span>

        <span className="text-help text-ink-help">
          Fields read from {window.location.pathname}
        </span>

        <span className="flex items-center gap-1.5 text-help text-ink-help">
          <span
            className={`w-[7px] h-[7px] rounded-full ${savedAt ? 'bg-olive' : 'bg-rule'}`}
            aria-hidden="true"
          />
          {savedAt
            ? `Draft autosaved in the extension · ${formatAge(savedAt, now)}`
            : 'No local draft yet'}
        </span>

        <div className="flex-1" />

        <span className="text-help text-ink-help">
          {missingRequired.length === 0
            ? 'All required fields filled'
            : `${missingRequired.map(f => f.label).join(' and ')} still needed`}
        </span>

        <button
          type="button"
          onClick={() => save(false)}
          className="px-3 py-1.5 bg-white border border-cu-blue text-cu-blue rounded text-control font-semibold hover:bg-cu-tint transition-colors duration-200 ease-studio"
        >
          Save draft to Drupal
        </button>
        <button
          type="button"
          onClick={() => save(true)}
          className="px-4 py-1.5 bg-cu-blue hover:bg-cu-navy text-white rounded text-control font-semibold transition-colors duration-200 ease-studio"
        >
          Publish
        </button>
      </div>

      {/* Stale-draft banner. Nothing is applied until the editor chooses. */}
      {conflict.kind === 'stale' && (
        <div className="mx-4.5 mt-3 p-3 bg-cu-light border border-cu-blue flex items-start gap-3">
          <AlertCircle size={16} className="text-cu-onLight mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-eyebrow font-semibold uppercase text-cu-onLight">Draft conflict</p>
            <p className="text-control text-ink mt-0.5">
              This page was saved in Drupal after your local draft was taken, so the draft is
              out of date. Nothing has been applied.
            </p>
            <div className="flex gap-2 mt-2">
              <button
                type="button"
                onClick={() => restoreDraft(conflict.draft)}
                className="px-3 py-1 bg-white border border-cu-blue text-cu-blue rounded text-help font-semibold hover:bg-cu-tint transition-colors duration-200 ease-studio"
              >
                Use my draft anyway
              </button>
              <button
                type="button"
                onClick={discardDraft}
                className="px-3 py-1 bg-white border border-rule-control text-ink rounded text-help font-semibold hover:bg-legacy-200 transition-colors duration-200 ease-studio"
              >
                Discard my draft
              </button>
            </div>
          </div>
        </div>
      )}

      {conflict.kind === 'restorable' && (
        <div className="mx-4.5 mt-3 p-3 bg-cu-tint border border-cu-light flex items-center gap-3">
          <p className="flex-1 text-control text-ink">
            A local draft from {formatAge(conflict.draft.savedAt, now)} is available.
          </p>
          <button
            type="button"
            onClick={() => restoreDraft(conflict.draft)}
            className="px-3 py-1 bg-white border border-cu-blue text-cu-blue rounded text-help font-semibold hover:bg-cu-tint transition-colors duration-200 ease-studio"
          >
            Restore it
          </button>
          <button
            type="button"
            onClick={discardDraft}
            className="px-3 py-1 bg-white border border-rule-control text-ink rounded text-help font-semibold transition-colors duration-200 ease-studio"
          >
            Discard
          </button>
        </div>
      )}

      {/* Messages Drupal rendered that no field claimed. */}
      {errors && errors.unattributed.length > 0 && (
        <div className="mx-4.5 mt-3 p-3 bg-white border border-burnt">
          <p className="text-eyebrow font-semibold uppercase text-burnt">Drupal rejected this save</p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {errors.unattributed.map((message, i) => (
              <li key={i} className="text-control text-ink">{message}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Two-pane body */}
      {/* 451px, up from 392px. The rail holds Drupal's own relocated widgets — an
          autocomplete row, a media browser launcher, a parent picker with indented
          hierarchy — none of which were designed for a narrow column. */}
      <div className="grid items-start" style={{ gridTemplateColumns: '1fr 451px' }}>
        {/* pt-15 clears the sticky action bar, which would otherwise overlap the
            title — the bar is position:sticky, so it does not reserve space. */}
        <div className="flex flex-col gap-6.5 px-11 pt-15 pb-15 border-r border-rule bg-white">
          {left.map(field => {
            /**
             * A primary role is claimed at most once.
             *
             * The roles are matched on label alone, and a Specialty form carries TWO
             * fields labelled "Summary". Both were given the summary treatment, so the
             * editor showed two boxes each captioned "Doubles as the meta description"
             * with their own 380-character budget — and only one field can be the meta
             * description. The second now renders as an ordinary labelled field, which
             * is accurate about what it is.
             */
            const role = claimPrimaryRole(field);
            return role ? (
              <PrimaryField
                key={field.machineName}
                field={field}
                role={role}
                error={errorFor(field)}
                onChange={handleFieldChange}
              />
            ) : (
              <FieldControl key={field.machineName} field={field} error={errorFor(field)} slotted={slottedFields?.has(field.machineName)} onChange={handleFieldChange} />
            );
          })}

          {typeFields.length > 0 && (
            <div className="grid grid-cols-2 gap-4">
              {typeFields.map(field => (
                <FieldControl key={field.machineName} field={field} error={errorFor(field)} slotted={slottedFields?.has(field.machineName)} onChange={handleFieldChange} />
              ))}
            </div>
          )}

          {/* Multimedia and anything else that is part of the content, not a setting.
              Always expanded — a Media widget projected into a collapsed section is not
              rendered at all, which is how the image went missing twice. */}
          {leftSections.map(section => {
            const fields = fieldsBySection.get(section) ?? [];
            const meta = SECTION_META[section];
            return (
              <section key={section} data-left-section={section} className="pt-6.5 border-t border-rule">
                <p className="text-eyebrow-wide font-semibold uppercase text-ink-secondary">
                  {meta.title}
                </p>
                {meta.replaced && (
                  <p className="text-help text-ink-help mt-0.5">
                    Replaced {meta.replaced}.
                  </p>
                )}
                <div className="mt-3">
                  <SectionFields
                    fields={fields}
                    section={section}
                    errorFor={errorFor}
                    slottedFields={slottedFields}
                    onChange={handleFieldChange}
                  />
                </div>
              </section>
            );
          })}
        </div>

        {/* Right rail. Sticky beneath the action bar and scrolling on its own, so it is
            never longer than the screen: with one panel open at a time, whatever is open
            is always reachable without scrolling the writing column away. */}
        <HelpAsTipContext.Provider value>
        <aside
          className="bg-rail sticky overflow-y-auto"
          style={{ top: railTop, maxHeight: `calc(100vh - ${railTop}px)` }}
        >
          <div className="px-4.5 py-3 border-b border-rule">
            <p className="text-eyebrow-wide font-semibold uppercase text-ink-secondary">
              Everything else
            </p>
          </div>

          {primaryPanels.map(renderPanel)}

          {secondaryPanels.length > 0 && (
            <div data-rail-panel={MORE_KEY} className="border-b border-rule-hair">
              {railHeader(
                MORE_KEY,
                'More settings',
                secondaryPanels.map((p, i) => {
                  const title = SECTION_META[p].title;
                  return i === 0 ? title : title.toLowerCase();
                }).join(', '),
                moreHasError
              )}

              {(isPanelOpen(MORE_KEY) || moreHasError) && (
                /* Flat, not a stack of nested panels: each of these is one or two
                   fields, and a header per field was more chrome than content. */
                <div data-rail-more className="px-4.5 pb-4 flex flex-col gap-4">
                  {secondaryPanels.map(section => {
                    const fields = panelFields(section);
                    return (
                      <div key={section} data-rail-group={section} className="flex flex-col gap-1.5">
                        {/* A lone field's own label names it; a group needs a caption. */}
                        {fields.length > 1 && (
                          <p className="text-eyebrow font-semibold uppercase text-ink-secondary">
                            {SECTION_META[section].title}
                          </p>
                        )}
                        {renderFields(fields, section)}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <p className="px-4.5 py-3 text-help text-ink-help">
            Autosave is local to this extension. “Save draft to Drupal” writes a real revision.
          </p>
        </aside>
        </HelpAsTipContext.Provider>
      </div>

      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
    </SlottedFieldsContext.Provider>
  );
};
