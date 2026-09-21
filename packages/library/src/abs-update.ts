import type { AbsDifference, BookMetadata } from '@calliope/core';

export type AbsField = AbsDifference['field'];

/** The subset of ABS book metadata Calliope can deliberately reconcile. */
export interface AbsMetadataPatch {
  title?: string | null;
  subtitle?: string | null;
  authors?: Array<{ name: string }>;
  series?: Array<{ name: string; sequence: string | null }>;
  publishedYear?: string | null;
  publishedDate?: string | null;
  publisher?: string | null;
  isbn?: string | null;
  language?: string | null;
}

/**
 * Translate selected EPUB fields to ABS's metadata vocabulary. Only selected
 * keys are included: a one-field reconciliation must never overwrite ABS-only
 * data such as narrators, tags, ASIN, or explicit status.
 */
export function absMetadataPatch(metadata: BookMetadata, fields: AbsField[]): AbsMetadataPatch {
  const patch: AbsMetadataPatch = {};
  for (const field of new Set(fields)) {
    switch (field) {
      case 'title':
        patch.title = metadata.title || null;
        patch.subtitle = metadata.subtitle || null;
        break;
      case 'authors':
        patch.authors = metadata.authors.map(({ name }) => ({ name }));
        break;
      case 'series':
        patch.series = metadata.series
          ? [{ name: metadata.series, sequence: metadata.seriesIndex || null }]
          : [];
        break;
      case 'publisher':
        patch.publisher = metadata.publisher || null;
        break;
      case 'date': {
        const year = /^(\d{4})/.exec(metadata.date)?.[1] ?? null;
        patch.publishedYear = year;
        patch.publishedDate = metadata.date || null;
        break;
      }
      case 'identifier':
        patch.isbn = metadata.identifier || null;
        break;
      case 'language':
        patch.language = metadata.language || null;
        break;
    }
  }
  return patch;
}
