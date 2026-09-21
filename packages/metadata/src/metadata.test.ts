import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanISBN, convertISBN10to13, isISBN10, isISBN13 } from './isbn.js';
import { deduplicateResults, searchByTitle } from './lookup.js';

afterEach(() => vi.unstubAllGlobals());

describe('isbn', () => {
  it('cleans separators and keeps a trailing X', () => {
    expect(cleanISBN('0-306-40615-X')).toBe('030640615X');
  });

  it('recognizes both forms', () => {
    expect(isISBN10('030640615X')).toBe(true);
    expect(isISBN13('9780306406157')).toBe(true);
    expect(isISBN13('1234567890123')).toBe(false);
  });

  it('converts ISBN-10 to ISBN-13 with the right check digit', () => {
    expect(convertISBN10to13('0306406152')).toBe('9780306406157');
    expect(convertISBN10to13('030640615X')).toBe('9780306406157');
  });
});

describe('deduplicateResults', () => {
  it('collapses the same ISBN across sources', () => {
    const out = deduplicateResults([
      { title: 'A', isbn: '978-0-14-044913-6', source: 'Google Books' },
      { title: 'A (reprint)', isbn: '9780140449136', source: 'Open Library' },
    ]);
    expect(out).toHaveLength(1);
  });

  // Different editions of a classic share a title; collapsing them would hide
  // the edition whose cover the user actually wanted.
  it('keeps two editions that differ by ISBN', () => {
    const out = deduplicateResults([
      { title: 'War and Peace', isbn: '9780140447934' },
      { title: 'War and Peace', isbn: '9781400079988' },
    ]);
    expect(out).toHaveLength(2);
  });

  it('merges ISBN-less results only on an exact title and author match', () => {
    const out = deduplicateResults([
      { title: 'Sult', author: 'Knut Hamsun', isbn: null },
      { title: 'sult!', author: 'knut hamsun', isbn: null },
      { title: 'Sult', author: 'Sverre Lyngstad', isbn: null },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('edition search', () => {
  it('uses the author to narrow every provider query', async () => {
    const urls: URL[] = [];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = new URL(input);
      urls.push(url);
      if (url.hostname === 'www.googleapis.com') return Response.json({ items: [] });
      if (url.hostname === 'openlibrary.org') return Response.json({ docs: [] });
      return Response.json({ results: [] });
    });

    await searchByTitle('Sult', 'Knut Hamsun');

    const google = urls.find(({ hostname }) => hostname === 'www.googleapis.com')!;
    const openLibrary = urls.find(({ hostname }) => hostname === 'openlibrary.org')!;
    const apple = urls.find(({ hostname }) => hostname === 'itunes.apple.com')!;
    expect(google.searchParams.get('q')).toBe('intitle:Sult inauthor:Knut Hamsun');
    expect(openLibrary.searchParams.get('title')).toBe('Sult');
    expect(openLibrary.searchParams.get('author')).toBe('Knut Hamsun');
    expect(apple.searchParams.get('term')).toBe('Sult Knut Hamsun');
  });
});
