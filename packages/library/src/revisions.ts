import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BookMetadata, BookRevision } from '@calliope/core';
import { makeThumbnail, readEpubFile } from '@calliope/epub';

const REVISION_FILE = /^(\d+)-([a-f0-9]{8})\.epub$/;

interface RevisionSnapshot {
  metadata: BookMetadata;
  hasCover: boolean;
  thumbnail?: Buffer | null;
}

/**
 * Full pre-write EPUB snapshots, stored outside the watched book library.
 *
 * A full EPUB rather than a metadata JSON record makes an undo exact: it also
 * retains the previous cover and every vendor-specific field Calliope promises
 * not to interpret. The bounded history is recoverability, not a second source
 * of truth for the current library state.
 */
export class RevisionStore {
  constructor(
    private readonly dir: string,
    private readonly limit = 10,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async capture(
    bookId: string,
    epubPath: string,
    snapshot?: RevisionSnapshot,
  ): Promise<BookRevision> {
    const bookDir = this.bookDir(bookId);
    await mkdir(bookDir, { recursive: true });

    const id = `${Date.now()}-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const target = path.join(bookDir, `${id}.epub`);
    const temporary = path.join(bookDir, `.${id}.${process.pid}.tmp`);

    try {
      await copyFile(epubPath, temporary);
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }

    const file = await stat(target);
    const revision = snapshot
      ? {
          id,
          createdAt: Number(id.split('-')[0]),
          bytes: file.size,
          metadata: snapshot.metadata,
          hasCover: snapshot.hasCover,
        }
      : await this.describe(target, id);
    await writeFile(path.join(bookDir, `${id}.json`), JSON.stringify(revision));
    if (snapshot?.thumbnail) {
      await writeFile(path.join(bookDir, `${id}.jpg`), snapshot.thumbnail);
    }
    await this.prune(bookDir);
    return revision;
  }

  async list(bookId: string): Promise<BookRevision[]> {
    const bookDir = this.bookDir(bookId);
    let names: string[];
    try {
      names = await readdir(bookDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const revisions = await Promise.all(
      names
        .filter((name) => REVISION_FILE.test(name))
        .map(async (name) => {
          const match = REVISION_FILE.exec(name)!;
          try {
            const id = name.slice(0, -5);
            try {
              return JSON.parse(
                await readFile(path.join(bookDir, `${id}.json`), 'utf8'),
              ) as BookRevision;
            } catch {
              return await this.describe(path.join(bookDir, name), id, Number(match[1]));
            }
          } catch {
            // A damaged history entry must not hide the remaining usable ones.
            return null;
          }
        }),
    );

    return revisions
      .filter((revision): revision is BookRevision => revision !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async read(bookId: string, revisionId: string): Promise<Buffer | null> {
    const revisionPath = this.revisionPath(bookId, revisionId);
    if (!revisionPath) return null;
    try {
      return await readFile(revisionPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async cover(bookId: string, revisionId: string): Promise<Buffer | null> {
    const revisionPath = this.revisionPath(bookId, revisionId);
    if (!revisionPath) return null;
    const thumbnailPath = revisionPath.replace(/\.epub$/, '.jpg');
    try {
      return await readFile(thumbnailPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    try {
      const { cover } = await readEpubFile(revisionPath);
      const thumbnail = cover ? await makeThumbnail(cover) : null;
      if (thumbnail) await writeFile(thumbnailPath, thumbnail);
      return thumbnail;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async describe(
    revisionPath: string,
    id: string,
    createdAt = Number(id.split('-')[0]),
  ): Promise<BookRevision> {
    const [{ metadata, cover }, file] = await Promise.all([
      readEpubFile(revisionPath),
      stat(revisionPath),
    ]);
    return { id, createdAt, bytes: file.size, metadata, hasCover: cover !== null };
  }

  private async prune(bookDir: string): Promise<void> {
    const names = (await readdir(bookDir))
      .filter((name) => REVISION_FILE.test(name))
      .sort()
      .reverse();
    await Promise.all(
      names.slice(this.limit).flatMap((name) => {
        const base = path.join(bookDir, name.slice(0, -5));
        return ['.epub', '.json', '.jpg'].map((extension) =>
          rm(`${base}${extension}`, { force: true }),
        );
      }),
    );
  }

  private bookDir(bookId: string): string {
    if (!/^[a-f0-9]{16}$/.test(bookId)) throw new Error('Invalid book id');
    return path.join(this.dir, bookId);
  }

  private revisionPath(bookId: string, revisionId: string): string | null {
    if (!/^\d+-[a-f0-9]{8}$/.test(revisionId)) return null;
    return path.join(this.bookDir(bookId), `${revisionId}.epub`);
  }
}
