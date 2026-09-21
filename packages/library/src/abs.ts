import type { AbsBook } from '@calliope/core';
import type { AbsMetadataPatch } from './abs-update.js';

export interface AbsConfig {
  /** Origin of the Audiobookshelf server, e.g. `http://audiobookshelf:80`. */
  url: string;
  /**
   * An ABS API key (Settings → API Keys). The user's legacy API token also
   * works, but ABS 2.26+ reports it as deprecated.
   */
  token: string;
  /**
   * Where the library root is mounted *inside* the ABS container. The join key
   * between the two systems is the path below this prefix, because Calliope sees
   * `/mnt/data/media/books/X/X.epub` and ABS sees `/books/X` for the same book.
   */
  booksRoot?: string;
  /** Restrict to one ABS library; by default every book library is read. */
  libraryId?: string;
}

interface AbsLibrary {
  id: string;
  name: string;
  mediaType: string;
}

/**
 * A library item in the *expanded* shape (`POST /api/items/batch/get`).
 *
 * The library listing returns a minified shape instead, where authors and
 * series are flattened into display strings ("A, B", "Series #1") — joining on
 * those would report author drift on every multi-author book and never see
 * series drift at all. The listing is used only for ids and paths.
 */
interface AbsLibraryItem {
  id: string;
  libraryId: string;
  path?: string;
  updatedAt?: number;
  media?: {
    coverPath?: string | null;
    metadata?: {
      title?: string;
      subtitle?: string;
      authors?: Array<{ name?: string }>;
      narrators?: string[];
      series?: Array<{ name?: string; sequence?: string | null }>;
      publishedYear?: string;
      publisher?: string;
      description?: string;
      genres?: string[];
      language?: string;
      isbn?: string;
    };
  };
}

interface AbsUpdateResponse {
  updated: boolean;
  libraryItem: AbsLibraryItem;
}

/** Items per `batch/get` request — bounds the request body on a large library. */
const BATCH_SIZE = 100;

/**
 * Read-side client for Audiobookshelf.
 *
 * ABS is an optional integration: with no URL or token configured the backend
 * simply never constructs one, and the library UI shows only what the EPUB
 * files say. Nothing in Calliope may require ABS to be reachable — the files are
 * the source of truth and editing them has to work when the container is down.
 */
export class AbsClient {
  private readonly booksRoot: string;

  constructor(private readonly config: AbsConfig) {
    this.booksRoot = (config.booksRoot ?? '/books').replace(/\/+$/, '');
  }

  private async send(pathname: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(new URL(pathname, this.config.url), {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: 'application/json',
        ...init.headers,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`Audiobookshelf ${pathname} responded ${res.status}`);
    }
    return res;
  }

  private async request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    return (await (await this.send(pathname, init)).json()) as T;
  }

  /** The ABS book libraries, or just the configured one. */
  async libraries(): Promise<AbsLibrary[]> {
    const data = await this.request<{ libraries: AbsLibrary[] }>('/api/libraries');
    const books = data.libraries.filter((l) => l.mediaType === 'book');
    return this.config.libraryId ? books.filter((l) => l.id === this.config.libraryId) : books;
  }

  /**
   * Every item in a library, keyed by its path relative to the books root —
   * which is exactly the key Calliope's own index uses, minus the filename.
   */
  async itemsByRelativePath(libraryId: string): Promise<Map<string, AbsBook>> {
    const listing = await this.request<{ results: Array<{ id: string }> }>(
      `/api/libraries/${libraryId}/items?limit=0`,
    );
    const ids = (listing.results ?? []).map((item) => item.id);

    const byPath = new Map<string, AbsBook>();
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = await this.request<{ libraryItems: AbsLibraryItem[] }>('/api/items/batch/get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ libraryItemIds: ids.slice(i, i + BATCH_SIZE) }),
      });
      for (const item of batch.libraryItems ?? []) {
        const key = this.relativePathOf(item);
        if (key) byPath.set(key, toAbsBook(item));
      }
    }
    return byPath;
  }

  /** Every book ABS knows about, across every library it is asked to read. */
  async allItems(): Promise<Map<string, AbsBook>> {
    const merged = new Map<string, AbsBook>();
    for (const library of await this.libraries()) {
      for (const [key, book] of await this.itemsByRelativePath(library.id)) {
        merged.set(key, book);
      }
    }
    return merged;
  }

  /** Explicitly replace selected ABS metadata fields with values from the EPUB. */
  async updateMetadata(itemId: string, metadata: AbsMetadataPatch): Promise<AbsBook> {
    // ABS wraps the updated item even though its read endpoints return items
    // directly. Treating this response as the item makes its id/libraryId
    // undefined and turns a successful ABS write into a local cache failure.
    const result = await this.request<AbsUpdateResponse>(
      `/api/items/${encodeURIComponent(itemId)}/media`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata }),
      },
    );
    return toAbsBook(result.libraryItem);
  }

  /**
   * Ask ABS to rescan a library.
   *
   * Called after a metadata write so the change shows up in readers immediately.
   * ABS also has a filesystem watcher that would notice eventually, but it is
   * debounced and can be disabled — and a user who just pressed Save should not
   * have to wonder for a minute whether it worked.
   */
  async rescan(libraryId: string): Promise<void> {
    // ABS answers 200 with a plain-text "OK" and scans after responding; there
    // is no JSON to parse, and parsing it would fail every rescan.
    await this.send(`/api/libraries/${libraryId}/scan`, { method: 'POST' });
  }

  /** Rescan every library this client is configured to see. */
  async rescanAll(): Promise<void> {
    for (const library of await this.libraries()) {
      await this.rescan(library.id);
    }
  }

  /**
   * The item's path below the books root, or null when it sits outside it.
   *
   * Not ABS's `relPath`: that is relative to the ABS *library folder*, which
   * matches Calliope's key only when the folder is exactly the books root.
   */
  private relativePathOf(item: AbsLibraryItem): string | null {
    if (!item.path) return null;
    if (!item.path.startsWith(`${this.booksRoot}/`)) return null;
    return item.path.slice(this.booksRoot.length + 1);
  }
}

function toAbsBook(item: AbsLibraryItem): AbsBook {
  const meta = item.media?.metadata ?? {};
  return {
    id: item.id,
    libraryId: item.libraryId,
    path: item.path ?? '',
    title: meta.title ?? '',
    subtitle: meta.subtitle || null,
    authors: (meta.authors ?? []).map((a) => a.name ?? '').filter(Boolean),
    series: (meta.series ?? []).map((s) => ({ name: s.name ?? '', sequence: s.sequence ?? null })),
    narrators: meta.narrators ?? [],
    publishedYear: meta.publishedYear ?? null,
    publisher: meta.publisher ?? null,
    description: meta.description ?? null,
    genres: meta.genres ?? [],
    language: meta.language ?? null,
    isbn: meta.isbn ?? null,
    coverPath: item.media?.coverPath ?? null,
    updatedAt: item.updatedAt ?? 0,
  };
}
