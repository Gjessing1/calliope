/// <reference types="@capawesome/capacitor-live-update" />

import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The Android shell is the web app, unchanged, inside a WebView.
 *
 * `webDir` points at apps/web's build output rather than a copy: there is one
 * UI codebase and the APK must never drift from what the browser shows. The
 * build that produces it sets `VITE_API_ORIGIN`, because the WebView's origin is
 * `https://localhost` and there is no backend behind it — every request has to
 * be absolute and cross-origin (which is why the backend enables CORS).
 */
const config: CapacitorConfig = {
  appId: 'io.gjessing.calliope',
  appName: 'Calliope',
  webDir: '../web/dist',
  android: {
    // The WebView serves the bundle over https://localhost rather than
    // file://, so fetch, localStorage and relative URLs all behave as they do
    // in the browser.
    allowMixedContent: false,
  },
  server: {
    androidScheme: 'https',
  },
  plugins: {
    LiveUpdate: {
      // A downloaded UI must prove it can start. Otherwise the next launch
      // falls back to the APK's built-in bundle instead of boot-looping.
      readyTimeout: 10_000,
      autoBlockRolledBackBundles: true,
      autoDeleteBundles: true,
      autoUpdateStrategy: 'none',
    },
  },
};

export default config;
