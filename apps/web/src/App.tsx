import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { BatchJob, MergedBook } from '@calliope/core';
import { api } from './api.js';
import type { Status } from './api.js';
import { BookGrid } from './components/BookGrid.js';
import { BatchEditor } from './components/BatchEditor.js';
import { BookEditor } from './components/BookEditor.js';
import { Toolbar } from './components/Toolbar.js';
import type { LibraryView } from './library-view.js';
import { scanLabel } from './scan-label.js';

export function App(): JSX.Element {
  const [books, setBooks] = useState<MergedBook[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<Status | null>(null);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<LibraryView>('title');
  const [driftOnly, setDriftOnly] = useState(false);
  const [driftCount, setDriftCount] = useState(0);
  const [healthOnly, setHealthOnly] = useState(false);
  const [healthCount, setHealthCount] = useState(0);
  const [selected, setSelected] = useState<MergedBook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Selection survives a change of search, so a batch can be gathered from
  // several searches ("Kafka", then "Hamsun"). Kept as book objects because a
  // selected book may be filtered out of the grid by the current search.
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<Map<string, MergedBook>>(new Map());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [job, setJob] = useState<BatchJob | null>(null);
  const [dismissedJob, setDismissedJob] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      // Group headings must describe the whole result, not whichever 200 books
      // happened to fit in the API's default page. A personal library remains
      // small enough to load, while the loop still respects the API page cap.
      const params = { search, sort: view, drift: driftOnly, health: healthOnly, limit: 1000 };
      const page = await api.library(params);
      const loaded = [...page.books];
      while (loaded.length < page.total) {
        const next = await api.library({ ...params, offset: loaded.length });
        if (next.books.length === 0) break;
        loaded.push(...next.books);
      }
      setBooks(loaded);
      setTotal(page.total);
      setError(null);
      // Counts describe the whole library, whatever the search: they are what
      // tells a person there is something to review at all.
      const [differing, unhealthy] = await Promise.all([
        driftOnly && !healthOnly
          ? page.total
          : (await api.library({ drift: true, limit: 1 }).catch(() => null))?.total,
        healthOnly && !driftOnly
          ? page.total
          : (await api.library({ health: true, limit: 1 }).catch(() => null))?.total,
      ]);
      if (differing !== undefined) setDriftCount(differing);
      if (unhealthy !== undefined) setHealthCount(unhealthy);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [search, view, driftOnly, healthOnly]);

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

  // Keep the selected books' records current after a reload (a batch just
  // changed their mtimes and metadata).
  useEffect(() => {
    setSelection((current) => {
      if (current.size === 0) return current;
      const next = new Map(current);
      for (const book of books) if (next.has(book.id)) next.set(book.id, book);
      return next;
    });
  }, [books]);

  // A batch runs on the server whether or not its sheet is open, and may have
  // been started before this page loaded.
  useEffect(() => {
    void api
      .batch()
      .then(({ job: current }) => {
        if (current && !current.finishedAt) setJob(current);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!job || job.finishedAt) return;
    const timer = setInterval(() => {
      void api
        .batch()
        .then(({ job: next }) => {
          setJob(next);
          if (next?.finishedAt) void reload();
        })
        .catch(() => {});
    }, 700);
    return () => clearInterval(timer);
  }, [job?.id, job?.finishedAt, reload]);

  const toggle = (book: MergedBook, range: boolean): void => {
    setSelecting(true);
    setSelection((current) => {
      const next = new Map(current);
      const from = anchor ? books.findIndex((b) => b.id === anchor) : -1;
      const to = books.findIndex((b) => b.id === book.id);
      if (range && from >= 0 && to >= 0) {
        for (const b of books.slice(Math.min(from, to), Math.max(from, to) + 1)) next.set(b.id, b);
      } else if (next.has(book.id)) {
        next.delete(book.id);
      } else {
        next.set(book.id, book);
      }
      return next;
    });
    setAnchor(book.id);
  };

  const stopSelecting = (): void => {
    setSelecting(false);
    setSelection(new Map());
    setAnchor(null);
  };

  useEffect(() => {
    if (!selecting || batchOpen || selected) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') stopSelecting();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selecting, batchOpen, selected]);

  const shownSelected = books.filter((book) => selection.has(book.id)).length;
  const hiddenSelected = selection.size - shownSelected;
  const currentScanLabel = scanLabel(status?.library.scanProgress);

  const onScan = async (): Promise<void> => {
    try {
      await api.scan();
      const nextStatus = await api.status();
      setStatus(nextStatus);
      // An empty or fully incremental scan can finish before this status read,
      // so there may never be a polling tick to refresh the visible library.
      if (!nextStatus.library.scanning) await reload();
    } catch (err) {
      setError(`Could not start a scan: ${(err as Error).message}`);
    }
  };

  const onSaved = (book: MergedBook): void => {
    setBooks((current) => current.map((b) => (b.id === book.id ? book : b)));
    setSelected(book);
    // A save can move the book in a sorted/filtered view and can add or remove
    // a duplicate-ISBN issue from another book, so refresh the complete view.
    void reload();
  };

  return (
    <div className="app">
      <header className="masthead">
        <h1>
          Calliope
          <span className="masthead-sub">
            {total} {total === 1 ? 'book' : 'books'}
            {status?.library.scanning ? ` · ${currentScanLabel.toLowerCase()}` : ''}
          </span>
        </h1>
      </header>

      <Toolbar
        search={search}
        view={view}
        onSearch={setSearch}
        onView={setView}
        onScan={onScan}
        scanning={Boolean(status?.library.scanning)}
        scanLabel={currentScanLabel}
        selecting={selecting}
        onSelecting={(on) => (on ? setSelecting(true) : stopSelecting())}
        driftCount={status?.audiobookshelf.configured ? driftCount : 0}
        driftOnly={driftOnly}
        onDriftOnly={setDriftOnly}
        healthCount={healthCount}
        healthOnly={healthOnly}
        onHealthOnly={setHealthOnly}
      />

      {error && <p className="banner banner-error">{error}</p>}
      {status?.audiobookshelf.error && (
        <p className="banner banner-warn">
          Audiobookshelf unreachable: {status.audiobookshelf.error}. Showing file metadata only.
        </p>
      )}

      {job && !batchOpen && job.id !== dismissedJob && (
        <div className="banner batch-banner" role="status">
          {job.finishedAt ? (
            <span>
              “{job.label}” finished: {job.results.filter((r) => r.status === 'saved').length} of{' '}
              {job.total} written
              {job.results.some((r) => r.status !== 'saved') &&
                ' — open the batch again to see what was skipped'}
              .
            </span>
          ) : (
            <span>
              Writing “{job.label}”: {job.results.length} of {job.total}…
            </span>
          )}
          {job.finishedAt && (
            <button
              type="button"
              className="icon"
              aria-label="Dismiss"
              onClick={() => setDismissedJob(job.id)}
            >
              ×
            </button>
          )}
        </div>
      )}

      {loading ? (
        <p className="empty">Loading the library…</p>
      ) : books.length === 0 ? (
        <p className="empty">
          {driftOnly || healthOnly
            ? driftOnly && healthOnly
              ? 'No books match both active filters.'
              : driftOnly
                ? 'Every book agrees with Audiobookshelf.'
                : 'No books need metadata attention.'
            : search
              ? `Nothing matches “${search}”.`
              : 'No books found. Try a scan.'}
        </p>
      ) : (
        <BookGrid
          books={books}
          view={view}
          onSelect={setSelected}
          selecting={selecting}
          selected={selection}
          onToggle={toggle}
        />
      )}

      {selecting && (
        <div className="selection-bar" role="region" aria-label="Selection">
          <span className="selection-count">
            {selection.size === 0 ? 'Tap books to select them' : `${selection.size} selected`}
            {hiddenSelected > 0 && <span className="hint"> · {hiddenSelected} not shown</span>}
          </span>
          <button
            type="button"
            onClick={() => {
              setSelection((current) => {
                const next = new Map(current);
                for (const book of books) next.set(book.id, book);
                return next;
              });
            }}
            disabled={shownSelected === books.length}
          >
            {search ? 'Select all shown' : 'Select all'}
          </button>
          <button type="button" onClick={() => setSelection(new Map())} disabled={!selection.size}>
            Clear
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => setBatchOpen(true)}
            disabled={selection.size === 0}
          >
            Edit together…
          </button>
        </div>
      )}

      {batchOpen && (
        <BatchEditor
          books={[...selection.values()]}
          library={books}
          absConfigured={Boolean(status?.audiobookshelf.configured)}
          job={job}
          onStarted={setJob}
          onClose={() => {
            setBatchOpen(false);
            if (job?.finishedAt) setDismissedJob(job.id);
          }}
        />
      )}

      {selected && (
        <BookEditor
          book={selected}
          absPublicUrl={status?.audiobookshelf.publicUrl ?? null}
          onClose={() => setSelected(null)}
          onBookUpdated={onSaved}
          onAbsRefreshed={async () => {
            await reload();
            setSelected(await api.book(selected.id));
          }}
        />
      )}
    </div>
  );
}
