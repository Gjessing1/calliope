import { posix } from 'node:path';
import type { BookHealthIssue, LibraryBook } from '@calliope/core';

function normalized(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/** ISBN-10 and its ISBN-13 form identify the same edition. */
function isbnKey(value: string): string {
  const bare = value
    .replace(/^urn:isbn:/i, '')
    .replace(/[^0-9X]/gi, '')
    .toUpperCase();
  if (!/^\d{9}[\dX]$/.test(bare)) return bare;
  const base = `978${bare.slice(0, 9)}`;
  const sum = [...base].reduce(
    (total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return `${base}${(10 - (sum % 10)) % 10}`;
}

function looksLikeFilename(book: LibraryBook): boolean {
  const title = book.metadata.title.trim();
  if (/\.(?:epub|mobi|azw3|pdf)$/i.test(title) || /[/\\].*\.(?:epub|mobi|azw3|pdf)$/i.test(title)) {
    return true;
  }

  const filename = posix.basename(book.path);
  const stem = filename.replace(/\.epub$/i, '');
  if (normalized(title) !== normalized(stem)) return false;

  // Equality with a clean filename is not suspicious: well-kept libraries
  // often name `Sult.epub` after its real title. Flag equality only when the
  // stem still carries unmistakable filename/release conventions.
  return (
    stem.includes('_') ||
    /\s[-–—]\s/.test(stem) ||
    /\[[^\]]+\]/.test(stem) ||
    /\b(?:retail|ebook|epub|v\d+)\b/i.test(stem)
  );
}

/**
 * Derive every library-health issue from the indexed file records.
 *
 * The map is deliberately recomputed: persisting acknowledgements or manual
 * status in SQLite would make the disposable index a source of truth.
 */
export function libraryHealth(books: LibraryBook[]): Map<string, BookHealthIssue[]> {
  const issues = new Map(books.map((book) => [book.id, [] as BookHealthIssue[]]));
  const byIsbn = new Map<string, LibraryBook[]>();

  for (const book of books) {
    const bookIssues = issues.get(book.id)!;
    if (!book.metadata.identifier.trim()) {
      bookIssues.push({
        code: 'missing-isbn',
        label: 'No ISBN',
        detail: 'The EPUB has no ISBN available for edition lookup.',
      });
    } else {
      const key = isbnKey(book.metadata.identifier);
      if (key) byIsbn.set(key, [...(byIsbn.get(key) ?? []), book]);
    }
    if (!book.hasCover) {
      bookIssues.push({
        code: 'missing-cover',
        label: 'No cover',
        detail: 'The EPUB has no cover image.',
      });
    }
    if (!book.metadata.language.trim()) {
      bookIssues.push({
        code: 'missing-language',
        label: 'No language',
        detail: 'The EPUB does not declare a language.',
      });
    }
    if (looksLikeFilename(book)) {
      bookIssues.push({
        code: 'filename-title',
        label: 'Filename used as title',
        detail: `The title “${book.metadata.title}” still looks like the filename.`,
      });
    }
  }

  for (const duplicates of byIsbn.values()) {
    if (duplicates.length < 2) continue;
    for (const book of duplicates) {
      const others = duplicates
        .filter(({ id }) => id !== book.id)
        .map(({ metadata }) => metadata.title);
      issues.get(book.id)!.push({
        code: 'duplicate-isbn',
        label: 'Duplicate ISBN',
        detail: `Also used by ${others.map((title) => `“${title}”`).join(', ')}.`,
      });
    }
  }

  return issues;
}
