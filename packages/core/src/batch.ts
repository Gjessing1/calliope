import type { FieldChange } from './diff.js';
import type { AbsDifference } from './library.js';
import type { MetadataUpdate } from './metadata.js';

/** The cleanups a tidy-up batch can apply, each one opt-in. */
export type TidyPart = 'whitespace' | 'description' | 'date' | 'language' | 'subjects';

/**
 * One edit, applied to every book in a selection.
 *
 * An operation describes intent ("put these in series X, numbered by date"),
 * not the per-book result: the plan turns it into one `MetadataUpdate` per book,
 * which is what the user reviews and what gets written.
 */
export type BatchOperation =
  | { kind: 'read'; read: boolean }
  | {
      kind: 'series';
      /** '' takes the books out of their series. */
      series: string;
      /**
       * `keep` leaves each book's number alone, `date` numbers them in order of
       * publication date from `start`, `clear` removes the numbers.
       */
      numbering: 'keep' | 'date' | 'clear';
      start?: number;
    }
  | { kind: 'language'; language: string }
  | { kind: 'publisher'; publisher: string }
  | { kind: 'subjects'; add: string[]; remove: string[] }
  | {
      kind: 'author';
      /** Matched against each author's name, ignoring case and surrounding space. */
      from: string;
      to: string;
      /** Sort name for the renamed author; null keeps the one the file has. */
      fileAs: string | null;
    }
  | { kind: 'tidy'; parts: TidyPart[] }
  /**
   * Make the files say what Audiobookshelf shows, for the fields picked. This
   * resolves a disagreement in ABS's favour; it does not clear ABS's override,
   * which after the write simply agrees with the file.
   */
  | { kind: 'abs'; fields: Array<AbsDifference['field']> };

/** One book's share of a batch: exactly what would be written, and why. */
export interface BatchPlanItem {
  id: string;
  title: string;
  author: string;
  /** The file state the plan was computed against; a write refuses anything newer. */
  expectedMtimeMs: number;
  expectedFileSize: number;
  /** Only the fields that change. Everything else is left undefined — untouched. */
  update: MetadataUpdate;
  changes: FieldChange[];
}

export interface BatchPlan {
  /** Books the operation would change, in the order they would be written. */
  items: BatchPlanItem[];
  /** Books in the selection the operation leaves exactly as they are. */
  unchanged: Array<{ id: string; title: string }>;
  /** Ids in the selection that are not in the library (removed by a rescan). */
  missing: string[];
  /** Problems with the operation itself, e.g. a language code that is not one. */
  warnings: string[];
}

/** The per-book outcome of applying a batch. */
export interface BatchItemResult {
  id: string;
  title: string;
  status: 'saved' | 'conflict' | 'failed' | 'missing';
  message?: string;
  warnings: string[];
}

/**
 * A running or finished batch write.
 *
 * Writes run one book at a time in the background and the client polls: a
 * batch over a library of large EPUBs outlives any sensible HTTP timeout, and
 * the gateway in front of this app has one.
 */
export interface BatchJob {
  id: string;
  /** What the user asked for, in words — shown while it runs and afterwards. */
  label: string;
  startedAt: number;
  finishedAt: number | null;
  total: number;
  results: BatchItemResult[];
  /** Whether Audiobookshelf was asked to rescan once the batch finished. */
  absRescan: 'ok' | 'failed' | 'skipped' | null;
}
