import { describe, expect, it } from 'vitest';
import type { MergedBook } from '@calliope/core';
import { emptyMetadata } from '@calliope/core';
import { groupBooks } from './library-view.js';

const book = (id: string, author = '', series = ''): MergedBook => ({
  id,
  path: `${id}.epub`,
  folder: id,
  fileSize: 1,
  mtimeMs: 1,
  addedAt: 1,
  epubVersion: '3.0',
  metadata: {
    ...emptyMetadata(),
    title: id,
    author,
    authors: author ? [{ name: author, role: 'aut', fileAs: null }] : [],
    series,
  },
  hasCover: false,
  scannedAt: 1,
  abs: null,
  absDrift: [],
  absDifferences: [],
});

describe('groupBooks', () => {
  it('groups an author view without duplicating books', () => {
    const groups = groupBooks(
      [book('One', 'Octavia Butler'), book('Two', 'Octavia Butler'), book('Three')],
      'author',
    );

    expect(groups?.map((group) => [group.label, group.books.map(({ id }) => id)])).toEqual([
      ['Octavia Butler', ['One', 'Two']],
      ['Unknown author', ['Three']],
    ]);
  });

  it('groups series and gives ungrouped books an explicit home', () => {
    const groups = groupBooks([book('One', '', 'Earthsea'), book('Two')], 'series');
    expect(groups?.map((group) => group.label)).toEqual(['Earthsea', 'Not in a series']);
  });

  it('leaves ordinary sort views as one ungrouped grid', () => {
    expect(groupBooks([book('One')], 'title')).toBeNull();
    expect(groupBooks([book('One')], 'modified')).toBeNull();
  });
});
