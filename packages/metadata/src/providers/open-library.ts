import type { CoverCandidate, MetadataCandidate } from '@calliope/core';
import { asLookupError, classifyHttpError, fail, fetchWithTimeout, ok } from '../http.js';
import type { ProviderResult } from '../http.js';

export const SOURCE = 'Open Library';

interface OpenLibraryBook {
  title?: string;
  subtitle?: string;
  notes?: string;
  authors?: Array<{ name?: string }>;
  publishers?: Array<{ name?: string }>;
  publish_date?: string;
  subjects?: Array<{ name?: string }>;
  languages?: Array<{ key?: string }>;
  cover?: { large?: string; medium?: string; small?: string };
}

interface OpenLibraryDoc {
  title?: string;
  author_name?: string[];
  isbn?: string[];
  publisher?: string[];
  first_publish_year?: number;
  language?: string[];
  cover_i?: number;
}

export async function lookupByISBN(
  isbn: string,
): Promise<ProviderResult<MetadataCandidate | null>> {
  try {
    const res = await fetchWithTimeout(
      `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&format=json&jscmd=data`,
      SOURCE,
    );
    if (!res.ok) return fail(classifyHttpError(res, SOURCE));

    const data = (await res.json()) as Record<string, OpenLibraryBook>;
    const book = data[`ISBN:${isbn}`];
    if (!book) return ok(null);

    // The cover-by-ISBN route always answers, with a 1x1 placeholder when it has
    // nothing — so it is only a fallback, never preferred over a declared cover.
    const coverUrl =
      book.cover?.large ||
      book.cover?.medium ||
      book.cover?.small ||
      `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`;

    return ok({
      title: book.title,
      author: book.authors?.[0]?.name,
      isbn,
      publisher: book.publishers?.[0]?.name,
      date: book.publish_date,
      subjects: book.subjects
        ?.map((s) => s.name ?? '')
        .filter(Boolean)
        .slice(0, 10),
      language: book.languages?.[0]?.key?.replace('/languages/', ''),
      description: book.notes || book.subtitle,
      coverUrl,
    });
  } catch (err) {
    return fail(asLookupError(err, SOURCE));
  }
}

export async function searchByTitle(title: string): Promise<ProviderResult<MetadataCandidate[]>> {
  try {
    const res = await fetchWithTimeout(
      `https://openlibrary.org/search.json?q=${encodeURIComponent(title)}&limit=20`,
      SOURCE,
    );
    if (!res.ok) return fail(classifyHttpError(res, SOURCE));

    const data = (await res.json()) as { docs?: OpenLibraryDoc[] };
    return ok(
      (data.docs ?? [])
        .map((doc) => {
          let coverUrl: string | null = null;
          if (doc.cover_i) {
            coverUrl = `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`;
          } else if (doc.isbn?.[0]) {
            coverUrl = `https://covers.openlibrary.org/b/isbn/${doc.isbn[0]}-M.jpg`;
          }

          return {
            title: doc.title,
            author: doc.author_name?.[0],
            isbn: doc.isbn?.[0],
            publisher: doc.publisher?.[0],
            date: doc.first_publish_year?.toString(),
            language: doc.language?.[0],
            coverUrl,
          };
        })
        .filter((book) => book.isbn || book.title),
    );
  } catch (err) {
    return fail(asLookupError(err, SOURCE));
  }
}

export async function searchCovers(query: string, limit = 10): Promise<CoverCandidate[]> {
  try {
    const res = await fetchWithTimeout(
      `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=${limit}`,
      SOURCE,
    );
    if (!res.ok) return [];

    const data = (await res.json()) as { docs?: OpenLibraryDoc[] };
    return (
      (data.docs ?? [])
        .slice(0, 8)
        // Only `cover_i` proves a real cover exists; an ISBN-derived URL would
        // fill the picker with placeholders.
        .filter((book) => book.cover_i)
        .map((book) => ({
          url: `https://covers.openlibrary.org/b/id/${book.cover_i}-L.jpg`,
          source: SOURCE,
          description: book.title || 'Title search',
        }))
    );
  } catch {
    return [];
  }
}

/** A cover URL derived from an ISBN. Always resolves; may be a placeholder. */
export function coverByISBN(isbn: string): CoverCandidate {
  return {
    url: `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`,
    source: SOURCE,
    description: 'ISBN lookup',
  };
}
