import { useState, useEffect } from 'react';

export interface Settings {
  combobox: boolean;
  htmlExport: boolean;
  menuTree: boolean;
}

export const SETTING_DEFAULTS: Settings = {
  combobox: true,
  htmlExport: true,
  menuTree: true,
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
