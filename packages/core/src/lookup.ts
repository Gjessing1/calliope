/** A metadata proposal from an external source. Never written without user review. */
export interface MetadataCandidate {
  title?: string;
  author?: string;
  /** Null when the source has no ISBN — Apple Books never does. */
  isbn?: string | null;
  publisher?: string | null;
  date?: string | null;
  description?: string | null;
  language?: string | null;
  subjects?: string[];
  coverUrl?: string | null;
  /** Human-readable provider name, shown in the picker. */
  source?: string;
}

export interface CoverCandidate {
  url: string;
  source: string;
  description: string;
}

export type LookupErrorType =
  'rate_limited' | 'network_error' | 'not_found' | 'server_error' | 'timeout';

export interface LookupError {
  type?: LookupErrorType;
  source: string;
  message: string;
}

/**
 * Lookups always return this shape, even on partial failure: a source that is
 * down must not silently disappear behind the two that answered.
 */
export interface LookupResult {
  candidates: MetadataCandidate[];
  errors: LookupError[];
}
