import type { LookupError, LookupErrorType } from '@calliope/core';

/**
 * Every lookup failure is classified rather than swallowed, because "no results"
 * and "Google is rate-limiting you" look identical to a user staring at an empty
 * list — and only one of them is worth retrying.
 */
export const API_ERRORS: Record<string, LookupErrorType> = {
  RATE_LIMITED: 'rate_limited',
  NETWORK_ERROR: 'network_error',
  NOT_FOUND: 'not_found',
  SERVER_ERROR: 'server_error',
  TIMEOUT: 'timeout',
};

export class LookupFailure extends Error {
  readonly type: LookupErrorType;
  readonly source: string;

  constructor(type: LookupErrorType, message: string, source: string) {
    super(message);
    this.name = 'LookupFailure';
    this.type = type;
    this.source = source;
  }

  toLookupError(): LookupError {
    return { type: this.type, source: this.source, message: this.message };
  }
}

/**
 * `fetch` with a hard timeout.
 *
 * Node's fetch has no default timeout at all, so a provider that accepts the
 * connection and then stalls holds the whole lookup open indefinitely — and
 * `Promise.allSettled` over three providers waits for the slowest.
 */
export async function fetchWithTimeout(
  url: string,
  source: string,
  options: RequestInit = {},
  timeoutMs = 10000,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new LookupFailure(API_ERRORS.TIMEOUT!, 'Request timed out', source);
    }
    throw new LookupFailure(
      API_ERRORS.NETWORK_ERROR!,
      (err as Error).message || 'Network error',
      source,
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Turn an HTTP status into something worth showing a user. */
export function classifyHttpError(response: Response, source: string): LookupError {
  if (response.status === 429) {
    return {
      type: API_ERRORS.RATE_LIMITED,
      message: `${source}: Rate limited - please try again later`,
      source,
    };
  }
  if (response.status === 404) {
    return { type: API_ERRORS.NOT_FOUND, message: `${source}: No results found`, source };
  }
  if (response.status >= 500) {
    return {
      type: API_ERRORS.SERVER_ERROR,
      message: `${source}: Service temporarily unavailable`,
      source,
    };
  }
  return {
    type: API_ERRORS.SERVER_ERROR,
    message: `${source}: Request failed (${response.status})`,
    source,
  };
}

/** What a provider returns: results, or a classified error — never a throw. */
export type ProviderResult<T> = { ok: true; value: T } | { ok: false; error: LookupError };

export const ok = <T>(value: T): ProviderResult<T> => ({ ok: true, value });
export const fail = <T>(error: LookupError): ProviderResult<T> => ({ ok: false, error });

/** Wrap an unknown thrown value as a LookupError for `source`. */
export function asLookupError(err: unknown, source: string): LookupError {
  if (err instanceof LookupFailure) return err.toLookupError();
  return { source, message: (err as Error)?.message || 'Lookup failed' };
}
