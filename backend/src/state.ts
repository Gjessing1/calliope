import { mkdir } from 'node:fs/promises';
import type { MergedBook, ScanSummary } from '@calliope/core';
import {
  AbsClient,
  CoverCache,
  LibraryIndex,
  mergeAbs,
  RevisionStore,
  scanLibrary,
} from '@calliope/library';
import type { Config } from './config.js';
import { coverDir, indexPath, revisionDir } from './config.js';

/**
 * Everything the routes share: the index, the cover cache, the optional ABS
 * client, and whatever the last scan reported.
 *
 * One scan at a time, guarded by `scanning`. Two concurrent scans over the same
 * index would each delete the rows the other had not reached yet, because a
 * scan's removal pass works from the set of paths it did *not* see.
 */
export class AppState {
  readonly index: LibraryIndex;
  readonly covers: CoverCache;
  readonly revisions: RevisionStore;
  readonly abs: AbsClient | null;

  private scanning: Promise<ScanSummary> | null = null;
  private readonly bookWrites = new Map<string, Promise<void>>();
  lastScan: ScanSummary | null = null;
  absError: string | null = null;

  constructor(readonly config: Config) {
    this.index = new LibraryIndex(indexPath(config));
    this.covers = new CoverCache(coverDir(config));
    this.revisions = new RevisionStore(revisionDir(config), config.revisionLimit);
    this.abs = config.abs ? new AbsClient(config.abs) : null;
  }

  static async open(config: Config): Promise<AppState> {
    await mkdir(config.dataDir, { recursive: true });
    const state = new AppState(config);
    await state.covers.init();
    await state.revisions.init();
    return state;
  }

  /** Run a scan, or join the one already running. */
  async scan(force = false): Promise<ScanSummary> {
    if (this.scanning) return this.scanning;

    this.scanning = scanLibrary(this.config.libraryRoot, this.index, this.covers, { force })
      .then(async (summary) => {
        this.lastScan = summary;
        await this.refreshAbs();
        return summary;
      })
      .finally(() => {
        this.scanning = null;
      });

    return this.scanning;
  }

  get isScanning(): boolean {
    return this.scanning !== null;
  }

  /** Serialize capture + write + reindex for one book so every undo point is real. */
  async writeBook<T>(bookId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.bookWrites.get(bookId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.bookWrites.set(bookId, tail);
    try {
      return await current;
    } finally {
      if (this.bookWrites.get(bookId) === tail) this.bookWrites.delete(bookId);
    }
  }

  /**
   * Refresh the cached Audiobookshelf view.
   *
   * A failure is recorded and swallowed: ABS being unreachable must degrade the
   * UI to "file metadata only", never break a scan or a page load.
   */
  async refreshAbs(): Promise<void> {
    if (!this.abs) return;
    try {
      const items = await this.abs.allItems();
      this.index.clearAbs();
      for (const book of this.index.list({ limit: Number.MAX_SAFE_INTEGER })) {
        // ABS keys a book by its folder; Calliope keys it by the epub file.
        const match = items.get(book.folder) ?? items.get(book.path);
        if (match) this.index.putAbs(book.id, match);
      }
      this.absError = null;
    } catch (err) {
      this.absError = (err as Error).message;
    }
  }

  /** Attach the cached ABS record and drift report to a book. */
  merge(book: Parameters<typeof mergeAbs>[0]): MergedBook {
    return mergeAbs(book, this.abs ? this.index.getAbs(book.id) : null);
  }

  close(): void {
    this.index.close();
  }
}
