import type { AbsBook, AbsDifference, LibraryBook, MergedBook } from '@calliope/core';
import { normalizeLanguageCode } from '@calliope/epub';

/** Loose equality for comparing two systems' idea of the same field. */
function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();
  return norm(a) === norm(b);
}

/** A title as a reader shows it: ABS keeps the subtitle apart, the writer joins them. */
const fullTitle = (title: string, subtitle: string | null | undefined): string =>
  subtitle?.trim() ? `${title}: ${subtitle.trim()}` : title;

/**
 * A BCP 47 language tag's shape. `normalizeLanguageCode` passes a name like
 * "English" through lower-cased and without a warning, so it is checked here.
 */
const LANGUAGE_CODE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

/** Series positions compare as numbers where they are numbers: "1" is "1.0". */
function samePosition(a: string, b: string): boolean {
  const x = Number(a);
  const y = Number(b);
  return a.trim() !== '' && b.trim() !== '' && Number.isFinite(x) && Number.isFinite(y)
    ? x === y
    : sameText(a, b);
}

const seriesText = (name: string, position: string | null | undefined): string =>
  name ? `${name}${position ? ` #${position}` : ''}` : '';

/**
 * Where the EPUB and Audiobookshelf disagree, with both values.
 *
 * The point is not to decide who is right — it is to make a disagreement
 * visible and let the person choose. ABS lets a user override metadata in its
 * own database without touching the file, so a book can read "The Trial" in
 * the app and carry "Der Process" in the OPF indefinitely. Each difference
 * carries the edit that would make the file agree; the other resolution —
 * clearing the override — belongs to ABS.
 *
 * Only fields both systems model are compared, and only where ABS has a value:
 * narrators exist in ABS and have no EPUB equivalent, and an ABS field left
 * empty is more likely unparsed than deliberately blank.
 */
export function absDifferences(book: LibraryBook, abs: AbsBook | null): AbsDifference[] {
  if (!abs) return [];

  const meta = book.metadata;
  const out: AbsDifference[] = [];

  const fileTitle = fullTitle(meta.title, meta.subtitle);
  const absTitle = fullTitle(abs.title, abs.subtitle);
  if (abs.title && !sameText(fileTitle, absTitle)) {
    out.push({
      field: 'title',
      label: 'Title',
      file: fileTitle,
      abs: absTitle,
      adopt: { title: abs.title, subtitle: abs.subtitle ?? '' },
    });
  }

  const fileAuthors = meta.authors.map((a) => a.name);
  if (
    abs.authors.length > 0 &&
    (fileAuthors.length !== abs.authors.length ||
      !fileAuthors.every((name, i) => sameText(name, abs.authors[i])))
  ) {
    out.push({
      field: 'authors',
      label: 'Authors',
      file: fileAuthors.join(', '),
      abs: abs.authors.join(', '),
      // Position by position, so each author keeps the role the file gave it.
      adopt: {
        authors: abs.authors.map((name, i) => ({
          name,
          role: meta.authors[i]?.role ?? 'aut',
          fileAs: meta.authors[i]?.fileAs ?? null,
        })),
      },
    });
  }

  const absSeries = abs.series[0];
  if (
    absSeries?.name &&
    (!sameText(meta.series, absSeries.name) ||
      (absSeries.sequence && !samePosition(meta.seriesIndex, absSeries.sequence)))
  ) {
    out.push({
      field: 'series',
      label: 'Series',
      file: seriesText(meta.series, meta.seriesIndex),
      abs: seriesText(absSeries.name, absSeries.sequence),
      adopt: { series: absSeries.name, seriesIndex: absSeries.sequence ?? meta.seriesIndex },
    });
  }

  if (abs.publisher && !sameText(meta.publisher, abs.publisher)) {
    out.push({
      field: 'publisher',
      label: 'Publisher',
      file: meta.publisher,
      abs: abs.publisher,
      adopt: { publisher: abs.publisher },
    });
  }

  // ABS keeps only a year; compare against the EPUB date's year rather than
  // reporting drift on every book that carries a full date.
  if (abs.publishedYear && meta.date && !meta.date.startsWith(abs.publishedYear)) {
    out.push({
      field: 'date',
      label: 'Date',
      file: meta.date,
      abs: abs.publishedYear,
      adopt: { date: abs.publishedYear },
    });
  }

  // Hyphenation is presentation, not a different ISBN.
  const digits = (v: string) => v.replace(/^urn:isbn:/i, '').replace(/[^0-9X]/gi, '');
  if (abs.isbn && meta.identifier && !sameText(digits(meta.identifier), digits(abs.isbn))) {
    out.push({
      field: 'identifier',
      label: 'ISBN',
      file: meta.identifier,
      abs: abs.isbn,
      adopt: { identifier: abs.isbn },
    });
  }

  // ABS stores language as free text. Compare codes, so `eng` and `en` agree;
  // a name like "English" is shown but not offered for writing, because the
  // file needs a code.
  if (abs.language && meta.language) {
    const theirs = normalizeLanguageCode(abs.language.trim());
    if (!sameText(meta.language, theirs.code)) {
      out.push({
        field: 'language',
        label: 'Language',
        file: meta.languageConverted ?? meta.language,
        abs: abs.language,
        adopt:
          LANGUAGE_CODE.test(theirs.code) && !theirs.warning ? { language: theirs.code } : null,
      });
    }
  }

  return out;
}

/** The fields where the EPUB and Audiobookshelf disagree, e.g. `['title', 'series']`. */
export function absDrift(book: LibraryBook, abs: AbsBook | null): string[] {
  return absDifferences(book, abs).map((difference) => difference.field);
}

/** Attach the ABS record and the disagreements to a library book. */
export function mergeAbs(
  book: LibraryBook,
  abs: AbsBook | null,
  healthIssues: MergedBook['healthIssues'] = [],
): MergedBook {
  const differences = absDifferences(book, abs);
  return {
    ...book,
    abs,
    absDrift: differences.map((difference) => difference.field),
    absDifferences: differences,
    healthIssues,
  };
}
