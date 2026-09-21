import type { BookMetadata, MetadataUpdate } from './metadata.js';

/**
 * One EPUB in the library, as the index knows it.
 *
 * `path` is relative to the library root and is the stable identity: the index is
 * a cache of the filesystem, never the other way round, so anything that survives
 * a rescan has to be derivable from the file. `id` is a hash of `path` so the web
 * app can put it in a URL without escaping directory separators.
 */
export interface LibraryBook {
  id: string;
  /** Relative to the library root, POSIX separators. */
  path: string;
  /** The book folder's name — Audiobookshelf's unit of a "book". */
  folder: string;
  fileSize: number;
  /** File mtime in epoch ms; the scanner re-parses only when this moves. */
  mtimeMs: number;
  /**
   * When the book arrived in the library, epoch ms: the birth time of its
   * folder. Read from the filesystem rather than remembered by the index, so a
   * rebuilt index gives every book the same date it had before.
   */
  addedAt: number;
  /** EPUB package version as declared in the OPF, e.g. `2.0` or `3.0`. */
  epubVersion: string;
  metadata: BookMetadata;
  /** True when a cover was extracted into the cover cache. */
  hasCover: boolean;
  /** When this row was last refreshed from the file, epoch ms. */
  scannedAt: number;
}

/** What Audiobookshelf knows about a book, when ABS integration is configured. */
export interface AbsBook {
  /** ABS libraryItem id. */
  id: string;
  libraryId: string;
  /** Path as ABS sees it, inside its own mount (`/books/...`). */
  path: string;
  title: string;
  /** Null in records cached before subtitles were read; treat as none. */
  subtitle?: string | null;
  authors: string[];
  series: Array<{ name: string; sequence: string | null }>;
  narrators: string[];
  publishedYear: string | null;
  publisher: string | null;
  description: string | null;
  genres: string[];
  language: string | null;
  isbn: string | null;
  /** ABS cover route, relative to the ABS origin. */
  coverPath: string | null;
  updatedAt: number;
}

/**
 * A library book with whatever Audiobookshelf knows about it merged alongside.
 *
 * The two are kept side by side rather than flattened: the EPUB file is what
 * Calliope edits, ABS's record is what the user sees in their reader, and the
 * whole point of showing both is to make a disagreement visible.
 */
export interface MergedBook extends LibraryBook {
  abs: AbsBook | null;
  /** Fields where the EPUB and ABS disagree, e.g. `['title', 'series']`. */
  absDrift: string[];
  /** The same disagreements with both sides' values, so a person can choose between them. */
  absDifferences: AbsDifference[];
}

/** One field where the file and Audiobookshelf disagree. */
export interface AbsDifference {
  field: 'title' | 'authors' | 'series' | 'publisher' | 'date' | 'identifier' | 'language';
  label: string;
  /** What the EPUB says, as display text. */
  file: string;
  /** What Audiobookshelf shows, as display text. */
  abs: string;
  /**
   * The edit that would make the file say what Audiobookshelf shows. Null when
   * ABS's value cannot be written into an EPUB as it is — a language *name*
   * where the file needs a code.
   */
  adopt: MetadataUpdate | null;
}

export interface ScanSummary {
  /** Files seen on disk during this scan. */
  seen: number;
  /** Rows inserted (new files). */
  added: number;
  /** Rows re-parsed because the file changed. */
  updated: number;
  /** Rows removed because the file is gone. */
  removed: number;
  /** Rows left alone because mtime and size matched. */
  unchanged: number;
  startedAt: number;
  finishedAt: number;
  errors: Array<{ path: string; message: string }>;
}

/** A recoverable pre-write snapshot kept in Calliope's data directory. */
export interface BookRevision {
  id: string;
  /** When the snapshot was captured, in epoch ms. */
  createdAt: number;
  bytes: number;
  metadata: BookMetadata;
  hasCover: boolean;
  /**
   * Whether this snapshot's cover differs from the book's current one. Set only
   * by the history listing — the one place that has both sides to compare.
   */
  coverChanged?: boolean;
}
