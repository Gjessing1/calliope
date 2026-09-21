import { describe, expect, it } from 'vitest';
import { diffWords, metadataChanges } from './diff.js';
import { emptyMetadata } from './metadata.js';

const join = (parts: ReturnType<typeof diffWords>, side: 'before' | 'after'): string =>
  parts
    .filter(
      (part) => part.kind === 'same' || part.kind === (side === 'before' ? 'removed' : 'added'),
    )
    .map((part) => part.text)
    .join('');

describe('diffWords', () => {
  it('isolates a changed run of words', () => {
    expect(diffWords('the quick brown fox', 'the slow red fox')).toEqual([
      { kind: 'same', text: 'the ' },
      { kind: 'removed', text: 'quick brown ' },
      { kind: 'added', text: 'slow red ' },
      { kind: 'same', text: 'fox' },
    ]);
  });

  it('reproduces both sides exactly, whitespace included', () => {
    const before = '  A novel of\nSt Petersburg,  first published 1866. ';
    const after = 'A novel of St Petersburg, first serialized in 1866.\n';
    const parts = diffWords(before, after);
    expect(join(parts, 'before')).toBe(before);
    expect(join(parts, 'after')).toBe(after);
  });

  it('handles an empty side', () => {
    expect(diffWords('', 'new text')).toEqual([{ kind: 'added', text: 'new text' }]);
    expect(diffWords('old text', '')).toEqual([{ kind: 'removed', text: 'old text' }]);
    expect(diffWords('same', 'same')).toEqual([{ kind: 'same', text: 'same' }]);
  });

  // Two unrelated long texts must not allocate a table the size of both.
  it('falls back to a whole replacement for very large unrelated texts', () => {
    const before = Array.from({ length: 800 }, (_, i) => `a${i}`).join(' ');
    const after = Array.from({ length: 800 }, (_, i) => `b${i}`).join(' ');
    const parts = diffWords(before, after);
    expect(parts.map((part) => part.kind)).toEqual(['removed', 'added']);
    expect(join(parts, 'after')).toBe(after);
  });
});

describe('metadataChanges', () => {
  const file = {
    ...emptyMetadata(),
    title: 'Sult',
    authors: [{ name: 'Knut Hamsun', role: 'aut', fileAs: 'Hamsun, Knut' }],
    contributors: [{ name: 'Sverre Lyngstad', role: 'trl' }],
    subjects: ['Fiction'],
    rights: 'Public domain',
  };

  it('reports only the fields that differ, in form order', () => {
    const changes = metadataChanges(file, {
      ...file,
      title: 'Hunger',
      subjects: ['Fiction', 'Norway'],
    });
    expect(changes).toEqual([
      { key: 'title', label: 'Title', before: 'Sult', after: 'Hunger' },
      { key: 'subjects', label: 'Subjects', before: 'Fiction', after: 'Fiction, Norway' },
    ]);
  });

  // The editor's draft is a MetadataUpdate without `rights`; that must not read
  // as the user clearing it.
  it('skips fields the update leaves undefined', () => {
    expect(metadataChanges(file, { title: 'Sult' })).toEqual([]);
    expect(metadataChanges(file, { rights: '' })).toMatchObject([
      { key: 'rights', before: 'Public domain', after: '' },
    ]);
  });

  it('compares the editor representation against the file representation', () => {
    expect(
      metadataChanges(file, {
        authors: ['Knut Hamsun'],
        contributors: 'Sverre Lyngstad',
        seriesIndex: 2,
      }),
    ).toEqual([
      {
        key: 'authors',
        label: 'Authors',
        before: 'Knut Hamsun (aut) [Hamsun, Knut]',
        after: 'Knut Hamsun',
      },
      { key: 'seriesIndex', label: 'Series number', before: '', after: '2' },
    ]);
  });
});
