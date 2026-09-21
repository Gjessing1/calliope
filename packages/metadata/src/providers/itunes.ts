import type { CoverCandidate, MetadataCandidate } from '@calliope/core';
import { asLookupError, classifyHttpError, fail, fetchWithTimeout, ok } from '../http.js';
import type { ProviderResult } from '../http.js';

export const SOURCE = 'Apple Books';

interface ItunesResult {
  trackName?: string;
  artistName?: string;
  trackId?: number;
  releaseDate?: string;
  description?: string;
  genres?: string[];
  artworkUrl100?: string;
}

/** The 100px artwork URL rewritten to its 600px form. */
function highResArtwork(url: string): string {
  return url.replace('100x100', '600x600');
}

/**
 * Apple Books has the best cover art of the three sources and no ISBNs at all.
 *
 * `trackId` is an Apple-internal identifier and must never be written to
 * `dc:identifier`, so `isbn` is deliberately null here — a book whose ISBN is an
 * Apple track id is worse than a book with no ISBN, because every later lookup
 * keyed on it silently returns the wrong edition.
 */
export async function searchByTitle(title: string): Promise<ProviderResult<MetadataCandidate[]>> {
  try {
    const res = await fetchWithTimeout(
      `https://itunes.apple.com/search?term=${encodeURIComponent(title)}&media=ebook&entity=ebook&limit=20`,
      SOURCE,
    );
    if (!res.ok) return fail(classifyHttpError(res, SOURCE));

    const data = (await res.json()) as { results?: ItunesResult[] };
    return ok(
      (data.results ?? [])
        .map((item) => ({
          title: item.trackName,
          author: item.artistName,
          isbn: null,
          publisher: null,
          date: item.releaseDate ? item.releaseDate.substring(0, 10) : null,
          description: item.description,
          language: null,
          subjects: item.genres,
          coverUrl: item.artworkUrl100 ? highResArtwork(item.artworkUrl100) : null,
        }))
        .filter((book) => book.title),
    );
  } catch (err) {
    return fail(asLookupError(err, SOURCE));
  }
}

export async function searchCovers(query: string, limit = 8): Promise<CoverCandidate[]> {
  try {
    const res = await fetchWithTimeout(
      `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=ebook&entity=ebook&limit=${limit}`,
      SOURCE,
    );
    if (!res.ok) return [];

    const data = (await res.json()) as { results?: ItunesResult[] };
    return (data.results ?? [])
      .filter((item) => item.artworkUrl100)
      .map((item) => ({
        url: highResArtwork(item.artworkUrl100!),
        source: SOURCE,
        description: item.trackName || 'Title search',
      }));
  } catch {
    return [];
  }
}
