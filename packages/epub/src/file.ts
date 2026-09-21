import { createHash } from 'node:crypto';
import { rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { MetadataUpdate } from '@calliope/core';
import { extractMetadata, readEpub } from './read.js';
import type { OpenedEpub } from './read.js';
import { writeEpub } from './write.js';
import type { WriteResult } from './write.js';
import { getCoverBuffer } from './cover.js';

/** Open an EPUB from disk. */
export async function openEpubFile(filePath: string): Promise<OpenedEpub> {
  return readEpub(await readFile(filePath));
}

export interface ReadFileResult {
  metadata: ReturnType<typeof extractMetadata>;
  version: string;
  cover: Buffer | null;
}

/** Read the metadata and cover of an EPUB on disk in one pass. */
export async function readEpubFile(filePath: string): Promise<ReadFileResult> {
  const opened = await openEpubFile(filePath);
  return {
    metadata: extractMetadata(opened.meta),
    version: opened.version,
    cover: await getCoverBuffer(opened.zip, opened.opf, opened.opfPath),
  };
}

export interface SaveResult extends WriteResult {
  /** Where the pre-edit file was kept, when `backup` was asked for. */
  backupPath: string | null;
  /** Size of the file now on disk. */
  bytes: number;
}

export interface SaveOptions {
  /** Keep the original alongside the new file as `<name>.epub.bak`. */
  backup?: boolean;
  cover?: Buffer | null;
  /** Exact EPUB bytes to restore instead of applying metadata updates. */
  replacement?: Buffer;
}

/**
 * Apply a metadata edit to an EPUB on disk.
 *
 * The write is atomic: the rebuilt archive goes to a temporary file in the same
 * directory and is only then renamed over the original, so a crash or a full
 * disk leaves the book untouched rather than truncated. This matters more here
 * than it did in epub-editor — that tool handed the user a download and never
 * touched their library, while Calliope edits the only copy, in a directory
 * Audiobookshelf is actively watching.
 *
 * The temp file is written in the *same directory* on purpose: a rename across
 * filesystems is not atomic, and `/mnt/data` is not the same filesystem as the
 * container's `/tmp`.
 */
export async function saveEpubFile(
  filePath: string,
  updates: MetadataUpdate,
  options: SaveOptions = {},
): Promise<SaveResult> {
  // Parsing replacement bytes before touching the library prevents a corrupt
  // history entry from replacing a valid book. Restore still comes through this
  // function so it gets the same same-directory atomic commit as a normal edit.
  const replacement = options.replacement;
  const result = replacement
    ? await (async () => {
        await readEpub(replacement);
        return { buffer: replacement, warnings: [] };
      })()
    : await (async () => {
        const opened = await openEpubFile(filePath);
        return writeEpub(opened.zip, opened.opfPath, opened.opf, updates, options.cover ?? null);
      })();

  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);

  let backupPath: string | null = null;
  try {
    await writeFile(tmpPath, result.buffer);

    if (options.backup) {
      backupPath = `${filePath}.bak`;
      await writeFile(backupPath, await readFile(filePath));
    }

    await rename(tmpPath, filePath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }

  const { size } = await stat(filePath);
  return { ...result, backupPath, bytes: size };
}

/**
 * Stable id for a library path: the first 16 hex of its SHA-256.
 *
 * Derived from the path rather than stored, so the index can be deleted and
 * rebuilt without invalidating a URL someone bookmarked. Short enough to read in
 * a log, long enough that a collision across a personal library is not a concern.
 */
export function bookId(relativePath: string): string {
  return createHash('sha256').update(relativePath).digest('hex').slice(0, 16);
}
