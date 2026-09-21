import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { BookRevision, LibraryBook, MetadataUpdate } from '@calliope/core';
import { readEpubFile, saveEpubFile } from '@calliope/epub';
import type { AppState } from './state.js';
import { resolveBookPath } from './paths.js';

/** The file state a client reviewed. A write refuses a file that has moved on since. */
export interface Expected {
  expectedMtimeMs?: number;
  expectedFileSize?: number;
}

export type WriteChange =
  | { metadata: MetadataUpdate; cover?: Buffer | null }
  /** Exact EPUB bytes from history, restored instead of edited. */
  | { replacement: Buffer };

export type WriteOutcome =
  | {
      ok: true;
      warnings: string[];
      backupPath: string | null;
      revision: BookRevision;
      bytes: number;
      book: LibraryBook;
    }
  | { ok: false; code: 400 | 404 | 409; error: string };

const CONFLICT: WriteOutcome = {
  ok: false,
  code: 409,
  error:
    'This book changed after the editor was opened. Close it, review the latest file, and try again.',
};

/** Re-read a book the app just wrote, so the index and cover cache match the file. */
async function refreshAfterWrite(
  state: AppState,
  book: LibraryBook,
  absolute: string,
  bytes: number,
): Promise<void> {
  const [{ metadata, version, cover }, file] = await Promise.all([
    readEpubFile(absolute),
    stat(absolute),
  ]);
  const hasCover = cover ? await state.covers.put(book.id, cover) : false;
  if (!cover) await state.covers.remove(book.id);

  state.index.upsert({
    ...book,
    metadata,
    epubVersion: version,
    fileSize: bytes,
    mtimeMs: file.mtimeMs,
    hasCover,
    scannedAt: Date.now(),
  });
}

/**
 * The one path every write to a book takes — an editor save, a restore, and
 * each book of a batch alike.
 *
 * Serialized per book, so every history entry is a real undo point. Refused
 * when the file is not the one the client reviewed: checked against the index
 * *and* the disk, because another tool (or ABS) can change the file without
 * the index knowing. The complete current EPUB goes into history before the
 * atomic write, so every write can be undone.
 */
export function commitWrite(
  state: AppState,
  bookId: string,
  expected: Expected,
  change: WriteChange,
): Promise<WriteOutcome> {
  return state.writeBook(bookId, async (): Promise<WriteOutcome> => {
    const book = state.index.get(bookId);
    if (!book) return { ok: false, code: 404, error: 'No such book' };
    if (
      (expected.expectedMtimeMs !== undefined && expected.expectedMtimeMs !== book.mtimeMs) ||
      (expected.expectedFileSize !== undefined && expected.expectedFileSize !== book.fileSize)
    ) {
      return CONFLICT;
    }

    const absolute = resolveBookPath(state.config.libraryRoot, book.path);
    if (!absolute) return { ok: false, code: 400, error: 'Book path is outside the library' };
    const file = await stat(absolute);
    if (
      (expected.expectedMtimeMs !== undefined &&
        Math.abs(file.mtimeMs - expected.expectedMtimeMs) > 1) ||
      (expected.expectedFileSize !== undefined && file.size !== expected.expectedFileSize)
    ) {
      return CONFLICT;
    }

    const revision = await state.revisions.capture(book.id, absolute, {
      metadata: book.metadata,
      hasCover: book.hasCover,
      thumbnail: await state.covers.get(book.id),
    });
    const result =
      'replacement' in change
        ? await saveEpubFile(
            absolute,
            {},
            { backup: state.config.backupOnSave, replacement: change.replacement },
          )
        : await saveEpubFile(absolute, change.metadata, {
            backup: state.config.backupOnSave,
            cover: change.cover ?? null,
          });
    await refreshAfterWrite(state, book, absolute, result.bytes);

    return {
      ok: true,
      warnings: result.warnings,
      backupPath: result.backupPath ? path.basename(result.backupPath) : null,
      revision,
      bytes: result.bytes,
      book: state.index.get(book.id)!,
    };
  });
}

/** Ask Audiobookshelf to pick up a write now rather than whenever its watcher does. */
export async function requestAbsRescan(state: AppState): Promise<'ok' | 'failed' | 'skipped'> {
  if (!state.abs || !state.config.abs?.rescanOnSave) return 'skipped';
  try {
    await state.abs.rescanAll();
    return 'ok';
  } catch {
    return 'failed';
  }
}
