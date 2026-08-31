import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { ChevronUp, ChevronDown, AlertCircle } from 'lucide-react';
import {
  FormSchema, FieldDescriptor, SectionId,
} from '../../lib/formSchema';
import { readAll, writeAll, submitForm, syncRichEditorsToDom } from '../../lib/fieldBinding';
import {
  Draft, ConflictState, draftKey, readChangedStamp, loadDraft, saveDraft,
  clearDraft, assessDraft, formatAge,
} from '../../lib/autosave';
import { readFormErrors, hasErrors, FormErrors } from '../../lib/validationErrors';
import { FieldControl, SlottedFieldsContext, EMPTY_SLOTTED } from './FieldControl';
import { PrimaryField, primaryRole } from './PrimaryField';
import { TopicsSection } from './TopicsSection';
import { MenuSection } from './MenuSection';
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
  topics: { title: 'Topics & Tags', replaced: 'the checkbox list and the separate Primary Topic select' },
  related: { title: 'Related Content', replaced: 'the Related Content and Groups tabs, where each field needed an exact title' },
  multimedia: { title: 'Multimedia', replaced: 'the Multimedia tab' },
  menu: { title: 'Menu Placement', replaced: 'the Menu settings vertical tab' },
  display: { title: 'Display Template', replaced: 'a select buried in a vertical tab' },
  search: { title: 'Search & Social Preview', replaced: 'two fields buried in the Meta tags tab' },
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
const RAIL_PRIMARY: SectionId[] = ['search', 'topics', 'related'];

/**
 * Rail sections for the occasional save, behind one disclosure.
 *
 * Ten stacked headers make the rail a wall to be scanned every time, and the three that
 * matter get no more weight than Revision. These five are grouped rather than removed —
 * one extra click for menu placement or a URL alias, and anything holding a validation
 * error forces the group open so a rejected save is never hidden.
 */
const RAIL_SECONDARY: SectionId[] = ['menu', 'display', 'seo', 'revision', 'other'];

/**
 * Sections folded into another section's panel instead of getting their own.
 *
 * Groups is one audience autocomplete plus a "Sitewide News" flag — both cross-references
 * like everything else in Related Content, and not enough to earn a header of its own.
 */
const MERGED_INTO: Partial<Record<SectionId, SectionId>> = {
  groups: 'related',
};

const panelOf = (section: SectionId): SectionId => MERGED_INTO[section] ?? section;

/**
 * Sections that start expanded.
 *
 * Everything else stays collapsed by request — those sections are rarely touched — but a
 * field is only prominent if it is actually on screen when the page loads.
 */
const OPEN_BY_DEFAULT: SectionId[] = ['search'];

const SECTION_STATE_KEY = 'railSections';

/** Open/closed key for the secondary rail group. Not a SectionId, so it cannot collide. */
const MORE_KEY = '__more';

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

  const [open, setOpen] = useState<Record<string, boolean>>(
    () => Object.fromEntries(OPEN_BY_DEFAULT.map(section => [section, true]))
  );
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [conflict, setConflict] = useState<ConflictState>({ kind: 'none' });
  const [errors, setErrors] = useState<FormErrors | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const dirtyRef = useRef(false);

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
    // save would otherwise point at something invisible.
    setOpen(prev => {
      const next = { ...prev };
      // Through panelOf, or an error on a Groups field would open a panel that no longer
      // exists while Related Content — where the field is actually drawn — stayed shut.
      found.sections.forEach(section => { next[panelOf(section)] = true; });
      return next;
    });
  }, [schema.fields]);

  // --- Section open/closed state, remembered per content type ------------
  useEffect(() => {
    const storeKey = `${SECTION_STATE_KEY}:${schema.contentType ?? 'unknown'}`;
    chrome.storage.local.get({ [storeKey]: null }, result => {
      const stored = result[storeKey];
      if (stored && typeof stored === 'object') {
        // Never let stored state hide a section holding a validation error.
        setOpen(prev => ({ ...stored, ...prev }));
      }
    });
  }, [schema.contentType]);

  const toggleSection = useCallback((section: string) => {
    setOpen(prev => {
      const next = { ...prev, [section]: !prev[section] };
      const storeKey = `${SECTION_STATE_KEY}:${schema.contentType ?? 'unknown'}`;
      chrome.storage.local.set({ [storeKey]: next });
      return next;
    });
  }, [schema.contentType]);

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

  /** One collapsible rail panel: header, count, and its fields when open. */
  const renderPanel = (section: SectionId) => {
    const fields = panelFields(section);
    const meta = SECTION_META[section];
    const isOpen = Boolean(open[section]);
    const sectionHasError = errors?.fieldErrors.some(e => panelOf(e.field.section) === section);

    return (
      <div key={section} data-rail-panel={section} className="border-b border-rule-hair">
        <button
          type="button"
          onClick={() => toggleSection(section)}
          aria-expanded={isOpen}
          className="w-full flex items-center gap-2 px-4.5 py-3 text-left hover:bg-legacy-200 transition-colors duration-200 ease-studio"
        >
          <span className="flex-1 min-w-0">
            <span className="block text-section font-semibold text-ink">
              {meta.title}
              {sectionHasError && (
                <span className="ml-2 text-help font-semibold text-burnt">needs attention</span>
              )}
            </span>
            <span className="block text-help text-ink-help">
              {(() => {
                const advanced = fields.filter(f => f.advanced).length;
                const shown = fields.length - advanced;
                return advanced
                  ? `${shown} field${shown === 1 ? '' : 's'} · ${advanced} rarely used`
                  : `${fields.length} field${fields.length === 1 ? '' : 's'}`;
              })()}
              {meta.replaced ? ` · replaced ${meta.replaced}` : ''}
            </span>
          </span>
          {isOpen
            ? <ChevronUp size={14} className="text-ink-muted shrink-0" />
            : <ChevronDown size={14} className="text-ink-muted shrink-0" />}
        </button>

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
                    return <MenuSection parent={parent} others={others} errorFor={errorFor} />;
                  })()
                : section === 'related'
                  ? renderRelated()
                  : (
                    <SectionFields
                      fields={fields}
                      section={section}
                      errorFor={errorFor}
                      slottedFields={slottedFields}
                      onChange={handleFieldChange}
                    />
                  )}
          </div>
        )}
      </div>
    );
  };

  /**
   * Related Content, with the folded-in Groups fields captioned under it.
   *
   * Captioned rather than silently mixed in: an Organic Groups audience is a different
   * kind of thing from "Related Treatments", and an editor who was told to "set the
   * group" needs to recognise it.
   */
  const renderRelated = () => {
    const own = fieldsBySection.get('related') ?? [];
    const groups = fieldsBySection.get('groups') ?? [];

    return (
      <div className="flex flex-col gap-3">
        {own.length > 0 && (
          <SectionFields
            fields={own}
            section="related"
            errorFor={errorFor}
            slottedFields={slottedFields}
            onChange={handleFieldChange}
          />
        )}
        {groups.length > 0 && (
          <div
            data-panel-subgroup="groups"
            className={`flex flex-col gap-2 ${own.length > 0 ? 'pt-3 border-t border-rule-hair' : ''}`}
          >
            <p className="text-eyebrow font-semibold uppercase text-ink-secondary">
              {SECTION_META.groups.title}
            </p>
            <SectionFields
              fields={groups}
              section="groups"
              errorFor={errorFor}
              slottedFields={slottedFields}
              onChange={handleFieldChange}
            />
          </div>
        )}
      </div>
    );
  };

  const moreHasError = errors?.fieldErrors.some(
    e => secondaryPanels.includes(panelOf(e.field.section))
  );
  const moreOpen = Boolean(open[MORE_KEY]) || Boolean(moreHasError);

  return (
    <SlottedFieldsContext.Provider value={slottedFields ?? EMPTY_SLOTTED}>
    <div className="bg-canvas font-sans">
      {/* Sticky action bar */}
      <div className="sticky top-11 z-40 bg-white border-b border-rule px-4.5 py-3 flex items-center gap-4 flex-wrap">
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
      <div className="grid items-start" style={{ gridTemplateColumns: '1fr 392px' }}>
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

        {/* Right rail */}
        <aside className="bg-rail">
          <div className="px-4.5 py-3 border-b border-rule">
            <p className="text-eyebrow-wide font-semibold uppercase text-ink-secondary">
              Everything Else
            </p>
            <p className="text-help text-ink-help mt-0.5">
              was five tabs plus a six-item vertical-tab block.
            </p>
          </div>

          {primaryPanels.map(renderPanel)}

          {secondaryPanels.length > 0 && (
            <div className="border-b border-rule-hair">
              <button
                type="button"
                onClick={() => toggleSection(MORE_KEY)}
                aria-expanded={moreOpen}
                className="w-full flex items-center gap-2 px-4.5 py-3 text-left hover:bg-legacy-200 transition-colors duration-200 ease-studio"
              >
                <span className="flex-1 min-w-0">
                  <span className="block text-section font-semibold text-ink">
                    Settings used occasionally
                    {moreHasError && (
                      <span className="ml-2 text-help font-semibold text-burnt">needs attention</span>
                    )}
                  </span>
                  <span className="block text-help text-ink-help">
                    {secondaryPanels.map(s => SECTION_META[s].title).join(' · ')}
                  </span>
                </span>
                {moreOpen
                  ? <ChevronUp size={14} className="text-ink-muted shrink-0" />
                  : <ChevronDown size={14} className="text-ink-muted shrink-0" />}
              </button>

              {moreOpen && (
                <div data-rail-more className="border-t border-rule-hair">
                  {secondaryPanels.map(renderPanel)}
                </div>
              )}
            </div>
          )}

          <p className="px-4.5 py-3 text-help text-ink-help">
            Autosave is local to this extension. “Save draft to Drupal” writes a real revision.
          </p>
        </aside>
      </div>

      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
    </SlottedFieldsContext.Provider>
  );
};
