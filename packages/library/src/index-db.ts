import { DatabaseSync } from 'node:sqlite';
import type { AbsBook, BookMetadata, LibraryBook } from '@calliope/core';
import { migrate } from './schema.js';

interface BookRow {
  id: string;
  path: string;
  folder: string;
  file_size: number;
  mtime_ms: number;
  added_at: number;
  epub_version: string;
  metadata: string;
  has_cover: number;
  scanned_at: number;
}

function toBook(row: BookRow): LibraryBook {
  return {
    id: row.id,
    path: row.path,
    folder: row.folder,
    fileSize: row.file_size,
    mtimeMs: row.mtime_ms,
    addedAt: row.added_at,
    epubVersion: row.epub_version,
    metadata: JSON.parse(row.metadata) as BookMetadata,
    hasCover: row.has_cover === 1,
    scannedAt: row.scanned_at,
  };
}

/**
 * `node:sqlite` types every result as `Record<string, SQLOutputValue>`, which
 * does not structurally overlap a row interface, so a direct cast is rejected.
 * The shape is guaranteed by the schema in `schema.ts` and by the SELECT next
 * to each call — these two helpers keep that assertion in one place instead of
 * scattering `as unknown as` through every query.
 */
const asRow = <T>(value: unknown): T | null => (value as T | undefined) ?? null;
const asRows = <T>(values: unknown): T[] => values as T[];

export type LibrarySort = 'title' | 'author' | 'series' | 'added' | 'modified';

export interface ListOptions {
  /** Free-text query across title, author, series and subjects. */
  search?: string;
  sort?: LibrarySort;
  limit?: number;
  offset?: number;
}

/**
 * The library index.
 *
 * Every read is synchronous: `node:sqlite` has no async API, the database is a
 * local file, and a list query over a personal library measures in single-digit
 * milliseconds. Making the callers async would buy nothing and hide that.
 */
export class LibraryIndex {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    // WAL so a scan writing rows never blocks the web app reading them.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    migrate(this.db);
  }

  close(): void {
    this.db.close();
  }

  upsert(book: LibraryBook): void {
    this.db
      .prepare(
        `INSERT INTO books (id, path, folder, file_size, mtime_ms, added_at, epub_version, metadata, has_cover, scanned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           path = excluded.path, folder = excluded.folder, file_size = excluded.file_size,
           mtime_ms = excluded.mtime_ms, added_at = excluded.added_at,
           epub_version = excluded.epub_version,
           metadata = excluded.metadata, has_cover = excluded.has_cover,
           scanned_at = excluded.scanned_at`,
      )
      .run(
        book.id,
        book.path,
        book.folder,
        book.fileSize,
        book.mtimeMs,
        book.addedAt,
        book.epubVersion,
        JSON.stringify(book.metadata),
        book.hasCover ? 1 : 0,
        book.scannedAt,
      );

    this.reindex(book);
  }

  /** Replace the book's search entry. Delete-then-insert: FTS5 has no upsert. */
  private reindex(book: LibraryBook): void {
    this.db.prepare('DELETE FROM books_fts WHERE book_id = ?').run(book.id);
    this.db
      .prepare(
        'INSERT INTO books_fts (book_id, title, author, series, subjects) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        book.id,
        book.metadata.title,
        book.metadata.authors.map((a) => a.name).join(' '),
        book.metadata.series,
        book.metadata.subjects.join(' '),
      );
  }

  get(id: string): LibraryBook | null {
    const row = asRow<BookRow>(this.db.prepare('SELECT * FROM books WHERE id = ?').get(id));
    return row ? toBook(row) : null;
  }

  getByPath(path: string): LibraryBook | null {
    const row = asRow<BookRow>(this.db.prepare('SELECT * FROM books WHERE path = ?').get(path));
    return row ? toBook(row) : null;
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM books WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM books_fts WHERE book_id = ?').run(id);
  }

  allPaths(): Map<string, { id: string; mtimeMs: number; fileSize: number; addedAt: number }> {
    const rows = asRows<{
      id: string;
      path: string;
      mtime_ms: number;
      file_size: number;
      added_at: number;
    }>(this.db.prepare('SELECT id, path, mtime_ms, file_size, added_at FROM books').all());
    return new Map(
      rows.map((r) => [
        r.path,
        { id: r.id, mtimeMs: r.mtime_ms, fileSize: r.file_size, addedAt: r.added_at },
      ]),
    );
  }

  /** Fill in an arrival date without re-parsing the book (see schema v3). */
  setAddedAt(id: string, addedAt: number): void {
    this.db.prepare('UPDATE books SET added_at = ? WHERE id = ?').run(addedAt, id);
  }

  count(search?: string): number {
    if (search?.trim()) {
      return (
        asRow<{ n: number }>(
          this.db
            .prepare('SELECT COUNT(*) AS n FROM books_fts WHERE books_fts MATCH ?')
            .get(ftsQuery(search)),
        )?.n ?? 0
      );
    }
    return asRow<{ n: number }>(this.db.prepare('SELECT COUNT(*) AS n FROM books').get())?.n ?? 0;
  }

  list(options: ListOptions = {}): LibraryBook[] {
    const { search, sort = 'title', limit = 200, offset = 0 } = options;

    // json_extract keeps the sort in SQLite rather than pulling every row into
    // JS to sort it, which is the whole reason the index exists.
    const byTitle = "json_extract(metadata, '$.title') COLLATE NOCASE";
    const byAuthor =
      "COALESCE(NULLIF(TRIM(json_extract(metadata, '$.authors[0].fileAs')), ''), TRIM(json_extract(metadata, '$.author')), '')";
    const bySeries = "TRIM(COALESCE(json_extract(metadata, '$.series'), ''))";
    const bySeriesIndex = "TRIM(COALESCE(json_extract(metadata, '$.seriesIndex'), ''))";
    const orders: Record<LibrarySort, string> = {
      title: byTitle,
      // Sort names put "Le Guin, Ursula" under L when the EPUB provides one.
      // Missing metadata belongs at the end of a browse view, not before A.
      author: `CASE WHEN ${byAuthor} = '' THEN 1 ELSE 0 END, ${byAuthor} COLLATE NOCASE, ${byTitle}`,
      series: `CASE WHEN ${bySeries} = '' THEN 1 ELSE 0 END, ${bySeries} COLLATE NOCASE,
        CASE WHEN ${bySeriesIndex} = '' THEN 2 WHEN ${bySeriesIndex} NOT GLOB '*[^0-9.]*' THEN 0 ELSE 1 END,
        CAST(${bySeriesIndex} AS REAL), ${bySeriesIndex} COLLATE NOCASE, ${byTitle}`,
      // Newest first; title breaks ties so a batch copied in together keeps a
      // stable, readable order.
      added: `added_at DESC, ${byTitle}`,
      modified: `mtime_ms DESC, ${byTitle}`,
    };
    // The sort arrives straight from a query string and is interpolated into
    // SQL, so anything unrecognised falls back to title rather than through.
    const order = orders[sort] ?? byTitle;

    if (search?.trim()) {
      const rows = asRows<BookRow>(
        this.db
          .prepare(
            // `books_fts MATCH ?` must name the table, not a join alias — FTS5
            // does not resolve an alias on the left of MATCH.
            `SELECT b.* FROM books b
             JOIN books_fts ON books_fts.book_id = b.id
             WHERE books_fts MATCH ?
             ORDER BY ${order} LIMIT ? OFFSET ?`,
          )
          .all(ftsQuery(search), limit, offset),
      );
      return rows.map(toBook);
    }

    const rows = asRows<BookRow>(
      this.db.prepare(`SELECT * FROM books ORDER BY ${order} LIMIT ? OFFSET ?`).all(limit, offset),
    );
    return rows.map(toBook);
  }

  // --- Audiobookshelf cache -------------------------------------------------

  putAbs(bookId: string, abs: AbsBook): void {
    this.db
      .prepare(
        `INSERT INTO abs_items (book_id, abs_id, library_id, payload, fetched_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(book_id) DO UPDATE SET
           abs_id = excluded.abs_id, library_id = excluded.library_id,
           payload = excluded.payload, fetched_at = excluded.fetched_at`,
      )
      .run(bookId, abs.id, abs.libraryId, JSON.stringify(abs), Date.now());
  }

  getAbs(bookId: string): AbsBook | null {
    const row = asRow<{ payload: string }>(
      this.db.prepare('SELECT payload FROM abs_items WHERE book_id = ?').get(bookId),
    );
    return row ? (JSON.parse(row.payload) as AbsBook) : null;
  }

  clearAbs(): void {
    this.db.exec('DELETE FROM abs_items');
  }
}

/**
 * Turn user input into an FTS5 query.
 *
 * Every token is quoted and given a prefix `*`, which does two things: it makes
 * "dosto" match "Dostoyevsky" as the user types, and it stops an apostrophe or a
 * bare `-` in a title from being read as FTS5 syntax and throwing.
 */
export function ftsQuery(search: string): string {
  return search
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"*`)
    .join(' ');
}
