import type { DatabaseSync } from 'node:sqlite';

/**
 * The index schema.
 *
 * Everything here is derivable from the EPUB files: the index is a cache that
 * makes a large library listable in milliseconds, never a second source of
 * truth. Deleting `calliope.sqlite` and rescanning must lose nothing, which is
 * why no user-authored data lives in it.
 *
 * Migrations are forward-only and idempotent, keyed on `user_version`. There is
 * no down path on purpose: the recovery from a bad migration is to delete the
 * file and rescan, which costs minutes and risks nothing.
 */
const MIGRATIONS: Array<(db: DatabaseSync) => void> = [
  // v1 — books, plus the scan bookkeeping the incremental scan needs.
  (db) => {
    db.exec(`
      CREATE TABLE books (
        id            TEXT PRIMARY KEY,
        path          TEXT NOT NULL UNIQUE,
        folder        TEXT NOT NULL,
        file_size     INTEGER NOT NULL,
        mtime_ms      INTEGER NOT NULL,
        epub_version  TEXT NOT NULL DEFAULT '3.0',
        metadata      TEXT NOT NULL,
        has_cover     INTEGER NOT NULL DEFAULT 0,
        scanned_at    INTEGER NOT NULL
      );

      -- The list view sorts by these three and nothing else so far.
      CREATE INDEX books_folder ON books (folder);
      CREATE INDEX books_scanned_at ON books (scanned_at);

      -- Search over the fields a person actually types: title, author, series,
      -- subjects. FTS5 rather than LIKE because a 5000-book library makes the
      -- difference obvious and the index costs a few hundred KB.
      --
      -- NOT a contentless table (content=''): those reject ordinary DELETE and
      -- UPDATE outright, so every re-index of a changed book would have to
      -- replay the old column values through the 'delete' command. And NOT an
      -- external-content one either, since books is keyed by a TEXT id and
      -- external content needs an INTEGER rowid. Storing the copy costs a few
      -- hundred KB for a personal library and buys a table that behaves.
      --
      -- book_id UNINDEXED is the join key: stored and returned but not
      -- tokenized, so a hex id can never match a search term.
      CREATE VIRTUAL TABLE books_fts USING fts5(
        book_id UNINDEXED, title, author, series, subjects,
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TABLE scans (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at  INTEGER NOT NULL,
        finished_at INTEGER,
        summary     TEXT
      );
    `);
  },

  // v2 — what Audiobookshelf knows, cached beside each book.
  (db) => {
    db.exec(`
      CREATE TABLE abs_items (
        book_id    TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
        abs_id     TEXT NOT NULL,
        library_id TEXT NOT NULL,
        payload    TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
      );
    `);
  },

  // v3 — sort by when a book arrived and when its file last changed. The old
  // "recently scanned" order is gone: every save and re-parse moves scanned_at,
  // so it meant nothing a person would sort by.
  //
  // added_at is 0 on existing rows until the next scan fills it in. The scan
  // backfills unchanged books with a stat of their folder instead of forcing a
  // re-parse of the whole library.
  (db) => {
    db.exec(`
      ALTER TABLE books ADD COLUMN added_at INTEGER NOT NULL DEFAULT 0;
      DROP INDEX IF EXISTS books_scanned_at;
      CREATE INDEX books_added_at ON books (added_at);
      CREATE INDEX books_mtime_ms ON books (mtime_ms);
    `);
  },
];

/** Bring a database up to the current schema. Safe to call on every startup. */
export function migrate(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;

  for (let version = current; version < MIGRATIONS.length; version++) {
    const migration = MIGRATIONS[version];
    if (!migration) continue;
    migration(db);
    db.exec(`PRAGMA user_version = ${version + 1}`);
  }

  return MIGRATIONS.length;
}

export const SCHEMA_VERSION = MIGRATIONS.length;
