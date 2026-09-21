import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { MergedBook } from '@calliope/core';
import { api } from './api.js';
import type { Status } from './api.js';
import { BookGrid } from './components/BookGrid.js';
import { BookEditor } from './components/BookEditor.js';
import { Toolbar } from './components/Toolbar.js';

export function App(): JSX.Element {
  const [books, setBooks] = useState<MergedBook[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<Status | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('title');
  const [selected, setSelected] = useState<MergedBook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const page = await api.library({ search, sort });
      setBooks(page.books);
      setTotal(page.total);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [search, sort]);

  // Debounced: the search box filters as the user types, and one request per
  // keystroke over a large library is wasted work on both ends.
  useEffect(() => {
    const timer = setTimeout(() => void reload(), 200);
    return () => clearTimeout(timer);
  }, [reload]);

  useEffect(() => {
    void api
      .status()
      .then(setStatus)
      .catch(() => {});
  }, []);

  // While a scan runs the book count keeps moving, so poll until it settles.
  useEffect(() => {
    if (!status?.library.scanning) return;
    const timer = setInterval(() => {
      void api
        .status()
        .then((next) => {
          setStatus(next);
          if (!next.library.scanning) void reload();
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [status?.library.scanning, reload]);

  const onScan = async (): Promise<void> => {
    await api.scan();
    setStatus(await api.status());
  };

  const onSaved = (book: MergedBook): void => {
    setBooks((current) => current.map((b) => (b.id === book.id ? book : b)));
    setSelected(book);
    // A save moves the book in a "recently modified" list; refetch for the order.
    if (sort === 'modified') void reload();
  };

  return (
    <div className="app">
      <header className="masthead">
        <h1>
          Calliope
          <span className="masthead-sub">
            {total} {total === 1 ? 'book' : 'books'}
            {status?.library.scanning ? ' · scanning…' : ''}
          </span>
        </h1>
      </header>

      <Toolbar
        search={search}
        sort={sort}
        onSearch={setSearch}
        onSort={setSort}
        onScan={onScan}
        scanning={Boolean(status?.library.scanning)}
      />

      {error && <p className="banner banner-error">{error}</p>}
      {status?.audiobookshelf.error && (
        <p className="banner banner-warn">
          Audiobookshelf unreachable: {status.audiobookshelf.error}. Showing file metadata only.
        </p>
      )}

      {loading ? (
        <p className="empty">Loading the library…</p>
      ) : books.length === 0 ? (
        <p className="empty">
          {search ? `Nothing matches “${search}”.` : 'No books found. Try a scan.'}
        </p>
      ) : (
        <BookGrid books={books} sort={sort} onSelect={setSelected} />
      )}

      {selected && (
        <BookEditor book={selected} onClose={() => setSelected(null)} onSaved={onSaved} />
      )}
    </div>
  );
}
