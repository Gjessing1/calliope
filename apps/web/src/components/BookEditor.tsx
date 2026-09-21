import type { JSX } from 'react';
import { useState } from 'react';
import type { CoverCandidate, MergedBook, MetadataCandidate, MetadataUpdate } from '@calliope/core';
import { api } from '../api.js';

interface BookEditorProps {
  book: MergedBook;
  onClose: () => void;
  onSaved: (book: MergedBook) => void;
}

/**
 * The metadata editor.
 *
 * Fetched metadata is never applied directly: a candidate is loaded into the
 * form for review first. A wrong ISBN match rewrites the wrong book's title and
 * cover in the user's actual library, and unlike epub-editor there is no
 * "discard the download and try again" — the file on disk is the only copy.
 */
export function BookEditor({ book, onClose, onSaved }: BookEditorProps): JSX.Element {
  const [form, setForm] = useState<MetadataUpdate>({
    title: book.metadata.title,
    subtitle: book.metadata.subtitle,
    author: book.metadata.author,
    authors: book.metadata.authors,
    contributors: book.metadata.contributors.map((c) => c.name).join(', '),
    language: book.metadata.language,
    identifier: book.metadata.identifier,
    publisher: book.metadata.publisher,
    date: book.metadata.date,
    description: book.metadata.description,
    series: book.metadata.series,
    seriesIndex: book.metadata.seriesIndex,
    subjects: book.metadata.subjects,
  });
  const [candidates, setCandidates] = useState<MetadataCandidate[]>([]);
  const [covers, setCovers] = useState<CoverCandidate[]>([]);
  const [chosenCover, setChosenCover] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const field = <K extends keyof MetadataUpdate>(key: K, value: MetadataUpdate[K]): void =>
    setForm((current) => ({ ...current, [key]: value }));

  const run = async (label: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(label);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const lookup = (): Promise<void> =>
    run('lookup', async () => {
      const result = form.identifier
        ? await api.lookupIsbn(form.identifier)
        : await api.searchTitle(form.title ?? '');
      setCandidates(result.candidates);
      if (result.errors.length > 0) {
        setMessage(result.errors.map((e) => e.message).join(' · '));
      } else if (result.candidates.length === 0) {
        setMessage('No matches found.');
      }
    });

  const findCovers = (): Promise<void> =>
    run('covers', async () => {
      const result = await api.covers(
        `${form.title ?? ''} ${form.author ?? ''}`.trim(),
        form.identifier,
      );
      setCovers(result.covers);
      if (result.covers.length === 0) setMessage('No covers found.');
    });

  // Loaded into the form, not saved: the user reviews every field before it
  // touches the file.
  const applyCandidate = (candidate: MetadataCandidate): void => {
    setForm((current) => ({
      ...current,
      title: candidate.title ?? current.title,
      author: candidate.author ?? current.author,
      authors: candidate.author
        ? [{ name: candidate.author, role: 'aut', fileAs: null }]
        : current.authors,
      identifier: candidate.isbn ?? current.identifier,
      publisher: candidate.publisher ?? current.publisher,
      date: candidate.date ?? current.date,
      description: candidate.description ?? current.description,
      language: candidate.language ?? current.language,
      subjects: candidate.subjects ?? current.subjects,
    }));
    if (candidate.coverUrl) setChosenCover(candidate.coverUrl);
    setCandidates([]);
    setMessage('Loaded into the form — review, then save.');
  };

  const save = (): Promise<void> =>
    run('save', async () => {
      const result = await api.save(book.id, form, chosenCover ?? undefined);
      onSaved(result.book);
      setChosenCover(null);
      setMessage(
        [
          'Saved.',
          result.warnings.length > 0 ? result.warnings.join(' · ') : '',
          result.absRescan === 'ok' ? 'Audiobookshelf rescanned.' : '',
          result.absRescan === 'failed' ? 'Audiobookshelf rescan failed.' : '',
        ]
          .filter(Boolean)
          .join(' '),
      );
    });

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <aside className="sheet" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>{book.metadata.title || book.folder}</h2>
          <button type="button" className="icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <p className="path">
          {book.path} · EPUB {book.epubVersion}
        </p>

        {book.absDrift.length > 0 && (
          <p className="banner banner-warn">
            Audiobookshelf shows different {book.absDrift.join(', ')}. Saving here writes the file;
            ABS keeps its own override until you clear it there.
          </p>
        )}

        <div className="fields">
          <label>
            Title
            <input value={form.title ?? ''} onChange={(e) => field('title', e.target.value)} />
          </label>
          <label>
            Subtitle
            <input
              value={form.subtitle ?? ''}
              onChange={(e) => field('subtitle', e.target.value)}
            />
          </label>
          <label>
            Author
            <input value={form.author ?? ''} onChange={(e) => field('author', e.target.value)} />
          </label>
          <label>
            Contributors
            <input
              value={form.contributors ?? ''}
              onChange={(e) => field('contributors', e.target.value)}
              placeholder="Comma separated"
            />
          </label>
          <div className="row">
            <label>
              Series
              <input value={form.series ?? ''} onChange={(e) => field('series', e.target.value)} />
            </label>
            <label className="narrow">
              #
              <input
                value={String(form.seriesIndex ?? '')}
                onChange={(e) => field('seriesIndex', e.target.value)}
              />
            </label>
          </div>
          <div className="row">
            <label>
              ISBN
              <input
                value={form.identifier ?? ''}
                onChange={(e) => field('identifier', e.target.value)}
              />
            </label>
            <label className="narrow">
              Language
              <input
                value={form.language ?? ''}
                onChange={(e) => field('language', e.target.value)}
              />
            </label>
          </div>
          <div className="row">
            <label>
              Publisher
              <input
                value={form.publisher ?? ''}
                onChange={(e) => field('publisher', e.target.value)}
              />
            </label>
            <label className="narrow">
              Date
              <input value={form.date ?? ''} onChange={(e) => field('date', e.target.value)} />
            </label>
          </div>
          <label>
            Subjects
            <input
              value={(form.subjects ?? []).join(', ')}
              onChange={(e) =>
                field(
                  'subjects',
                  e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
            />
          </label>
          <label>
            Description
            <textarea
              rows={6}
              value={form.description ?? ''}
              onChange={(e) => field('description', e.target.value)}
            />
          </label>
        </div>

        <div className="actions">
          <button type="button" onClick={() => void lookup()} disabled={busy !== null}>
            {busy === 'lookup' ? 'Looking up…' : form.identifier ? 'Look up ISBN' : 'Search title'}
          </button>
          <button type="button" onClick={() => void findCovers()} disabled={busy !== null}>
            {busy === 'covers' ? 'Searching…' : 'Find covers'}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void save()}
            disabled={busy !== null}
          >
            {busy === 'save' ? 'Saving…' : 'Save to file'}
          </button>
        </div>

        {message && <p className="banner">{message}</p>}

        {candidates.length > 0 && (
          <section className="candidates">
            <h3>Matches</h3>
            <ul>
              {candidates.map((candidate, i) => (
                <li key={`${candidate.isbn ?? candidate.title}-${i}`}>
                  <button type="button" onClick={() => applyCandidate(candidate)}>
                    <strong>{candidate.title}</strong>
                    <span>
                      {candidate.author ?? '—'} · {candidate.source}
                      {candidate.isbn ? ` · ${candidate.isbn}` : ' · no ISBN'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {covers.length > 0 && (
          <section className="covers">
            <h3>Covers</h3>
            <ul>
              {covers.map((cover) => (
                <li key={cover.url}>
                  <button
                    type="button"
                    className={chosenCover === cover.url ? 'chosen' : ''}
                    onClick={() => setChosenCover(cover.url)}
                    title={`${cover.source} — ${cover.description}`}
                  >
                    <img src={api.proxiedCover(cover.url)} alt={cover.description} loading="lazy" />
                  </button>
                </li>
              ))}
            </ul>
            {chosenCover && <p className="hint">Cover will be replaced on save.</p>}
          </section>
        )}
      </aside>
    </div>
  );
}
