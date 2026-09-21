import type { BookMetadata } from '@calliope/core';
import { normalizeLanguageCode } from './language.js';

export interface NormalizedMetadata extends BookMetadata {
  /** Human-readable notes about what normalization changed or could not verify. */
  _warnings?: string[];
}

/**
 * Clean up metadata without changing its meaning: trim, deduplicate, normalize
 * date shape and language code, strip HTML out of the description.
 *
 * Deliberately conservative — this is offered to the user as a reviewable
 * suggestion, not applied on save.
 */
export function normalizeMetadata(metadata: BookMetadata): NormalizedMetadata {
  const normalized = {} as Record<string, unknown>;
  const warnings: string[] = [];

  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string') {
      normalized[key] = value.trim();
    } else if (Array.isArray(value)) {
      // Arrays (subjects) are trimmed, emptied of blanks and deduplicated.
      normalized[key] = [
        ...new Set(value.map((v) => (typeof v === 'string' ? v.trim() : v)).filter(Boolean)),
      ];
    } else {
      normalized[key] = value;
    }
  }

  if (typeof normalized.date === 'string' && normalized.date) {
    normalized.date = normalizeDateFormat(normalized.date);
  }

  if (typeof normalized.description === 'string' && normalized.description) {
    normalized.description = stripHTML(normalized.description);
  }

  if (typeof normalized.language === 'string' && normalized.language) {
    const langResult = normalizeLanguageCode(normalized.language);
    normalized.language = langResult.code;
    if (langResult.warning) warnings.push(langResult.warning);
    if (langResult.converted) {
      warnings.push(`Language code converted: "${langResult.original}" → "${langResult.code}"`);
    }
  }

  const result = normalized as unknown as NormalizedMetadata;
  result._warnings = warnings.length > 0 ? warnings : undefined;
  return result;
}

/**
 * Normalize a date to `YYYY-MM-DD` or `YYYY`.
 *
 * UTC getters, not local ones: a date-only string parses as UTC midnight, so
 * `getDate()` in a western timezone reports the previous day and silently shifts
 * every publication date back by one.
 */
export function normalizeDateFormat(dateStr: string): string {
  if (!dateStr) return '';

  if (/^\d{4}(-\d{2}-\d{2})?$/.test(dateStr)) return dateStr;

  const date = new Date(dateStr);
  if (!isNaN(date.getTime())) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  const yearMatch = dateStr.match(/\d{4}/);
  if (yearMatch) return yearMatch[0];

  return dateStr;
}

/** Strip HTML tags and decode the handful of entities publishers actually use. */
export function stripHTML(html: string): string {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
