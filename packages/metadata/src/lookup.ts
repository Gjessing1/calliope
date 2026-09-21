import type { CoverCandidate, LookupError, LookupResult, MetadataCandidate } from '@calliope/core';
import * as google from './providers/google-books.js';
import * as openLibrary from './providers/open-library.js';
import * as itunes from './providers/itunes.js';
import { cleanISBN, convertISBN10to13 } from './isbn.js';

/** Normalize a string for loose comparison: lowercase, no punctuation. */
function normalizeString(str: string | null | undefined): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '');
}

/**
 * Drop duplicates while keeping genuinely different editions.
 *
 * Two results with the same ISBN are the same book. Two results without one are
 * only merged on an exact title *and* author match — different editions of a
 * classic legitimately share a title, and collapsing them would hide the one
 * with the cover the user wanted.
 */
export function deduplicateResults(results: MetadataCandidate[]): MetadataCandidate[] {
  const unique: MetadataCandidate[] = [];
  const seenISBNs = new Set<string>();

  for (const result of results) {
    if (result.isbn) {
      const clean = cleanISBN(result.isbn);
      if (seenISBNs.has(clean)) continue;
      seenISBNs.add(clean);
      unique.push(result);
      continue;
    }

    const isDuplicate = unique.some(
      (existing) =>
        !existing.isbn &&
        normalizeString(existing.title) === normalizeString(result.title) &&
        normalizeString(existing.author) === normalizeString(result.author),
    );
    if (!isDuplicate) unique.push(result);
  }

  return unique;
}

/**
 * Look up a book by ISBN across every source.
 *
 * Always returns both candidates and errors: a source that was rate-limited
 * must be reported even when the other one answered, or the user re-runs the
 * same lookup forever wondering why one provider never appears.
 */
export async function lookupISBN(isbn: string): Promise<LookupResult> {
  if (!isbn) return { candidates: [], errors: [] };

  const clean = cleanISBN(isbn);
  const candidates: MetadataCandidate[] = [];
  const errors: LookupError[] = [];

  const [googleResult, openLibResult] = await Promise.all([
    google.lookupByISBN(clean),
    openLibrary.lookupByISBN(clean),
  ]);

  // Google first: its records are the more complete of the two often enough
  // that presenting it first saves a click.
  if (googleResult.ok) {
    if (googleResult.value) candidates.push({ ...googleResult.value, source: google.SOURCE });
  } else {
    errors.push(googleResult.error);
  }

  if (openLibResult.ok) {
    if (openLibResult.value)
      candidates.push({ ...openLibResult.value, source: openLibrary.SOURCE });
  } else {
    errors.push(openLibResult.error);
  }

  // Older EPUBs carry ISBN-10s that providers only index under the 13-digit
  // form. Worth one extra request when the first pass came back thin.
  if (candidates.length < 2 && clean.length === 10) {
    const alternate = await google.lookupByISBN(convertISBN10to13(clean));
    if (alternate.ok && alternate.value) {
      candidates.push({ ...alternate.value, source: `${google.SOURCE} (ISBN-13)` });
    }
  }

  return { candidates, errors };
}

/**
 * Search by title across every source.
 *
 * Ordering is deliberate: sources that can supply an ISBN come first and Apple
 * Books last, because Apple has no ISBN but the best artwork — useful to reach,
 * never the thing to pick by accident.
 */
export async function searchByTitle(title: string, author?: string): Promise<LookupResult> {
  if (!title) return { candidates: [], errors: [] };

  const errors: LookupError[] = [];
  const [googleResults, openLibResults, itunesResults] = await Promise.all([
    google.searchByTitle(title, author),
    openLibrary.searchByTitle(title, author),
    itunes.searchByTitle(title, author),
  ]);

  const reliable: MetadataCandidate[] = [];

  if (googleResults.ok) {
    reliable.push(...googleResults.value.map((r) => ({ ...r, source: google.SOURCE })));
  } else {
    errors.push(googleResults.error);
  }

  if (openLibResults.ok) {
    reliable.push(...openLibResults.value.map((r) => ({ ...r, source: openLibrary.SOURCE })));
  } else {
    errors.push(openLibResults.error);
  }

  let appleResults: MetadataCandidate[] = [];
  if (itunesResults.ok) {
    appleResults = deduplicateResults(
      itunesResults.value.map((r) => ({ ...r, source: itunes.SOURCE })),
    );
  } else {
    errors.push(itunesResults.error);
  }

  const candidates = [...deduplicateResults(reliable).slice(0, 12), ...appleResults.slice(0, 5)];

  // Stable sort: results carrying an ISBN float to the top, relative order kept
  // within each group so the per-source ordering above survives.
  candidates.sort((a, b) => {
    const aHasISBN = !!a.isbn?.trim();
    const bHasISBN = !!b.isbn?.trim();
    if (aHasISBN && !bHasISBN) return -1;
    if (!aHasISBN && bHasISBN) return 1;
    return 0;
  });

  return { candidates, errors };
}

/**
 * Collect cover options from every source, deduplicated by URL.
 *
 * Capped at 18 — three pages of six in the picker. Past that the results are
 * the same handful of editions again and each one costs a network round-trip
 * in the browser.
 */
export async function searchCovers(query?: string, isbn?: string): Promise<CoverCandidate[]> {
  if (!query && !isbn) return [];

  const covers: CoverCandidate[] = [];

  if (isbn) {
    const clean = cleanISBN(isbn);
    // A UUID identifier cleaned of its dashes is 32 characters — long enough to
    // reject here, or every book without a real ISBN queries for a placeholder.
    if (clean.length >= 10 && clean.length <= 13) {
      covers.push(openLibrary.coverByISBN(clean));
      covers.push(...(await google.searchCovers(`isbn:${clean}`, 3)));
    }
  }

  if (query) {
    const [ol, gb, ap] = await Promise.all([
      openLibrary.searchCovers(query),
      google.searchCovers(query),
      itunes.searchCovers(query),
    ]);
    covers.push(...ol, ...gb, ...ap);
  }

  const seen = new Set<string>();
  return covers.filter((cover) => !seen.has(cover.url) && seen.add(cover.url)).slice(0, 18);
}

/** Download a cover image. Null on any failure — the caller keeps the old one. */
export async function fetchCoverImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}
