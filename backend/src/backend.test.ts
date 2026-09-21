import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { resolveBookPath } from './paths.js';
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
