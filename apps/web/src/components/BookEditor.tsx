import type { ChangeEvent, JSX } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Author,
  BookMetadata,
  BookRevision,
  CoverCandidate,
  MergedBook,
  MetadataCandidate,
  MetadataUpdate,
} from '@calliope/core';
import { api } from '../api.js';

interface BookEditorProps {
  book: MergedBook;
  onClose: () => void;
  onSaved: (book: MergedBook) => void;
}

interface ChangePreview {
  label: string;
  before: string;
  after: string;
}

interface NormalizationSuggestion extends ChangePreview {
  key: keyof MetadataUpdate;
  value: unknown;
}

type CoverChoice =
  | { kind: 'remote'; url: string; label: string }
  | { kind: 'upload'; data: string; label: string }
  | { kind: 'revision'; revisionId: string; label: string };

type Confirmation =
  { kind: 'save' } | { kind: 'restore'; revision: BookRevision } | { kind: 'close' };

const authorObjects = (authors: MetadataUpdate['authors']): Author[] =>
  (authors ?? []).map((author) =>
    typeof author === 'string' ? { name: author, role: 'aut', fileAs: null } : author,
  );

const metadataForm = (metadata: BookMetadata): MetadataUpdate => ({
  title: metadata.title,
  subtitle: metadata.subtitle,
  authors: metadata.authors,
  contributors: metadata.contributors.map((contributor) => contributor.name).join(', '),
  language: metadata.language,
  identifier: metadata.identifier,
  publisher: metadata.publisher,
  date: metadata.date,
  description: metadata.description,
  series: metadata.series,
  seriesIndex: metadata.seriesIndex,
  subjects: metadata.subjects,
});

const displayAuthors = (authors: MetadataUpdate['authors']): string =>
  authorObjects(authors)
    .map(
      (author) =>
        `${author.name}${author.role ? ` (${author.role})` : ''}${author.fileAs ? ` [${author.fileAs}]` : ''}`,
    )
    .join(', ');

const fileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read that image'));
    reader.readAsDataURL(file);
  });

/**
 * The editor always stages changes first. A save requires a second, explicit
 * review action, and the backend captures the old EPUB before accepting it.
 */
export function BookEditor({ book, onClose, onSaved }: BookEditorProps): JSX.Element {
  const [form, setForm] = useState<MetadataUpdate>(() => metadataForm(book.metadata));
  const [candidates, setCandidates] = useState<MetadataCandidate[]>([]);
  const [covers, setCovers] = useState<CoverCandidate[]>([]);
  const [coverChoice, setCoverChoice] = useState<CoverChoice | null>(null);
  const [revisions, setRevisions] = useState<BookRevision[]>([]);
  const [normalization, setNormalization] = useState<NormalizationSuggestion[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  const field = <K extends keyof MetadataUpdate>(key: K, value: MetadataUpdate[K]): void =>
    setForm((current) => ({ ...current, [key]: value }));

  const reloadRevisions = useCallback(async (): Promise<void> => {
    const result = await api.revisions(book.id);
    setRevisions(result.revisions);
  }, [book.id]);

  useEffect(() => {
    void reloadRevisions().catch(() => {
      // History is supplemental; a temporary failure must not block editing.
    });
  }, [reloadRevisions]);

  const changes = useMemo(() => {
    const result: ChangePreview[] = [];
    const compare = (label: string, before: unknown, after: unknown): void => {
      const beforeText = String(before ?? '');
      const afterText = String(after ?? '');
      if (beforeText !== afterText) result.push({ label, before: beforeText, after: afterText });
    };

    compare('Title', book.metadata.title, form.title);
    compare('Subtitle', book.metadata.subtitle, form.subtitle);
    compare('Authors', displayAuthors(book.metadata.authors), displayAuthors(form.authors));
    compare(
      'Contributors',
      book.metadata.contributors.map((contributor) => contributor.name).join(', '),
      form.contributors,
    );
    compare('Series', book.metadata.series, form.series);
    compare('Series number', book.metadata.seriesIndex, form.seriesIndex);
    compare('ISBN', book.metadata.identifier, form.identifier);
    compare('Language', book.metadata.language, form.language);
    compare('Publisher', book.metadata.publisher, form.publisher);
    compare('Date', book.metadata.date, form.date);
    compare('Subjects', book.metadata.subjects.join(', '), (form.subjects ?? []).join(', '));
    compare('Description', book.metadata.description, form.description);
    if (coverChoice) {
      result.push({
        label: 'Cover',
        before: book.hasCover ? 'Current embedded cover' : 'No embedded cover',
        after: coverChoice.label,
      });
    }
    return result;
  }, [book, coverChoice, form]);

  const run = async (label: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(label);
    setMessage(null);
    try {
      await fn();
    } catch (error) {
      setMessage((error as Error).message);
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
        setMessage(result.errors.map((error) => error.message).join(' · '));
      } else if (result.candidates.length === 0) {
        setMessage('No matches found.');
      }
    });

  const findCovers = (): Promise<void> =>
    run('covers', async () => {
      const firstAuthor = authorObjects(form.authors)[0]?.name ?? '';
      const result = await api.covers(`${form.title ?? ''} ${firstAuthor}`.trim(), form.identifier);
      setCovers(result.covers);
      if (result.covers.length === 0) setMessage('No covers found.');
    });

  const previewNormalization = (): Promise<void> =>
    run('normalize', async () => {
      const authors = authorObjects(form.authors);
      const normalized = await api.normalize(book.id, {
        ...book.metadata,
        ...form,
        authors,
        author: authors[0]?.name ?? '',
        // Contributor roles are preserved by the writer; the normalizer does
        // not propose changes for the editor's comma-separated representation.
        contributors: book.metadata.contributors,
        seriesIndex: String(form.seriesIndex ?? ''),
      });
      const fields: Array<[keyof MetadataUpdate, string]> = [
        ['title', 'Title'],
        ['subtitle', 'Subtitle'],
        ['language', 'Language'],
        ['identifier', 'ISBN'],
        ['publisher', 'Publisher'],
        ['date', 'Date'],
        ['description', 'Description'],
        ['series', 'Series'],
        ['seriesIndex', 'Series number'],
        ['subjects', 'Subjects'],
      ];
      const suggestions = fields.flatMap(([key, label]) => {
        const current = form[key];
        const proposed = normalized[key as keyof BookMetadata];
        if (JSON.stringify(current) === JSON.stringify(proposed)) return [];
        const display = (value: unknown): string =>
          Array.isArray(value) ? value.join(', ') : String(value ?? '');
        return [
          {
            key,
            label,
            before: display(current),
            after: display(proposed),
            value: proposed,
          },
        ];
      });
      setNormalization(suggestions);
      setMessage(
        [
          suggestions.length === 0 ? 'No normalization changes suggested.' : '',
          ...(normalized._warnings ?? []),
        ]
          .filter(Boolean)
          .join(' · ') || null,
      );
    });

  const acceptNormalization = (suggestion: NormalizationSuggestion): void => {
    setForm((current) => ({ ...current, [suggestion.key]: suggestion.value }));
    setNormalization((current) => current.filter((item) => item.key !== suggestion.key));
  };

  // This changes only the staged form. The confirmation dialog still shows
  // every resulting difference before anything reaches the file.
  const applyCandidate = (candidate: MetadataCandidate): void => {
    setForm((current) => {
      const authors = authorObjects(current.authors);
      if (candidate.author) {
        const primary = authors.findIndex((author) => author.role === 'aut');
        const replacement = { name: candidate.author, role: 'aut', fileAs: null };
        if (primary >= 0) authors[primary] = replacement;
        else authors.unshift(replacement);
      }
      return {
        ...current,
        title: candidate.title ?? current.title,
        authors,
        identifier: candidate.isbn ?? current.identifier,
        publisher: candidate.publisher ?? current.publisher,
        date: candidate.date ?? current.date,
        description: candidate.description ?? current.description,
        language: candidate.language ?? current.language,
        subjects: candidate.subjects ?? current.subjects,
      };
    });
    if (candidate.coverUrl) {
      setCoverChoice({
        kind: 'remote',
        url: candidate.coverUrl,
        label: `Cover from ${candidate.source}`,
      });
    }
    setCandidates([]);
    setMessage('Loaded into the draft — review the highlighted changes, then save.');
  };

  const updateAuthor = (index: number, update: Partial<Author>): void => {
    const authors = authorObjects(form.authors);
    authors[index] = { ...authors[index]!, ...update };
    field('authors', authors);
  };

  const removeAuthor = (index: number): void => {
    field(
      'authors',
      authorObjects(form.authors).filter((_, authorIndex) => authorIndex !== index),
    );
  };

  const uploadCover = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(file.type)) {
      setMessage('Choose a JPEG, PNG, WebP or AVIF image.');
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setMessage('Cover images must be 15 MB or smaller.');
      return;
    }
    void run('upload', async () => {
      setCoverChoice({ kind: 'upload', data: await fileAsDataUrl(file), label: file.name });
    });
  };

  const coverPayload = (): { url?: string; data?: string; revisionId?: string } | undefined => {
    if (!coverChoice) return undefined;
    if (coverChoice.kind === 'remote') return { url: coverChoice.url };
    if (coverChoice.kind === 'upload') return { data: coverChoice.data };
    return { revisionId: coverChoice.revisionId };
  };

  const save = (): Promise<void> =>
    run('save', async () => {
      const result = await api.save(book.id, form, book.mtimeMs, book.fileSize, coverPayload());
      setForm(metadataForm(result.book.metadata));
      setCoverChoice(null);
      setCovers([]);
      onSaved(result.book);
      await reloadRevisions();
      setMessage(
        [
          'Saved. The previous file is available in history.',
          result.warnings.join(' · '),
          result.absRescan === 'ok' ? 'Audiobookshelf rescanned.' : '',
          result.absRescan === 'failed' ? 'Audiobookshelf rescan failed.' : '',
        ]
          .filter(Boolean)
          .join(' '),
      );
    });

  const restore = (revision: BookRevision): Promise<void> =>
    run('restore', async () => {
      const result = await api.restore(book.id, revision.id, book.mtimeMs, book.fileSize);
      setForm(metadataForm(result.book.metadata));
      setCoverChoice(null);
      setCovers([]);
      onSaved(result.book);
      await reloadRevisions();
      setMessage('Restored. The file you just replaced was saved as a new history entry.');
    });

  const requestClose = (): void => {
    if (changes.length > 0) setConfirmation({ kind: 'close' });
    else onClose();
  };

  const confirm = (): void => {
    const action = confirmation;
    setConfirmation(null);
    if (!action) return;
    if (action.kind === 'close') onClose();
    if (action.kind === 'save') void save();
    if (action.kind === 'restore') void restore(action.revision);
  };

  const chosenCoverPreview =
    coverChoice?.kind === 'remote'
      ? api.proxiedCover(coverChoice.url)
      : coverChoice?.kind === 'upload'
        ? coverChoice.data
        : coverChoice?.kind === 'revision'
          ? api.revisionCoverUrl(book.id, coverChoice.revisionId)
          : null;

  return (
    <div className="sheet-backdrop" onClick={requestClose}>
      <aside className="sheet" onClick={(event) => event.stopPropagation()}>
        <header className="sheet-head">
          <div>
            <h2>{book.metadata.title || book.folder}</h2>
            <p className="path">
              {book.path} · EPUB {book.epubVersion}
            </p>
          </div>
          <button type="button" className="icon" onClick={requestClose} aria-label="Close editor">
            ×
          </button>
        </header>

        {book.absDrift.length > 0 && (
          <p className="banner banner-warn">
            Audiobookshelf shows different {book.absDrift.join(', ')}. Saving here writes the file;
            ABS keeps its override until you clear it there.
          </p>
        )}

        <div className="fields">
          <label>
            Title
            <input
              value={form.title ?? ''}
              onChange={(event) => field('title', event.target.value)}
            />
          </label>
          <label>
            Subtitle
            <input
              value={form.subtitle ?? ''}
              onChange={(event) => field('subtitle', event.target.value)}
            />
          </label>

          <fieldset className="author-editor">
            <legend>Authors and roles</legend>
            {authorObjects(form.authors).map((author, index) => (
              <div className="author-row" key={index}>
                <label>
                  Name
                  <input
                    value={author.name}
                    onChange={(event) => updateAuthor(index, { name: event.target.value })}
                  />
                </label>
                <label>
                  Role
                  <input
                    value={author.role}
                    onChange={(event) => updateAuthor(index, { role: event.target.value })}
                    placeholder="aut, trl, edt…"
                  />
                </label>
                <label>
                  Sort as
                  <input
                    value={author.fileAs ?? ''}
                    onChange={(event) =>
                      updateAuthor(index, { fileAs: event.target.value || null })
                    }
                    placeholder="Surname, Given"
                  />
                </label>
                <button type="button" className="quiet danger" onClick={() => removeAuthor(index)}>
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              className="quiet"
              onClick={() =>
                field('authors', [
                  ...authorObjects(form.authors),
                  { name: '', role: 'aut', fileAs: null },
                ])
              }
            >
              + Add author
            </button>
          </fieldset>

          <label>
            Contributors
            <input
              value={form.contributors ?? ''}
              onChange={(event) => field('contributors', event.target.value)}
              placeholder="Comma separated"
            />
          </label>
          <div className="row">
            <label>
              Series
              <input
                value={form.series ?? ''}
                onChange={(event) => field('series', event.target.value)}
              />
            </label>
            <label className="narrow">
              #
              <input
                value={String(form.seriesIndex ?? '')}
                onChange={(event) => field('seriesIndex', event.target.value)}
              />
            </label>
          </div>
          <div className="row">
            <label>
              ISBN
              <input
                value={form.identifier ?? ''}
                onChange={(event) => field('identifier', event.target.value)}
              />
            </label>
            <label className="narrow">
              Language
              <input
                value={form.language ?? ''}
                onChange={(event) => field('language', event.target.value)}
              />
            </label>
          </div>
          <div className="row">
            <label>
              Publisher
              <input
                value={form.publisher ?? ''}
                onChange={(event) => field('publisher', event.target.value)}
              />
            </label>
            <label className="narrow">
              Date
              <input
                value={form.date ?? ''}
                onChange={(event) => field('date', event.target.value)}
              />
            </label>
          </div>
          <label>
            Subjects
            <input
              value={(form.subjects ?? []).join(', ')}
              onChange={(event) =>
                field(
                  'subjects',
                  event.target.value
                    .split(',')
                    .map((subject) => subject.trim())
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
              onChange={(event) => field('description', event.target.value)}
            />
          </label>
        </div>

        <section className="cover-tools">
          <div className="section-heading">
            <h3>Cover</h3>
            <label className="button-label">
              {busy === 'upload' ? 'Reading…' : 'Upload from device'}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/avif"
                onChange={uploadCover}
                disabled={busy !== null}
              />
            </label>
          </div>
          {chosenCoverPreview && (
            <div className="chosen-cover">
              <img src={chosenCoverPreview} alt="Selected replacement cover" />
              <div>
                <strong>{coverChoice?.label}</strong>
                <span>This will replace the embedded cover only after confirmation.</span>
                <button type="button" className="quiet" onClick={() => setCoverChoice(null)}>
                  Keep current cover
                </button>
              </div>
            </div>
          )}
        </section>

        <div className="actions">
          <button type="button" onClick={() => void lookup()} disabled={busy !== null}>
            {busy === 'lookup' ? 'Looking up…' : form.identifier ? 'Look up ISBN' : 'Search title'}
          </button>
          <button type="button" onClick={() => void findCovers()} disabled={busy !== null}>
            {busy === 'covers' ? 'Searching…' : 'Find covers'}
          </button>
          <button
            type="button"
            onClick={() => void previewNormalization()}
            disabled={busy !== null}
          >
            {busy === 'normalize' ? 'Checking…' : 'Normalize'}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => setConfirmation({ kind: 'save' })}
            disabled={busy !== null || changes.length === 0}
          >
            Review {changes.length || ''} {changes.length === 1 ? 'change' : 'changes'}
          </button>
        </div>

        {message && <p className="banner">{message}</p>}

        {normalization.length > 0 && (
          <section className="normalization">
            <h3>Normalization suggestions</h3>
            <p className="hint">Accept only the cleanup changes you want in the draft.</p>
            <ul>
              {normalization.map((suggestion) => (
                <li key={suggestion.key}>
                  <div>
                    <strong>{suggestion.label}</strong>
                    <span>{suggestion.before || 'Empty'}</span>
                    <b aria-hidden="true">→</b>
                    <span>{suggestion.after || 'Empty'}</span>
                  </div>
                  <button type="button" onClick={() => acceptNormalization(suggestion)}>
                    Accept
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {candidates.length > 0 && (
          <section className="candidates">
            <h3>Matches</h3>
            <p className="hint">
              Choosing a match only updates this draft; it does not write the book.
            </p>
            <ul>
              {candidates.map((candidate, index) => (
                <li key={`${candidate.isbn ?? candidate.title}-${index}`}>
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
            <h3>Search results</h3>
            <ul>
              {covers.map((cover) => (
                <li key={cover.url}>
                  <button
                    type="button"
                    className={
                      coverChoice?.kind === 'remote' && coverChoice.url === cover.url
                        ? 'chosen'
                        : ''
                    }
                    onClick={() =>
                      setCoverChoice({
                        kind: 'remote',
                        url: cover.url,
                        label: `${cover.source}: ${cover.description}`,
                      })
                    }
                    title={`${cover.source} — ${cover.description}`}
                  >
                    <img src={api.proxiedCover(cover.url)} alt={cover.description} loading="lazy" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="history">
          <div className="section-heading">
            <h3>File history</h3>
            <span className="hint">Recent pre-save EPUBs, outside the book library</span>
          </div>
          {revisions.length === 0 ? (
            <p className="hint">A recovery point will appear here after the first save.</p>
          ) : (
            <ul>
              {revisions.map((revision) => (
                <li key={revision.id}>
                  <div className="history-cover">
                    {revision.hasCover ? (
                      <img src={api.revisionCoverUrl(book.id, revision.id)} alt="" loading="lazy" />
                    ) : (
                      <span aria-hidden="true">Aa</span>
                    )}
                  </div>
                  <div className="history-copy">
                    <strong>{revision.metadata.title || 'Untitled'}</strong>
                    <span>{revision.metadata.author || 'Unknown author'}</span>
                    <time dateTime={new Date(revision.createdAt).toISOString()}>
                      {new Date(revision.createdAt).toLocaleString()}
                    </time>
                  </div>
                  <div className="history-actions">
                    {revision.hasCover && (
                      <button
                        type="button"
                        className="quiet"
                        onClick={() =>
                          setCoverChoice({
                            kind: 'revision',
                            revisionId: revision.id,
                            label: `Cover from ${new Date(revision.createdAt).toLocaleString()}`,
                          })
                        }
                      >
                        Use cover
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setConfirmation({ kind: 'restore', revision })}
                      disabled={busy !== null}
                    >
                      Restore file
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {confirmation && (
          <div className="confirm-backdrop" onClick={() => setConfirmation(null)}>
            <section
              className="confirm-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="confirm-title"
              onClick={(event) => event.stopPropagation()}
            >
              <h3 id="confirm-title">
                {confirmation.kind === 'save'
                  ? 'Write these changes to the EPUB?'
                  : confirmation.kind === 'restore'
                    ? 'Restore this earlier file?'
                    : 'Discard this draft?'}
              </h3>

              {confirmation.kind === 'save' && (
                <>
                  <p>The current EPUB will first be copied to Calliope’s private history.</p>
                  <dl className="change-list">
                    {changes.map((change) => (
                      <div key={change.label}>
                        <dt>{change.label}</dt>
                        <dd>
                          <span>{change.before || 'Empty'}</span>
                          <b aria-hidden="true">→</b>
                          <span>{change.after || 'Empty'}</span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </>
              )}

              {confirmation.kind === 'restore' && (
                <p>
                  This replaces the whole EPUB with the version from{' '}
                  <strong>{new Date(confirmation.revision.createdAt).toLocaleString()}</strong>,
                  including its metadata and cover. The current file will be saved first, so this
                  restore can also be undone.
                </p>
              )}

              {confirmation.kind === 'close' && (
                <p>
                  {changes.length} staged {changes.length === 1 ? 'change' : 'changes'} will be
                  lost.
                </p>
              )}

              <div className="dialog-actions">
                <button type="button" onClick={() => setConfirmation(null)} autoFocus>
                  Cancel
                </button>
                <button
                  type="button"
                  className={confirmation.kind === 'close' ? 'danger' : 'primary'}
                  onClick={confirm}
                >
                  {confirmation.kind === 'save'
                    ? 'Write to file'
                    : confirmation.kind === 'restore'
                      ? 'Restore this version'
                      : 'Discard draft'}
                </button>
              </div>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}
