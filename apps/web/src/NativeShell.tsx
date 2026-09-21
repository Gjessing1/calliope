import { App as CapacitorApp } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { LiveUpdate } from '@capawesome/capacitor-live-update';
import type { FormEvent, JSX, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { API_ORIGIN, api, connectDeviceToken, deviceToken, forgetDeviceToken } from './api.js';

const BUILTIN_BUNDLE_ID = import.meta.env.VITE_APP_BUNDLE_ID ?? 'development';

interface UpdateState {
  webReady: boolean;
  apkVersion: string | null;
  apkUrl: string | null;
}

let updateCheck: Promise<UpdateState> | null = null;

async function checkForUpdates(): Promise<UpdateState> {
  if (updateCheck) return updateCheck;
  updateCheck = (async () => {
    await LiveUpdate.ready();
    const [{ versionCode }, { bundleId }, appInfo] = await Promise.all([
      LiveUpdate.getVersionCode(),
      LiveUpdate.getCurrentBundle(),
      CapacitorApp.getInfo(),
    ]);
    const currentBundleId = bundleId ?? BUILTIN_BUNDLE_ID;
    const [webUpdate, androidRelease] = await Promise.all([
      api.webUpdate(String(versionCode), currentBundleId).catch(() => null),
      api.androidRelease().catch(() => null),
    ]);

    let webReady = false;
    if (webUpdate) {
      const url = new URL(webUpdate.url, API_ORIGIN).href;
      await LiveUpdate.downloadBundle({
        url,
        bundleId: webUpdate.id,
        checksum: webUpdate.checksum,
      });
      await LiveUpdate.setNextBundle({ bundleId: webUpdate.id });
      webReady = true;
    }

    const installedCode = Number(appInfo.build);
    const apkAvailable = androidRelease && androidRelease.versionCode > installedCode;
    return {
      webReady,
      apkVersion: apkAvailable ? androidRelease.versionName : null,
      apkUrl: apkAvailable ? new URL(androidRelease.apkUrl, API_ORIGIN).href : null,
    };
  })();
  return updateCheck;
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
      updateCheck = null;
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
  const [updates, setUpdates] = useState<UpdateState>({
    webReady: false,
    apkVersion: null,
    apkUrl: null,
  });

  useEffect(() => {
    if (native) void LiveUpdate.ready().catch(() => undefined);
  }, [native]);

  useEffect(() => {
    if (!native || !connected) return;
    void checkForUpdates()
      .then(setUpdates)
      .catch(() => undefined);
  }, [native, connected]);

  if (!native) return <>{children}</>;
  if (!connected) return <ConnectionSetup onConnected={() => setConnected(true)} />;

  return (
    <>
      {children}
      <button className="native-settings" type="button" onClick={() => setSettingsOpen(true)}>
        Device
      </button>
      {(updates.webReady || updates.apkVersion) && (
        <div className="native-update" role="status">
          {updates.webReady ? (
            <>
              <span>An update is ready.</span>
              <button className="primary" type="button" onClick={() => void LiveUpdate.reload()}>
                Restart now
              </button>
            </>
          ) : (
            <>
              <span>Calliope {updates.apkVersion} is available.</span>
              <button
                className="primary"
                type="button"
                onClick={() => updates.apkUrl && void Browser.open({ url: updates.apkUrl })}
              >
                Download APK
              </button>
            </>
          )}
        </div>
      )}
      {settingsOpen && (
        <ConnectionSetup
          onConnected={() => setSettingsOpen(false)}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {settingsOpen && (
        <button
          className="forget-device"
          type="button"
          onClick={() => {
            forgetDeviceToken();
            setSettingsOpen(false);
            setConnected(false);
          }}
        >
          Forget this device token
        </button>
      )}
    </>
  );
}
