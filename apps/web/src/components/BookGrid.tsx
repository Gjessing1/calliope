import type { JSX, MouseEvent } from 'react';
import type { MergedBook } from '@calliope/core';
import { api } from '../api.js';
import { ApiImage } from './ApiImage.js';
import { groupBooks } from '../library-view.js';
import type { LibraryView } from '../library-view.js';

interface BookGridProps {
  books: MergedBook[];
  /** Author and series are grouped views; date views show the relevant date. */
  view: LibraryView;
  onSelect: (book: MergedBook) => void;
  /** In selection mode a click selects instead of opening the editor. */
  selecting: boolean;
  selected: { has: (id: string) => boolean };
  /** `range` extends the selection from the last book toggled (shift-click). */
  onToggle: (book: MergedBook, range: boolean) => void;
}

const shortDate = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function BookGrid({
  books,
  view,
  onSelect,
  selecting,
  selected,
  onToggle,
}: BookGridProps): JSX.Element {
  const click = (book: MergedBook, event: MouseEvent): void => {
    // Ctrl/Cmd-click starts a selection from outside selection mode, the way a
    // file manager does; shift-click extends one.
    if (selecting || event.ctrlKey || event.metaKey) onToggle(book, event.shiftKey);
    else onSelect(book);
  };

  const cards = (groupBooks: MergedBook[]): JSX.Element[] =>
    groupBooks.map((book) => {
      const isSelected = selected.has(book.id);
      return (
        <li key={book.id}>
          <button
            type="button"
            className={isSelected ? 'card selected' : 'card'}
            onClick={(event) => click(book, event)}
            aria-pressed={selecting ? isSelected : undefined}
          >
            <span className="cover">
              {book.hasCover ? (
                <ApiImage src={api.coverUrl(book.id, book.mtimeMs)} alt="" loading="lazy" />
              ) : (
                <span className="cover-placeholder" aria-hidden="true">
                  {book.metadata.title.slice(0, 1) || '?'}
                </span>
              )}
              {selecting && <span className="check" aria-hidden="true" />}
              {/* A book ABS and the file disagree about is the one worth
                    finding, so the badge sits on the cover rather than in a
                    detail panel nobody opens. */}
              {book.absDrift.length > 0 && (
                <span
                  className="badge"
                  title={[
                    'Differs from Audiobookshelf:',
                    ...(book.absDifferences ?? []).map(
                      (d) => `${d.label}: file “${d.file}” · ABS “${d.abs}”`,
                    ),
                  ].join('\n')}
                >
                  {book.absDrift.length}
                </span>
              )}
            </span>
            <span className="card-title">{book.metadata.title || book.folder}</span>
            <span className="card-author">{book.metadata.author || '—'}</span>
            {book.metadata.series && view !== 'series' && (
              <span className="card-series">
                {book.metadata.series}
                {book.metadata.seriesIndex ? ` #${book.metadata.seriesIndex}` : ''}
              </span>
            )}
            {view === 'series' && book.metadata.seriesIndex && (
              <span className="card-series">Book {book.metadata.seriesIndex}</span>
            )}
            {view === 'added' && book.addedAt > 0 && (
              <span className="card-date">Added {shortDate(book.addedAt)}</span>
            )}
            {view === 'modified' && (
              <span className="card-date">Modified {shortDate(book.mtimeMs)}</span>
            )}
          </button>
        </li>
      );
    });

  const groups = groupBooks(books, view);
  if (!groups) return <ul className={selecting ? 'grid selecting' : 'grid'}>{cards(books)}</ul>;

  return (
    <div className="book-groups">
      {groups.map((group, index) => {
        const headingId = `book-group-${index}`;
        return (
          <section className="book-group" aria-labelledby={headingId} key={group.label}>
            <header className="group-heading">
              <h2 id={headingId}>{group.label}</h2>
              <span>
                {group.books.length} {group.books.length === 1 ? 'book' : 'books'}
              </span>
            </header>
            <ul className={selecting ? 'grid selecting' : 'grid'}>{cards(group.books)}</ul>
          </section>
        );
      })}
    </div>
  );
}
