import type { AbsBook, LibraryBook, MergedBook } from '@calliope/core';

/** Loose equality for comparing two systems' idea of the same field. */
function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Compare what the EPUB says with what Audiobookshelf shows.
 *
 * The point is not to decide who is right — it is to make a disagreement
 * visible. ABS lets a user override metadata in its own database without
 * touching the file, so a book can read "The Trial" in the app and carry
 * "Der Process" in the OPF indefinitely, and nothing surfaces that today.
 *
 * Only fields both systems model are compared. Narrators, for instance, exist
 * in ABS and have no EPUB equivalent, so their absence is not drift.
 */
export function absDrift(book: LibraryBook, abs: AbsBook | null): string[] {
  if (!abs) return [];

  const drift: string[] = [];
  const meta = book.metadata;

  if (abs.title && !sameText(meta.title, abs.title)) drift.push('title');

  const epubAuthors = meta.authors.map((a) => a.name);
  if (
    abs.authors.length > 0 &&
    (epubAuthors.length !== abs.authors.length ||
      !epubAuthors.every((name, i) => sameText(name, abs.authors[i])))
  ) {
    drift.push('authors');
  }

  const absSeries = abs.series[0];
  if (absSeries?.name && !sameText(meta.series, absSeries.name)) drift.push('series');

  if (abs.publisher && !sameText(meta.publisher, abs.publisher)) drift.push('publisher');

  // ABS keeps only a year; compare against the EPUB date's year rather than
  // reporting drift on every book that carries a full date.
  if (abs.publishedYear && meta.date && !meta.date.startsWith(abs.publishedYear)) {
    drift.push('date');
  }

  if (abs.isbn && meta.identifier && !sameText(meta.identifier, abs.isbn)) drift.push('identifier');

  if (abs.language && meta.language && !sameText(meta.language, abs.language)) {
    drift.push('language');
  }

  return drift;
}

/** Attach the ABS record and the drift report to a library book. */
export function mergeAbs(book: LibraryBook, abs: AbsBook | null): MergedBook {
  return { ...book, abs, absDrift: absDrift(book, abs) };
}
