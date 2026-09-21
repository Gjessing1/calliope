/** Strip everything that is not an ISBN digit. */
export function cleanISBN(isbn: string): string {
  return isbn.replace(/[^0-9X]/gi, '');
}

export function isISBN10(value: string): boolean {
  return /^\d{9}[\dX]$/i.test(value);
}

export function isISBN13(value: string): boolean {
  return /^(978|979)\d{10}$/.test(value);
}

/**
 * Convert an ISBN-10 to its ISBN-13 form.
 *
 * Worth doing before giving up on a lookup: a provider that has the book under
 * its 13-digit ISBN will return nothing for the 10-digit one, and older EPUBs
 * overwhelmingly carry the 10-digit form.
 */
export function convertISBN10to13(isbn10: string): string {
  const base = `978${isbn10.slice(0, 9)}`;

  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = parseInt(base[i] ?? '0', 10);
    sum += i % 2 === 0 ? digit : digit * 3;
  }

  const checkDigit = (10 - (sum % 10)) % 10;
  return base + checkDigit;
}
