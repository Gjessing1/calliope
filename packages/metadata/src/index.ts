export {
  deduplicateResults,
  fetchCoverImage,
  lookupISBN,
  searchByTitle,
  searchCovers,
} from './lookup.js';
export { cleanISBN, convertISBN10to13, isISBN10, isISBN13 } from './isbn.js';
export { API_ERRORS, LookupFailure, classifyHttpError, fetchWithTimeout } from './http.js';
export type { ProviderResult } from './http.js';
export * as googleBooks from './providers/google-books.js';
export * as openLibrary from './providers/open-library.js';
export * as appleBooks from './providers/itunes.js';
