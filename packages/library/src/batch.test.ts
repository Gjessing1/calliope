import { describe, expect, it } from 'vitest';
import type { BookMetadata, LibraryBook } from '@calliope/core';
import { emptyMetadata } from '@calliope/core';
import { planBatch } from './batch.js';

const book = (title: string, metadata: Partial<BookMetadata> = {}): LibraryBook => ({
  id: title,
  path: `${title}/${title}.epub`,
  folder: title,
  fileSize: 100,
  mtimeMs: 5,
  addedAt: 1,
  epubVersion: '3.0',
  metadata: {
    ...emptyMetadata(),
    title,
    author: 'Leo Tolstoy',
    authors: [{ name: 'Leo Tolstoy', role: 'aut', fileAs: 'Tolstoy, Leo' }],
    language: 'en',
    ...metadata,
  },
  hasCover: false,
  scannedAt: 1,
});

describe('planBatch — read status', () => {
  it.each([true, false])('plans only changed read flags (%s)', (read) => {
    const plan = planBatch([book('A', { read: !read }), book('B', { read })], {
      kind: 'read',
      read,
    });
    expect(plan.items).toMatchObject([
      { id: 'A', update: { read }, expectedMtimeMs: 5, expectedFileSize: 100 },
    ]);
    expect(plan.items[0]?.update).toEqual({ read });
    expect(plan.unchanged).toEqual([{ id: 'B', title: 'B' }]);
  });
});

describe('planBatch — series', () => {
  it('numbers by publication date, undated last, from the start given', () => {
    const plan = planBatch(
      [book('C', { date: '' }), book('B', { date: '1869-01-01' }), book('A', { date: '1856' })],
      { kind: 'series', series: 'Tolstoy', numbering: 'date', start: 3 },
    );
    expect(plan.items.map((item) => [item.title, item.update.seriesIndex])).toEqual([
      ['A', '3'],
      ['B', '4'],
      ['C', '5'],
    ]);
  });

  it('carries only the fields that change, and the file state it was planned against', () => {
    const plan = planBatch([book('A', { series: 'Old', seriesIndex: '2' })], {
      kind: 'series',
      series: 'New',
      numbering: 'keep',
    });
    expect(plan.items[0]?.update).toEqual({ series: 'New' });
    expect(plan.items[0]).toMatchObject({ expectedMtimeMs: 5, expectedFileSize: 100 });
  });

  it('reports a book it would not change instead of rewriting it', () => {
    const plan = planBatch([book('A', { series: 'Same' }), book('B')], {
      kind: 'series',
      series: 'Same',
      numbering: 'keep',
    });
    expect(plan.unchanged).toEqual([{ id: 'A', title: 'A' }]);
    expect(plan.items.map((item) => item.id)).toEqual(['B']);
  });

  it('takes the number away with the series', () => {
    const plan = planBatch([book('A', { series: 'Old', seriesIndex: '2' })], {
      kind: 'series',
      series: '',
      numbering: 'keep',
    });
    expect(plan.items[0]?.update).toEqual({ series: '', seriesIndex: '' });
  });
});

describe('planBatch — language', () => {
  it('fixes a code the file spells differently from how the reader shows it', () => {
    const plan = planBatch(
      [book('A', { language: 'ru', languageConverted: 'rus' }), book('B', { language: 'ru' })],
      { kind: 'language', language: 'ru' },
    );
    expect(plan.items.map((item) => item.id)).toEqual(['A']);
    expect(plan.items[0]?.changes[0]).toMatchObject({ before: 'rus', after: 'ru' });
    expect(plan.unchanged.map((b) => b.id)).toEqual(['B']);
  });

  it('writes the normalized code, and refuses something that is not a code', () => {
    expect(planBatch([book('A')], { kind: 'language', language: 'nor' }).items[0]?.update).toEqual({
      language: 'no',
    });
    const plan = planBatch([book('A')], { kind: 'language', language: '  ' });
    expect(plan.items).toEqual([]);
    expect(plan.warnings).toHaveLength(1);
  });
});

describe('planBatch — subjects, authors, tidy', () => {
  it('adds and removes subjects without duplicating any, ignoring case', () => {
    const plan = planBatch([book('A', { subjects: ['Fiction', 'war stories'] })], {
      kind: 'subjects',
      add: ['fiction', 'Classics'],
      remove: ['War Stories'],
    });
    expect(plan.items[0]?.update).toEqual({ subjects: ['Fiction', 'Classics'] });
  });

  it('renames an author, keeping the role and — unless told — the sort name', () => {
    const books = [
      book('A', {
        authors: [
          { name: 'graf Leo Tolstoy', role: 'aut', fileAs: 'Tolstoy, Leo' },
          { name: 'Aylmer Maude', role: 'trl', fileAs: null },
        ],
      }),
      book('B', { authors: [{ name: 'Someone Else', role: 'aut', fileAs: null }] }),
    ];
    const plan = planBatch(books, {
      kind: 'author',
      from: 'Graf Leo Tolstoy ',
      to: 'Leo Tolstoy',
      fileAs: null,
    });
    expect(plan.items[0]?.update.authors).toEqual([
      { name: 'Leo Tolstoy', role: 'aut', fileAs: 'Tolstoy, Leo' },
      { name: 'Aylmer Maude', role: 'trl', fileAs: null },
    ]);
    expect(plan.unchanged.map((b) => b.id)).toEqual(['B']);
  });

  it('applies only the cleanups that were picked', () => {
    const messy = book('A', {
      title: '  War  and Peace ',
      description: '<p>Five families &amp; a war.</p>',
      date: 'March 3, 1869',
    });
    const descriptionOnly = planBatch([messy], { kind: 'tidy', parts: ['description'] });
    expect(descriptionOnly.items[0]?.update).toEqual({ description: 'Five families & a war.' });

    const all = planBatch([messy], { kind: 'tidy', parts: ['whitespace', 'date'] });
    expect(all.items[0]?.update).toEqual({ title: 'War and Peace', date: '1869-03-03' });
  });
});
