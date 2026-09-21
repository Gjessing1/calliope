import type { CoverCandidate, MetadataCandidate } from '@calliope/core';
import { asLookupError, classifyHttpError, fail, fetchWithTimeout, ok } from '../http.js';
import type { ProviderResult } from '../http.js';

export const SOURCE = 'Google Books';

interface GoogleVolumeInfo {
  title?: string;
  authors?: string[];
  publisher?: string;
  publishedDate?: string;
  description?: string;
  language?: string;
  categories?: string[];
  industryIdentifiers?: Array<{ type: string; identifier: string }>;
  imageLinks?: { thumbnail?: string };
}

interface GoogleVolumesResponse {
  items?: Array<{ volumeInfo?: GoogleVolumeInfo }>;
}

/**
 * Google serves thumbnails at `zoom=1` over plain HTTP. `zoom=0` is the largest
 * size the same endpoint will give, and the HTTPS upgrade is required because a
 * mixed-content image is blocked outright in the browser.
 */
function upgradeThumbnail(url: string): string {
  return url.replace('&zoom=1', '&zoom=0').replace('http://', 'https://');
}

function toCandidate(book: GoogleVolumeInfo): MetadataCandidate {
  const isbn13 = book.industryIdentifiers?.find((id) => id.type === 'ISBN_13')?.identifier;
  const isbn10 = book.industryIdentifiers?.find((id) => id.type === 'ISBN_10')?.identifier;

  return {
    title: book.title,
    author: book.authors?.[0],
    isbn: isbn13 || isbn10,
    publisher: book.publisher,
    date: book.publishedDate,
    description: book.description,
    language: book.language,
    subjects: book.categories,
    coverUrl: book.imageLinks?.thumbnail ? upgradeThumbnail(book.imageLinks.thumbnail) : null,
  };
}

export async function lookupByISBN(
  isbn: string,
): Promise<ProviderResult<MetadataCandidate | null>> {
  try {
    const res = await fetchWithTimeout(
      `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}`,
      SOURCE,
    );
    if (!res.ok) return fail(classifyHttpError(res, SOURCE));

    const data = (await res.json()) as GoogleVolumesResponse;
    const book = data.items?.[0]?.volumeInfo;
    if (!book) return ok(null);

    return ok({ ...toCandidate(book), isbn });
  } catch (err) {
    return fail(asLookupError(err, SOURCE));
  }
}

export async function searchByTitle(
  title: string,
  author?: string,
): Promise<ProviderResult<MetadataCandidate[]>> {
  try {
    const query = [`intitle:${title}`, author ? `inauthor:${author}` : '']
      .filter(Boolean)
      .join(' ');
    const res = await fetchWithTimeout(
      `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=20`,
      SOURCE,
    );
    if (!res.ok) return fail(classifyHttpError(res, SOURCE));

    const data = (await res.json()) as GoogleVolumesResponse;
    const items = data.items ?? [];
    return ok(
      items
        .map((item) => toCandidate(item.volumeInfo ?? {}))
        .filter((book) => book.isbn || book.title),
    );
  } catch (err) {
    return fail(asLookupError(err, SOURCE));
  }
}

export async function searchCovers(query: string, maxResults = 8): Promise<CoverCandidate[]> {
  try {
    const res = await fetchWithTimeout(
      `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
      SOURCE,
    );
    if (!res.ok) return [];

    const data = (await res.json()) as GoogleVolumesResponse;
    return (data.items ?? [])
      .filter((item) => item.volumeInfo?.imageLinks?.thumbnail)
      .map((item) => ({
        url: upgradeThumbnail(item.volumeInfo!.imageLinks!.thumbnail!),
        source: SOURCE,
        description: item.volumeInfo?.title || 'Title search',
      }));
  } catch {
    return [];
  }
}
