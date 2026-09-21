import { App as CapacitorApp } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { LiveUpdate } from '@capawesome/capacitor-live-update';
import type { FormEvent, JSX, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  API_ORIGIN,
  ApiError,
  api,
  connectDeviceToken,
  deviceToken,
  forgetDeviceToken,
} from './api.js';
import { SettingsContext } from './components/SettingsButton.js';

const BUILTIN_BUNDLE_ID = import.meta.env.VITE_APP_BUNDLE_ID ?? 'development';

let confirmed: Promise<unknown> | null = null;

/**
 * Tell the live-update plugin this bundle started. Only ever called for a bundle
 * that has an API origin: one without sends every request to the WebView itself,
 * and withholding ready() lets the plugin's timeout roll it back to the APK's
 * built-in bundle and block it. This is a build check, not a network one — a
 * good bundle launched offline must still be confirmed.
 */
function confirmBundle(): Promise<unknown> {
  confirmed ??= LiveUpdate.ready().catch(() => undefined);
  return confirmed;
}

type OtaPhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'error';

interface Installed {
  versionName: string;
  versionCode: number;
  /** The running web bundle, or the one built into the APK. */
  bundleId: string;
  /** False while the APK's built-in bundle is running. */
  updatedOverTheAir: boolean;
}

interface UpdateState {
  phase: OtaPhase;
  installed: Installed | null;
  /** A published APK newer than this install. */
  apk: { versionName: string; bytes: number; url: string } | null;
  /** Whether the last check learned what APK is published at all. */
  apkKnown: boolean;
  error: string | null;
  checkedAt: number | null;
}

interface Updates extends UpdateState {
  check: () => Promise<void>;
  restart: () => void;
  downloadApk: () => void;
}

/** Only the first mount checks by itself; after that it is the Settings button. */
let launchChecked = false;

/**
 * Both update channels in one check. A web bundle is downloaded and staged, so
 * "ready" means the next restart runs it; a newer APK is only reported, because
 * a native change has to be installed by Android.
 */
function useUpdates(): Updates {
  const [state, setState] = useState<UpdateState>({
    phase: 'idle',
    installed: null,
    apk: null,
    apkKnown: false,
    error: null,
    checkedAt: null,
  });
  const running = useRef(false);

  const check = useCallback(async (): Promise<void> => {
    if (running.current) return;
    running.current = true;
    setState((s) => ({ ...s, phase: 'checking', error: null }));
    try {
      if (!API_ORIGIN) throw new Error('this build of the app has no server address');
      await confirmBundle();
      const [{ versionCode }, current, next, downloaded, info] = await Promise.all([
        LiveUpdate.getVersionCode(),
        LiveUpdate.getCurrentBundle(),
        LiveUpdate.getNextBundle(),
        LiveUpdate.getBundles(),
        CapacitorApp.getInfo(),
      ]);
      const installed: Installed = {
        versionName: info.version,
        versionCode: Number(info.build),
        bundleId: current.bundleId ?? BUILTIN_BUNDLE_ID,
        updatedOverTheAir: current.bundleId !== null,
      };
      setState((s) => ({ ...s, installed }));

      // A server with no APK published answers 404, which is an answer too.
      const release = await api
        .androidRelease()
        .catch((err: unknown) =>
          err instanceof ApiError && err.status === 404 ? null : undefined,
        );
      const apk =
        release && release.versionCode > installed.versionCode
          ? {
              versionName: release.versionName,
              bytes: release.bytes,
              url: new URL(release.apkUrl, API_ORIGIN).href,
            }
          : null;
      setState((s) => ({ ...s, apk, apkKnown: release !== undefined }));

      const web = await api.webUpdate(versionCode, installed.bundleId);
      // A second check in one session finds the bundle the first one staged;
      // downloading it again would fail on the existing bundle id.
      if (web && next.bundleId !== web.id) {
        if (!downloaded.bundleIds.includes(web.id)) {
          setState((s) => ({ ...s, phase: 'downloading' }));
          await LiveUpdate.downloadBundle({
            url: new URL(web.url, API_ORIGIN).href,
            bundleId: web.id,
            checksum: web.checksum,
          });
        }
        await LiveUpdate.setNextBundle({ bundleId: web.id });
      }
      setState((s) => ({ ...s, phase: web ? 'ready' : 'current', checkedAt: Date.now() }));
    } catch (err) {
      setState((s) => ({
        ...s,
        phase: 'error',
        error: (err as Error).message,
        checkedAt: Date.now(),
      }));
    } finally {
      running.current = false;
    }
  }, []);

  const restart = useCallback(() => void LiveUpdate.reload(), []);
  const { apk } = state;
  const downloadApk = useCallback(() => {
    if (apk) void Browser.open({ url: apk.url });
  }, [apk]);

  return { ...state, check, restart, downloadApk };
}

const shortId = (id: string): string => (/^[0-9a-f]{40}$/.test(id) ? id.slice(0, 7) : id);
const megabytes = (bytes: number): string => `${(bytes / 1_048_576).toFixed(1)}\u00a0MB`;
const clock = (ms: number): string =>
  new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function interfaceStatus(updates: Updates): string {
  switch (updates.phase) {
    case 'idle':
      return 'Not checked yet.';
    case 'checking':
      return 'Checking…';
    case 'downloading':
      return 'Downloading the update…';
    case 'ready':
      return 'An update is downloaded. Restart to use it.';
    case 'current':
      return 'Up to date.';
    case 'error':
      return `Could not check: ${updates.error ?? 'unknown error'}.`;
  }
}

function appStatus(updates: Updates): string {
  if (updates.apk) {
    return `Calliope ${updates.apk.versionName} is available (${megabytes(updates.apk.bytes)}). It changes the app itself, so it installs as a new APK.`;
  }
  if (updates.apkKnown) return 'Newest release.';
  if (updates.phase === 'checking' || updates.phase === 'downloading') return 'Checking…';
  return updates.checkedAt ? 'Could not check.' : 'Not checked yet.';
}

function SettingsSheet({
  updates,
  onClose,
  onChangeToken,
  onForget,
}: {
  updates: Updates;
  onClose: () => void;
  onChangeToken: () => void;
  onForget: () => void;
}): JSX.Element {
  const [serverSha, setServerSha] = useState<string | null>(null);
  useEffect(() => {
    void api
      .status()
      .then((status) => setServerSha(status.gitSha))
      .catch(() => setServerSha(null));
  }, []);

  const { installed } = updates;
  const busy = updates.phase === 'checking' || updates.phase === 'downloading';
  const host = API_ORIGIN ? new URL(API_ORIGIN).host : 'No server address';

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <aside
        className="sheet settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="sheet-head">
          <h2 id="settings-title">Settings</h2>
          <button type="button" className="icon" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </header>
        <div className="sheet-body">
          <section className="settings-section" aria-labelledby="settings-updates">
            <h3 id="settings-updates">Updates</h3>
            <div className="settings-row">
              <div>
                <strong>App</strong>
                <span className="settings-detail">
                  {installed ? `${installed.versionName} (build ${installed.versionCode})` : '—'}
                </span>
                <span>{appStatus(updates)}</span>
              </div>
              {updates.apk && (
                <button className="primary" type="button" onClick={updates.downloadApk}>
                  Download APK
                </button>
              )}
            </div>
            <div className="settings-row">
              <div>
                <strong>Interface</strong>
                <span className="settings-detail">
                  {installed
                    ? `${shortId(installed.bundleId)} · ${installed.updatedOverTheAir ? 'updated over the air' : 'built into the app'}`
                    : '—'}
                </span>
                <span>{interfaceStatus(updates)}</span>
              </div>
              {updates.phase === 'ready' && (
                <button className="primary" type="button" onClick={updates.restart}>
                  Restart now
                </button>
              )}
            </div>
            <div className="settings-actions">
              <button type="button" onClick={() => void updates.check()} disabled={busy}>
                {busy ? 'Checking…' : 'Check for updates'}
              </button>
              {updates.checkedAt && (
                <span className="hint">Last checked {clock(updates.checkedAt)}</span>
              )}
            </div>
          </section>

          <section className="settings-section" aria-labelledby="settings-server">
            <h3 id="settings-server">Server</h3>
            <div className="settings-row">
              <div>
                <strong>{host}</strong>
                {serverSha && (
                  <span className="settings-detail">Server version {shortId(serverSha)}</span>
                )}
                <span>Connected with this phone’s device token.</span>
              </div>
            </div>
            <div className="settings-actions">
              <button type="button" onClick={onChangeToken}>
                Change device token
              </button>
              <button type="button" className="danger" onClick={onForget}>
                Forget this device token
              </button>
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}

function ConnectionSetup({
  onConnected,
  onClose,
}: {
  onConnected: () => void;
  onClose?: () => void;
}) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setConnecting(true);
    setError(null);
    try {
      await connectDeviceToken(token);
      onConnected();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="setup-screen">
      <form className="setup-card" onSubmit={(event) => void submit(event)}>
        <h1>Connect Calliope</h1>
        <p>
          This APK belongs to <strong>{API_ORIGIN}</strong>. Enter one of that server’s device
          tokens once; it stays on this phone.
        </p>
        <label>
          Device token
          <input
            type="password"
            autoComplete="off"
            autoFocus
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        {error && <p className="banner banner-error">{error}</p>}
        <div className="setup-actions">
          {onClose && (
            <button type="button" onClick={onClose}>
              Cancel
            </button>
          )}
          <button className="primary" type="submit" disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function NativeShell({ children }: { children: ReactNode }): JSX.Element {
  const native = Capacitor.isNativePlatform();
  const [connected, setConnected] = useState(() => !native || Boolean(deviceToken()));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [changingToken, setChangingToken] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const updates = useUpdates();
  const { check } = updates;

  useEffect(() => {
    if (native && API_ORIGIN) void confirmBundle();
  }, [native]);

  useEffect(() => {
    if (!native || !connected || launchChecked) return;
    launchChecked = true;
    void check();
  }, [native, connected, check]);

  const attention = updates.phase === 'ready' || updates.apk !== null;
  const settings = useMemo(() => ({ open: () => setSettingsOpen(true), attention }), [attention]);

  if (!native) return <>{children}</>;
  if (!connected) return <ConnectionSetup onConnected={() => setConnected(true)} />;

  return (
    <SettingsContext.Provider value={settings}>
      {children}
      {attention && !bannerDismissed && !settingsOpen && (
        <div className="native-update" role="status">
          <span>
            {updates.phase === 'ready'
              ? 'An update is ready.'
              : `Calliope ${updates.apk?.versionName ?? ''} is available.`}
          </span>
          <span className="native-update-actions">
            <button className="quiet" type="button" onClick={() => setBannerDismissed(true)}>
              Later
            </button>
            {updates.phase === 'ready' ? (
              <button className="primary" type="button" onClick={updates.restart}>
                Restart now
              </button>
            ) : (
              <button className="primary" type="button" onClick={updates.downloadApk}>
                Download APK
              </button>
            )}
          </span>
        </div>
      )}
      {settingsOpen && (
        <SettingsSheet
          updates={updates}
          onClose={() => setSettingsOpen(false)}
          onChangeToken={() => setChangingToken(true)}
          onForget={() => {
            if (!window.confirm('Forget the device token? Calliope asks for it again next.'))
              return;
            forgetDeviceToken();
            setSettingsOpen(false);
            setConnected(false);
          }}
        />
      )}
      {changingToken && (
        <ConnectionSetup
          onConnected={() => setChangingToken(false)}
          onClose={() => setChangingToken(false)}
        />
      )}
    </SettingsContext.Provider>
  );
}
