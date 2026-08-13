import { useState, useEffect } from 'react';

export interface Settings {
  combobox: boolean;
  htmlExport: boolean;
  menuTree: boolean;
  /** ⌘K command palette on every matched admin page. */
  commandPalette: boolean;
  /** Modern /admin/content list in place of Drupal's table. */
  contentList: boolean;
  /**
   * Prints the discovered form schema to the console on node add/edit pages.
   * Off by default — it is a diagnostic for validating the field-discovery rules
   * against real forms, not something an editor needs.
   */
  debugSchema: boolean;
}

export const SETTING_DEFAULTS: Settings = {
  combobox: true,
  htmlExport: true,
  menuTree: true,
  commandPalette: true,
  contentList: true,
  debugSchema: false,
};

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(SETTING_DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    chrome.storage.local.get(SETTING_DEFAULTS as unknown as { [k: string]: unknown }, (result) => {
      setSettings(result as unknown as Settings);
      setLoaded(true);
    });
  }, []);

  const update = (key: keyof Settings, value: boolean) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    chrome.storage.local.set(next);
  };

  return { settings, update, loaded };
}
