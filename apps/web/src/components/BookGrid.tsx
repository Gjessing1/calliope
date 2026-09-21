import type { JSX } from 'react';
import type { MergedBook } from '@calliope/core';
import { api } from '../api.js';

interface BookGridProps {
  books: MergedBook[];
  /** The active sort; a date sort shows each book's date so the order explains itself. */
  sort: string;
  onSelect: (book: MergedBook) => void;
}

const shortDate = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function BookGrid({ books, sort, onSelect }: BookGridProps): JSX.Element {
  return (
    <ul className="grid">
      {books.map((book) => (
        <li key={book.id}>
          <button type="button" className="card" onClick={() => onSelect(book)}>
            <span className="cover">
              {book.hasCover ? (
                <img src={api.coverUrl(book.id, book.mtimeMs)} alt="" loading="lazy" />
              ) : (
                <span className="cover-placeholder" aria-hidden="true">
                  {book.metadata.title.slice(0, 1) || '?'}
                </span>
              )}
              {/* A book ABS and the file disagree about is the one worth
                  finding, so the badge sits on the cover rather than in a
                  detail panel nobody opens. */}
              {book.absDrift.length > 0 && (
                <span
                  className="badge"
                  title={`Differs from Audiobookshelf: ${book.absDrift.join(', ')}`}
                >
                  {book.absDrift.length}
                </span>
              )}
            </span>
            <span className="card-title">{book.metadata.title || book.folder}</span>
            <span className="card-author">{book.metadata.author || '—'}</span>
            {book.metadata.series && (
              <span className="card-series">
                {book.metadata.series}
                {book.metadata.seriesIndex ? ` #${book.metadata.seriesIndex}` : ''}
              </span>
            )}
            {sort === 'added' && book.addedAt > 0 && (
              <span className="card-date">Added {shortDate(book.addedAt)}</span>
            )}
            {sort === 'modified' && (
              <span className="card-date">Modified {shortDate(book.mtimeMs)}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
