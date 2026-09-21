/// <reference types="vite/client" />

/**
 * The one build-time variable the app reads.
 *
 * Unset in the browser (the backend serves this build same-origin, and Vite
 * proxies /api in dev); set by `apps/android/build-apk.sh`, where the WebView
 * has no backend behind its own origin.
 */
interface ImportMetaEnv {
  readonly VITE_API_ORIGIN?: string;
  /** Git commit carried by the built-in Android web bundle. */
  readonly VITE_APP_BUNDLE_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
