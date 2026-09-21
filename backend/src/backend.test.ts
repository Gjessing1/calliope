import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { acceptsDeviceToken, registerDeviceAuth } from './device-auth.js';
import { resolveBookPath } from './paths.js';
import { appReleaseRoutes } from './routes/app-release.js';
import { isAllowedCoverUrl } from './routes/lookup.js';

describe('loadConfig', () => {
  it('treats ABS as unconfigured unless both URL and token are set', () => {
    expect(loadConfig({ ABS_URL: 'http://abs' }).abs).toBeNull();
    expect(loadConfig({ ABS_TOKEN: 'x' }).abs).toBeNull();
    expect(loadConfig({ ABS_URL: 'http://abs', ABS_TOKEN: 'x' })?.abs).toMatchObject({
      url: 'http://abs',
      booksRoot: '/books',
      rescanOnSave: true,
    });
  });

  it('reads booleans in the forms people actually write', () => {
    expect(loadConfig({ CALLIOPE_BACKUP_ON_SAVE: 'true' }).backupOnSave).toBe(true);
    expect(loadConfig({ CALLIOPE_BACKUP_ON_SAVE: '1' }).backupOnSave).toBe(true);
    expect(loadConfig({ CALLIOPE_BACKUP_ON_SAVE: 'no' }).backupOnSave).toBe(false);
    expect(loadConfig({}).backupOnSave).toBe(false);
    expect(loadConfig({}).scanOnStart).toBe(true);
  });

  it('keeps a bounded revision history enabled with a safe limit', () => {
    expect(loadConfig({}).revisionLimit).toBe(10);
    expect(loadConfig({ CALLIOPE_REVISION_LIMIT: '4' }).revisionLimit).toBe(4);
    expect(loadConfig({ CALLIOPE_REVISION_LIMIT: '0' }).revisionLimit).toBe(1);
    expect(loadConfig({ CALLIOPE_REVISION_LIMIT: 'not-a-number' }).revisionLimit).toBe(10);
  });

  it('reads one or more native-device tokens without exposing them elsewhere', () => {
    expect(
      loadConfig({ CALLIOPE_DEVICE_TOKENS: ' phone-a,phone-b\nphone-c ' }).deviceTokens,
    ).toEqual(['phone-a', 'phone-b', 'phone-c']);
  });
});

describe('native device authentication', () => {
  it('accepts only an exact bearer token', () => {
    expect(acceptsDeviceToken('Bearer secret-a', ['secret-a', 'secret-b'])).toBe(true);
    expect(acceptsDeviceToken('Bearer secret', ['secret-a'])).toBe(false);
    expect(acceptsDeviceToken('Basic secret-a', ['secret-a'])).toBe(false);
  });

  it('rejects an invalid native header while leaving SSO-screened browser traffic alone', async () => {
    const app = Fastify();
    registerDeviceAuth(app, ['right']);
    app.get('/api/test', async () => ({ ok: true }));

    expect((await app.inject('/api/test')).statusCode).toBe(200);
    expect(
      (await app.inject({ url: '/api/test', headers: { authorization: 'Bearer wrong' } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ url: '/api/test', headers: { authorization: 'Bearer right' } }))
        .statusCode,
    ).toBe(200);
    await app.close();
  });
});

describe('Android releases', () => {
  it('serves stable APK metadata/downloads and runtime-scoped web updates', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'calliope-release-'));
    const appDir = path.join(dataDir, 'app');
    const updateDir = path.join(appDir, 'updates', '7');
    await mkdir(updateDir, { recursive: true });
    await writeFile(path.join(appDir, 'calliope-0.2.0.apk'), 'apk');
    await writeFile(
      path.join(appDir, 'version.json'),
      JSON.stringify({
        versionCode: 7,
        versionName: '0.2.0',
        file: 'calliope-0.2.0.apk',
        bytes: 3,
        sha256: 'abc',
      }),
    );
    await writeFile(path.join(updateDir, 'bundle-deadbeef.zip'), 'zip');
    await writeFile(
      path.join(updateDir, 'current.json'),
      JSON.stringify({
        id: 'deadbeef',
        file: 'bundle-deadbeef.zip',
        bytes: 3,
        sha256: 'def',
        checksum: 'ZGVm',
        createdAt: '2026-09-21T00:00:00.000Z',
      }),
    );

    const app = Fastify();
    appReleaseRoutes(app, dataDir);

    const version = await app.inject('/api/app/version');
    expect(version.statusCode).toBe(200);
    expect(version.json()).toMatchObject({ versionCode: 7, apkUrl: '/api/app/download' });
    expect((await app.inject('/api/app/download')).body).toBe('apk');

    const update = await app.inject('/api/app/update?runtimeVersion=7&currentBundleId=old');
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({ id: 'deadbeef', sha256: 'def', checksum: 'ZGVm' });
    expect(
      (await app.inject('/api/app/update?runtimeVersion=7&currentBundleId=deadbeef')).statusCode,
    ).toBe(204);
    expect((await app.inject('/api/app/update/download?runtimeVersion=7&id=deadbeef')).body).toBe(
      'zip',
    );
    expect((await app.inject('/api/app/update?runtimeVersion=../7')).statusCode).toBe(400);
    await app.close();
  });
});

describe('resolveBookPath', () => {
  it('resolves a normal library path', () => {
    expect(resolveBookPath('/books', 'Sult/Sult.epub')).toBe('/books/Sult/Sult.epub');
  });

  it('refuses anything that escapes the root', () => {
    expect(resolveBookPath('/books', '../etc/passwd')).toBeNull();
    expect(resolveBookPath('/books', '/etc/passwd')).toBeNull();
    expect(resolveBookPath('/books', 'a/../../b.epub')).toBeNull();
  });

  // A sibling directory whose name merely starts with the root's name is not
  // inside the root — the separator check is what catches it.
  it('refuses a sibling with a prefix name', () => {
    expect(resolveBookPath('/books', '../books-backup/x.epub')).toBeNull();
  });
});

describe('isAllowedCoverUrl', () => {
  it('allows the cover hosts the providers actually serve from', () => {
    expect(isAllowedCoverUrl('https://covers.openlibrary.org/b/id/1-L.jpg')).toBe(true);
    expect(isAllowedCoverUrl('https://books.google.com/books/content?id=x')).toBe(true);
  });

  it('refuses anything else, and refuses plain HTTP', () => {
    expect(isAllowedCoverUrl('https://example.com/evil.jpg')).toBe(false);
    expect(isAllowedCoverUrl('http://covers.openlibrary.org/b/id/1-L.jpg')).toBe(false);
    expect(isAllowedCoverUrl('http://127.0.0.1:3008/api/status')).toBe(false);
    expect(isAllowedCoverUrl('not a url')).toBe(false);
  });
});
