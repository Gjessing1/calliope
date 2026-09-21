import type { JSX } from 'react';
import { createContext, useContext } from 'react';

export interface SettingsEntry {
  open: () => void;
  /** An update is downloaded or a new APK is published. */
  attention: boolean;
}

/** Provided by the native shell; absent in the browser, which has nothing to set. */
export const SettingsContext = createContext<SettingsEntry | null>(null);

export function SettingsButton(): JSX.Element | null {
  const settings = useContext(SettingsContext);
  if (!settings) return null;
  return (
    <button
      type="button"
      className="settings-button"
      onClick={settings.open}
      aria-label={settings.attention ? 'Settings — update available' : 'Settings'}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"
        />
      </svg>
      Settings
      {settings.attention && <span className="attention" aria-hidden="true" />}
    </button>
  );
}
