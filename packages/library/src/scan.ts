import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { LibraryBook, ScanSummary } from '@calliope/core';
import { bookId, readEpubFile } from '@calliope/epub';
import type { CoverCache } from './covers.js';
import type { LibraryIndex } from './index-db.js';

/** Walk a directory tree and yield every `.epub` path, relative to `root`. */
export async function* findEpubs(root: string, sub = ''): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(path.join(root, sub), { withFileTypes: true });
  } catch {
    // An unreadable directory is skipped rather than fatal: a library on a
    // network mount can have one folder briefly unavailable.
    return;
  }

  for (const entry of entries) {
    // Hidden directories hold the things that are not books: `.stfolder` from
    // Syncthing, `.@__thumb` from a NAS, `@eaDir` from Synology.
    if (entry.name.startsWith('.') || entry.name === '@eaDir') continue;

    const relative = sub ? `${sub}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      yield* findEpubs(root, relative);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.epub')) {
      yield relative;
    }
  }
}

export interface ScanOptions {
  /** Re-parse every book even when mtime and size are unchanged. */
  force?: boolean;
  /** Called after each file, for progress reporting. */
  onProgress?: (seen: number, relativePath: string) => void;
}

/**
 * Bring the index in step with the filesystem.
 *
 * Incremental by mtime *and* size: a metadata edit almost always changes both,
 * and requiring only mtime would miss a file restored from a backup with its
 * timestamp preserved. A full re-parse of a book costs a ZIP open and an XML
 * parse, so skipping unchanged ones is what makes a rescan cheap enough to run
 * on every startup.
 *
 * A book that fails to parse is recorded in `errors` and skipped, never fatal —
 * one corrupt file must not cost the user their whole library listing.
 */
export async function scanLibrary(
  root: string,
  index: LibraryIndex,
  covers: CoverCache,
  options: ScanOptions = {},
): Promise<ScanSummary> {
  const startedAt = Date.now();
  const summary: ScanSummary = {
    seen: 0,
    added: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    startedAt,
    finishedAt: 0,
    errors: [],
  };

  await covers.init();
  const known = index.allPaths();

  for await (const relativePath of findEpubs(root)) {
    summary.seen++;
    options.onProgress?.(summary.seen, relativePath);

    const absolute = path.join(root, relativePath);
    let stats;
    try {
      stats = await stat(absolute);
    } catch (err) {
      summary.errors.push({ path: relativePath, message: (err as Error).message });
      continue;
    }

    const existing = known.get(relativePath);
    known.delete(relativePath);

    if (
      !options.force &&
      existing &&
      existing.mtimeMs === Math.floor(stats.mtimeMs) &&
      existing.fileSize === stats.size
    ) {
      summary.unchanged++;
      continue;
    }

    try {
      const { metadata, version, cover } = await readEpubFile(absolute);
      const id = bookId(relativePath);

      const hasCover = cover ? await covers.put(id, cover) : false;

      const book: LibraryBook = {
        id,
        path: relativePath,
        folder: path.dirname(relativePath) === '.' ? '' : path.dirname(relativePath),
        fileSize: stats.size,
        mtimeMs: Math.floor(stats.mtimeMs),
        epubVersion: version,
        metadata,
        hasCover,
        scannedAt: Date.now(),
      };

      index.upsert(book);
      if (existing) summary.updated++;
      else summary.added++;
    } catch (err) {
      summary.errors.push({ path: relativePath, message: (err as Error).message });
    }
  }

  // Whatever is still in `known` was not found on disk this pass.
  for (const [, entry] of known) {
    index.remove(entry.id);
    await covers.remove(entry.id);
    summary.removed++;
  }

  summary.finishedAt = Date.now();
  return summary;
}
