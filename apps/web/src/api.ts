import type {
  CoverCandidate,
  LookupResult,
  MergedBook,
  MetadataUpdate,
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
  const res = await fetch(`${API_ORIGIN}${pathname}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
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
    lastScan: ScanSummary | null;
  };
  audiobookshelf: { configured: boolean; url?: string; error?: string | null };
  backupOnSave: boolean;
}

export const api = {
  status: () => request<Status>('/api/status'),

  library: (params: { search?: string; sort?: string; limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') query.set(key, String(value));
    }
    return request<LibraryPage>(`/api/library?${query}`);
  },

  book: (id: string) => request<MergedBook>(`/api/books/${id}`),

  scan: (force = false) =>
    request<{ started: boolean }>(`/api/library/scan?force=${force}`, { method: 'POST' }),

  save: (id: string, metadata: MetadataUpdate, coverUrl?: string) =>
    request<SaveResponse>(`/api/books/${id}/metadata`, {
      method: 'PUT',
      body: JSON.stringify({ metadata, coverUrl }),
    }),

  normalize: (id: string) =>
    request<Record<string, unknown>>(`/api/books/${id}/normalize`, { method: 'POST' }),

  lookupIsbn: (isbn: string) =>
    request<LookupResult>(`/api/lookup/isbn?isbn=${encodeURIComponent(isbn)}`),

  searchTitle: (title: string) =>
    request<LookupResult>(`/api/lookup/title?title=${encodeURIComponent(title)}`),

  covers: (query: string, isbn?: string) => {
    const params = new URLSearchParams({ query });
    if (isbn) params.set('isbn', isbn);
    return request<{ covers: CoverCandidate[] }>(`/api/lookup/covers?${params}`);
  },

  coverUrl: (id: string) => `${API_ORIGIN}/api/books/${id}/cover`,
  proxiedCover: (url: string) =>
    `${API_ORIGIN}/api/lookup/cover-proxy?url=${encodeURIComponent(url)}`,
};
