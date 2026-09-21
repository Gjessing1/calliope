import { describe, expect, it } from 'vitest';
import { cleanISBN, convertISBN10to13, isISBN10, isISBN13 } from './isbn.js';
import { deduplicateResults } from './lookup.js';

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
