import type {
  BatchJob,
  BatchOperation,
  BatchPlan,
  BatchPlanItem,
  BookRevision,
  BookMetadata,
  CoverCandidate,
  LookupResult,
  MergedBook,
  MetadataUpdate,
  ScanProgress,
  ScanSummary,
} from '@calliope/core';

/**
 * Where the API lives.
 *
 * Empty in the browser: the backend serves this build same-origin, and Vite
 * proxies `/api` in dev. The Android shell has no same-origin backend at all, so
 * it sets `VITE_API_ORIGIN` at build time to the server it should talk to.
 */
const API_ORIGIN = import.meta.env.VITE_API_ORIGIN ?? '';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(pathname: string, init?: RequestInit): Promise<T> {
  // Only a request with a body is JSON. Fastify rejects a bodiless POST that
  // claims to be JSON with a 400 — which is how the Rescan button once failed
  // silently on every click.
  const res = await fetch(`${API_ORIGIN}${pathname}`, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export interface LibraryPage {
  total: number;
  limit: number;
  offset: number;
  scanning: boolean;
  books: MergedBook[];
}

export interface SaveResponse {
  saved: true;
  warnings: string[];
  backupPath: string | null;
  revision: BookRevision;
  bytes: number;
  absRescan: 'ok' | 'failed' | 'skipped';
  book: MergedBook;
}

export interface Status {
  gitSha: string;
  schemaVersion: number;
  library: {
    root: string;
    books: number;
    scanning: boolean;
    scanProgress: ScanProgress | null;
    lastScan: ScanSummary | null;
  };
  audiobookshelf: {
    configured: boolean;
    url?: string;
    /** ABS as a browser reaches it, for "open in Audiobookshelf" links; null when unset. */
    publicUrl?: string | null;
    error?: string | null;
  };
  backupOnSave: boolean;
  revisionLimit: number;
}

export const api = {
  status: () => request<Status>('/api/status'),

  library: (
    params: {
      search?: string;
      sort?: string;
      /** Only books whose file and Audiobookshelf disagree. */
      drift?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '' && value !== false) query.set(key, String(value));
    }
    return request<LibraryPage>(`/api/library?${query}`);
  },

  book: (id: string) => request<MergedBook>(`/api/books/${id}`),

  useFileMetadataInAbs: (id: string, fields: string[]) =>
    request<{ updated: true; book: MergedBook }>(`/api/books/${id}/audiobookshelf`, {
      method: 'PATCH',
      body: JSON.stringify({ fields }),
    }),

  refreshAbs: () => request<{ refreshed: true }>('/api/abs/refresh', { method: 'POST' }),

  scan: (force = false) =>
    request<{ started: boolean }>(`/api/library/scan?force=${force}`, { method: 'POST' }),

  save: (
    id: string,
    metadata: MetadataUpdate,
    expectedMtimeMs: number,
    expectedFileSize: number,
    cover?: { url?: string; data?: string; revisionId?: string },
  ) =>
    request<SaveResponse>(`/api/books/${id}/metadata`, {
      method: 'PUT',
      body: JSON.stringify({
        metadata,
        expectedMtimeMs,
        expectedFileSize,
        coverUrl: cover?.url,
        coverData: cover?.data,
        coverRevisionId: cover?.revisionId,
      }),
    }),

  revisions: (id: string) => request<{ revisions: BookRevision[] }>(`/api/books/${id}/revisions`),

  restore: (id: string, revisionId: string, expectedMtimeMs: number, expectedFileSize: number) =>
    request<SaveResponse>(`/api/books/${id}/revisions/${revisionId}/restore`, {
      method: 'POST',
      body: JSON.stringify({ expectedMtimeMs, expectedFileSize }),
    }),

  normalize: (id: string, metadata: BookMetadata) =>
    request<BookMetadata & { _warnings?: string[] }>(`/api/books/${id}/normalize`, {
      method: 'POST',
      body: JSON.stringify({ metadata }),
    }),

  batchPreview: (ids: string[], operation: BatchOperation) =>
    request<BatchPlan>('/api/batch/preview', {
      method: 'POST',
      body: JSON.stringify({ ids, operation }),
    }),

  // Sends back exactly what was reviewed, with the file state each book was
  // reviewed at: the server writes nothing else, and refuses a book that moved.
  batchApply: (label: string, items: BatchPlanItem[]) =>
    request<BatchJob>('/api/batch/apply', {
      method: 'POST',
      body: JSON.stringify({
        label,
        items: items.map(({ id, update, expectedMtimeMs, expectedFileSize }) => ({
          id,
          update,
          expectedMtimeMs,
          expectedFileSize,
        })),
      }),
    }),

  batch: () => request<{ job: BatchJob | null }>('/api/batch'),

  lookupIsbn: (isbn: string) =>
    request<LookupResult>(`/api/lookup/isbn?isbn=${encodeURIComponent(isbn)}`),

  searchTitle: (title: string, author?: string) => {
    const params = new URLSearchParams({ title });
    if (author) params.set('author', author);
    return request<LookupResult>(`/api/lookup/title?${params}`);
  },

  covers: (query: string, isbn?: string) => {
    const params = new URLSearchParams({ query });
    if (isbn) params.set('isbn', isbn);
    return request<{ covers: CoverCandidate[] }>(`/api/lookup/covers?${params}`);
  },

  // `version` is the file's mtime: the URL has to change when the cover does, or
  // an <img> that is already showing it never refetches after a save.
  coverUrl: (id: string, version?: number) =>
    `${API_ORIGIN}/api/books/${id}/cover${version === undefined ? '' : `?v=${version}`}`,
  revisionCoverUrl: (id: string, revisionId: string) =>
    `${API_ORIGIN}/api/books/${id}/revisions/${revisionId}/cover`,
  proxiedCover: (url: string) =>
    `${API_ORIGIN}/api/lookup/cover-proxy?url=${encodeURIComponent(url)}`,
};
