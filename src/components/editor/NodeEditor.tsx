import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { ChevronUp, ChevronDown, AlertCircle } from 'lucide-react';
import {
  FormSchema, FieldDescriptor, SectionId, populatedSections,
} from '../../lib/formSchema';
import { readAll, writeAll, submitForm } from '../../lib/fieldBinding';
import {
  Draft, ConflictState, draftKey, readChangedStamp, loadDraft, saveDraft,
  clearDraft, assessDraft, formatAge,
} from '../../lib/autosave';
import { readFormErrors, hasErrors, FormErrors } from '../../lib/validationErrors';
import { FieldControl } from './FieldControl';
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
  related: { title: 'Related Content', replaced: 'the Related Content tab, where each field needed an exact title' },
  multimedia: { title: 'Multimedia', replaced: 'the Multimedia tab' },
  menu: { title: 'Menu Placement', replaced: 'the Menu settings vertical tab' },
  display: { title: 'Display Template', replaced: 'a select buried in a vertical tab' },
  seo: { title: 'URL, SEO & Sitemap', replaced: 'the Meta tags, URL path and XML sitemap tabs' },
  groups: { title: 'Groups', replaced: 'the Groups tab' },
  revision: { title: 'Revision', replaced: 'the Revision information tab' },
  other: { title: 'Other Fields' },
};

/** Sections that live in the right rail, in the handoff's order. */
const RAIL_ORDER: SectionId[] = [
  'topics', 'related', 'multimedia', 'menu', 'display', 'seo', 'groups', 'revision', 'other',
];

const SECTION_STATE_KEY = 'railSections';

export const NodeEditor = ({ schema, slottedFields }: Props) => {
  const key = useMemo(() => draftKey(window.location), []);
  const baseChanged = useMemo(() => readChangedStamp(schema.form), [schema.form]);

  const [open, setOpen] = useState<Record<string, boolean>>({});
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

  const sections = useMemo(() => populatedSections(schema), [schema]);
  const railSections = useMemo(
    () => RAIL_ORDER.filter(s => sections.includes(s)),
    [sections]
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
      found.sections.forEach(section => { next[section] = true; });
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
  const persist = useCallback(async () => {
    const draft: Draft = {
      values: readAll(schema.fields),
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
      if (dirtyRef.current) {
        dirtyRef.current = false;
        void persist();
      }
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

  return (
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
            const role = primaryRole(field);
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

          {railSections.map(section => {
            const fields = fieldsBySection.get(section) ?? [];
            const meta = SECTION_META[section];
            const isOpen = Boolean(open[section]);
            const sectionHasError = errors?.fieldErrors.some(e => e.field.section === section);

            return (
              <div key={section} className="border-b border-rule-hair">
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
                      {fields.length} field{fields.length === 1 ? '' : 's'}
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
                        : (
                          <div className="flex flex-col gap-3">
                            {fields.map(field => (
                              <FieldControl
                                key={field.machineName}
                                field={field}
                                dense
                                error={errorFor(field)}
                                slotted={slottedFields?.has(field.machineName)}
                                onChange={handleFieldChange}
                              />
                            ))}
                          </div>
                        )}
                  </div>
                )}
              </div>
            );
          })}

          <p className="px-4.5 py-3 text-help text-ink-help">
            Autosave is local to this extension. “Save draft to Drupal” writes a real revision.
          </p>
        </aside>
      </div>

      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
};
