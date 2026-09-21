import type {
  AbsBook,
  BatchOperation,
  BatchPlan,
  BatchPlanItem,
  BookMetadata,
  LibraryBook,
  MetadataField,
  MetadataUpdate,
  TidyPart,
} from '@calliope/core';
import { metadataChanges } from '@calliope/core';
import { normalizeDateFormat, normalizeLanguageCode, stripHTML } from '@calliope/epub';
import { absDifferences } from './merge.js';

/** A library book, with its Audiobookshelf record when there is one. */
export type PlannedBook = LibraryBook & { abs?: AbsBook | null };

const same = (a: string, b: string): boolean =>
  a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/**
 * The metadata as the *file* has it, for comparison.
 *
 * The reader normalizes the language code (`rus` reads as `ru`) and remembers
 * the original in `languageConverted`. Comparing a proposed `ru` against the
 * normalized value would call a book that still says `rus` unchanged — and
 * fixing exactly those codes is what a language batch is for.
 */
const asInFile = (metadata: BookMetadata): BookMetadata => ({
  ...metadata,
  language: metadata.languageConverted ?? metadata.language,
});

/** What the operation would set on one book; unchanged fields are pruned later. */
function propose(operation: BatchOperation, book: PlannedBook, position: number): MetadataUpdate {
  const metadata = book.metadata;
  switch (operation.kind) {
    case 'series': {
      const series = operation.series.trim();
      // Out of a series means out of its numbering too.
      if (!series) return { series: '', seriesIndex: '' };
      if (operation.numbering === 'clear') return { series, seriesIndex: '' };
      if (operation.numbering === 'date') {
        return { series, seriesIndex: String((operation.start ?? 1) + position) };
      }
      return { series };
    }

    case 'language':
      return { language: normalizeLanguageCode(operation.language.trim()).code };

    case 'publisher':
      return { publisher: operation.publisher.trim() };

    case 'subjects': {
      const remove = operation.remove.map((s) => s.trim()).filter(Boolean);
      const kept = metadata.subjects.filter((s) => !remove.some((r) => same(r, s)));
      for (const subject of operation.add.map((s) => s.trim()).filter(Boolean)) {
        if (!kept.some((s) => same(s, subject))) kept.push(subject);
      }
      return { subjects: kept };
    }

    case 'author': {
      const to = operation.to.trim();
      if (!to || !metadata.authors.some((a) => same(a.name, operation.from))) return {};
      return {
        authors: metadata.authors.map((author) =>
          same(author.name, operation.from)
            ? { ...author, name: to, fileAs: operation.fileAs?.trim() || author.fileAs }
            : author,
        ),
      };
    }

    case 'tidy':
      return tidy(metadata, new Set(operation.parts));

    case 'abs': {
      const fields = new Set(operation.fields);
      const update: MetadataUpdate = {};
      for (const difference of absDifferences(book, book.abs ?? null)) {
        if (fields.has(difference.field) && difference.adopt)
          Object.assign(update, difference.adopt);
      }
      return update;
    }
  }
}

/**
 * The same cleanups the editor's Normalize button proposes, restricted to the
 * parts the user picked. Each is meaning-preserving: surrounding whitespace, a
 * description's HTML, a date's shape, a language code's form, duplicate subjects.
 */
function tidy(metadata: BookMetadata, parts: Set<TidyPart>): MetadataUpdate {
  const update: MetadataUpdate = {};
  if (parts.has('whitespace')) {
    for (const key of ['title', 'subtitle', 'publisher', 'rights', 'series'] as const) {
      update[key] = metadata[key].trim().replace(/\s{2,}/g, ' ');
    }
  }
  if (parts.has('description') && metadata.description) {
    update.description = stripHTML(metadata.description);
  }
  if (parts.has('date') && metadata.date) {
    update.date = normalizeDateFormat(metadata.date.trim());
  }
  if (parts.has('language') && metadata.languageConverted) {
    update.language = metadata.language;
  }
  if (parts.has('subjects')) {
    const seen: string[] = [];
    for (const subject of metadata.subjects.map((s) => s.trim()).filter(Boolean)) {
      if (!seen.some((s) => same(s, subject))) seen.push(subject);
    }
    update.subjects = seen;
  }
  return update;
}

/**
 * Problems with the operation as a whole, before any book is looked at: one
 * that makes it meaningless blocks the plan, the rest are notes beside it.
 */
function check(operation: BatchOperation): { blocking: string | null; notes: string[] } {
  switch (operation.kind) {
    case 'language': {
      const { code, warning } = normalizeLanguageCode(operation.language.trim());
      if (!code) return { blocking: 'Enter a language code, such as en, nb or de.', notes: [] };
      return { blocking: null, notes: warning ? [warning] : [] };
    }
    case 'author':
      return {
        blocking:
          !operation.from.trim() || !operation.to.trim()
            ? 'Enter both the name to find and the name to use instead.'
            : null,
        notes: [],
      };
    case 'subjects':
      return {
        blocking: [...operation.add, ...operation.remove].every((s) => !s.trim())
          ? 'Enter a subject to add or remove.'
          : null,
        notes: [],
      };
    case 'tidy':
      return {
        blocking: operation.parts.length === 0 ? 'Pick at least one cleanup.' : null,
        notes: [],
      };
    case 'abs':
      return {
        blocking: operation.fields.length === 0 ? 'Pick at least one field.' : null,
        notes: [],
      };
    default:
      return { blocking: null, notes: [] };
  }
}

/** Numbering by publication date: undated books go last, ties go by title. */
function byDate(a: LibraryBook, b: LibraryBook): number {
  const da = normalizeDateFormat(a.metadata.date.trim());
  const db = normalizeDateFormat(b.metadata.date.trim());
  if (!da !== !db) return da ? -1 : 1;
  return da.localeCompare(db) || a.metadata.title.localeCompare(b.metadata.title);
}

/**
 * Turn one operation over a selection into one reviewable update per book.
 *
 * Nothing here writes. The plan is what the user reviews, and applying it
 * writes exactly the `update` of each item — so every item carries only the
 * fields that actually change, and the file state it was computed against.
 * A book the operation would not change is reported as such rather than
 * rewritten for nothing.
 */
export function planBatch(
  books: PlannedBook[],
  operation: BatchOperation,
): Omit<BatchPlan, 'missing'> {
  const { blocking, notes } = check(operation);
  if (blocking) return { items: [], unchanged: [], warnings: [blocking] };

  const ordered =
    operation.kind === 'series' && operation.numbering === 'date' && operation.series.trim()
      ? [...books].sort(byDate)
      : books;

  const items: BatchPlanItem[] = [];
  const unchanged: BatchPlan['unchanged'] = [];

  ordered.forEach((book, position) => {
    const title = book.metadata.title || book.folder;
    const proposed = propose(operation, book, position);
    const changes = metadataChanges(asInFile(book.metadata), proposed);
    if (changes.length === 0) {
      unchanged.push({ id: book.id, title });
      return;
    }
    const update: MetadataUpdate = {};
    for (const key of new Set<MetadataField>(changes.map((c) => c.key))) {
      (update as Record<string, unknown>)[key] = proposed[key];
    }
    items.push({
      id: book.id,
      title,
      author: book.metadata.author,
      expectedMtimeMs: book.mtimeMs,
      expectedFileSize: book.fileSize,
      update,
      changes,
    });
  });

  return { items, unchanged, warnings: notes };
}
