import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeThumbnail } from '@calliope/epub';

/**
 * The cover cache: one JPEG thumbnail per book, named by book id.
 *
 * Kept outside the library directory on purpose. `/mnt/data/media/books` is what
 * Audiobookshelf watches, and dropping cache files in there would have ABS
 * re-scanning and, worse, possibly adopting them as book assets.
 */
export class CoverCache {
  constructor(private readonly dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  pathFor(bookId: string): string {
    return path.join(this.dir, `${bookId}.jpg`);
  }

  async put(bookId: string, cover: Buffer): Promise<boolean> {
    const thumb = await makeThumbnail(cover);
    if (!thumb) return false;
    await writeFile(this.pathFor(bookId), thumb);
    return true;
  }

  async get(bookId: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(bookId));
    } catch {
      return null;
    }
  }

  async remove(bookId: string): Promise<void> {
    await rm(this.pathFor(bookId), { force: true });
  }
}
