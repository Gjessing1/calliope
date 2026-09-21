/**
 * Validate and sanitize a metadata string before it is written into an OPF.
 *
 * Control characters are stripped (newlines and tabs survive) because they are
 * not legal XML 1.0 characters and an OPF carrying one is rejected outright by
 * some readers. The length cap is an abuse guard, not a spec limit.
 */
export function sanitizeMetadataString(value: unknown, maxLength = 10000): string {
  if (!value || typeof value !== 'string') return '';
  let sanitized = value.trim().substring(0, maxLength);
  // eslint-disable-next-line no-control-regex
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return sanitized;
}
