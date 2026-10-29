import type { MergedBook } from '@calliope/core';

export type LibraryView = 'title' | 'author' | 'series' | 'added' | 'modified';
export type ReadFilter = 'all' | 'unread' | 'read';

export interface BookGroup {
  label: string;
  books: MergedBook[];
}

/**
 * Author and series are browse views, not merely sort orders. A book appears
 * once under its primary author so counts and multi-selection keep referring
 * to real books rather than duplicated cards.
 */
export function groupBooks(books: MergedBook[], view: LibraryView): BookGroup[] | null {
  if (view !== 'author' && view !== 'series') return null;

  const groups = new Map<string, BookGroup>();
  for (const book of books) {
    const primaryAuthor =
      book.metadata.author.trim() || book.metadata.authors[0]?.name.trim() || 'Unknown author';
    const label =
      view === 'author' ? primaryAuthor : book.metadata.series.trim() || 'Not in a series';
    const group = groups.get(label);
    if (group) group.books.push(book);
    else groups.set(label, { label, books: [book] });
  }
  return [...groups.values()];
}
