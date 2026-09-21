import type { ChangeEvent, JSX, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AbsDifference,
  Author,
  BookMetadata,
  BookRevision,
  CoverCandidate,
  MergedBook,
  MetadataCandidate,
  MetadataField,
  MetadataUpdate,
} from '@calliope/core';
import { metadataChanges } from '@calliope/core';
import { api } from '../api.js';
import { ChangeList, CoverPair, RevisionDiff, revisionSummary } from './ChangeList.js';

interface BookEditorProps {
  book: MergedBook;
  /** Audiobookshelf as a browser reaches it, for a link to this book there. */
  absPublicUrl: string | null;
  onClose: () => void;
  onBookUpdated: (book: MergedBook) => void;
  /** After Audiobookshelf was re-read: reload this book's comparison. */
  onAbsRefreshed: () => Promise<void>;
}

/** Whether the draft already says what a difference's ABS value would set. */
const adopted = (form: MetadataUpdate, difference: AbsDifference): boolean =>
  !!difference.adopt &&
  Object.entries(difference.adopt).every(
    ([key, value]) =>
      JSON.stringify(authorOrValue(form[key as keyof MetadataUpdate])) ===
      JSON.stringify(authorOrValue(value)),
  );

/** Comparable form of a draft value: authors as objects, numbers as text. */
const authorOrValue = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map((v) => (typeof v === 'string' ? { name: v, role: 'aut', fileAs: null } : v))
    : typeof value === 'number'
      ? String(value)
      : (value ?? '');

interface NormalizationSuggestion {
  key: keyof MetadataUpdate;
  label: string;
  before: string;
  after: string;
  value: unknown;
}

type CoverChoice =
  | { kind: 'remote'; url: string; label: string }
  | { kind: 'upload'; data: string; label: string }
  | { kind: 'revision'; revisionId: string; label: string };

type Confirmation =
  | { kind: 'save' }
  | { kind: 'discard' }
  | { kind: 'close' }
  | { kind: 'restore'; revision: BookRevision }
  | { kind: 'sync-abs'; differences: AbsDifference[] };

/** The draft as it stood before a lookup match was loaded into it. */
interface MatchBase {
  form: MetadataUpdate;
  coverChoice: CoverChoice | null;
}

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

/** Fill a draft from a lookup match. Only what the match knows replaces what the draft has. */
function withMatch(current: MetadataUpdate, candidate: MetadataCandidate): MetadataUpdate {
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
}

const fileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read that image'));
    reader.readAsDataURL(file);
  });

interface FieldProps {
  label: string;
  changed: boolean;
  onRevert: () => void;
  className?: string;
  children: ReactNode;
}

/**
 * A form field that shows when the draft differs from the file, with a way back
 * for that field alone. The Revert button comes after the input on purpose: a
 * label's control is its first labelable descendant, and a button is one.
 */
function Field({ label, changed, onRevert, className, children }: FieldProps): JSX.Element {
  return (
    <label className={['field', className, changed && 'changed'].filter(Boolean).join(' ')}>
      <span className="field-name">{label}</span>
      {children}
      {changed && (
        <button
          type="button"
          className="revert"
          onClick={onRevert}
          title="Put back what the file says"
        >
          Revert
        </button>
      )}
    </label>
  );
}

/**
 * The editor always stages changes first. A save requires a second, explicit
 * review action, and the backend captures the old EPUB before accepting it.
 */
export function BookEditor({
  book,
  absPublicUrl,
  onClose,
  onBookUpdated,
  onAbsRefreshed,
}: BookEditorProps): JSX.Element {
  const [form, setForm] = useState<MetadataUpdate>(() => metadataForm(book.metadata));
  const [candidates, setCandidates] = useState<MetadataCandidate[]>([]);
  const [appliedMatch, setAppliedMatch] = useState<number | null>(null);
  const [matchBase, setMatchBase] = useState<MatchBase | null>(null);
  const [covers, setCovers] = useState<CoverCandidate[]>([]);
  const [coverChoice, setCoverChoice] = useState<CoverChoice | null>(null);
  const [revisions, setRevisions] = useState<BookRevision[]>([]);
  const [comparing, setComparing] = useState<string | null>(null);
  const [normalization, setNormalization] = useState<NormalizationSuggestion[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  const original = useMemo(() => metadataForm(book.metadata), [book.metadata]);
  const changes = useMemo(() => metadataChanges(book.metadata, form), [book.metadata, form]);
  const changed = useMemo(() => new Set<MetadataField>(changes.map((c) => c.key)), [changes]);
  const changeCount = changes.length + (coverChoice ? 1 : 0);

  // Any edit by hand makes a loaded match part of the draft: undoing the match
  // afterwards would silently throw that edit away too. It also retires the
  // footer message, which described the draft before this edit ("Changes
  // discarded" beside "2 unsaved changes" reads as a contradiction).
  const field = <K extends keyof MetadataUpdate>(key: K, value: MetadataUpdate[K]): void => {
    setMatchBase(null);
    setMessage(null);
    setForm((current) => ({ ...current, [key]: value }));
  };

  const fieldState = (key: MetadataField): Pick<FieldProps, 'changed' | 'onRevert'> => ({
    changed: changed.has(key),
    onRevert: () => field(key, original[key]),
  });

  const chooseCover = (choice: CoverChoice | null): void => {
    setMatchBase(null);
    setCoverChoice(choice);
  };

  const reloadRevisions = useCallback(async (): Promise<void> => {
    const result = await api.revisions(book.id);
    setRevisions(result.revisions);
  }, [book.id]);

  useEffect(() => {
    void reloadRevisions().catch(() => {
      // History is supplemental; a temporary failure must not block editing.
    });
  }, [reloadRevisions]);

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

  /** Back to exactly what the file says, with every staged suggestion dropped. */
  const resetDraft = (metadata: BookMetadata): void => {
    setForm(metadataForm(metadata));
    setCoverChoice(null);
    setMatchBase(null);
    setAppliedMatch(null);
    setCandidates([]);
    setCovers([]);
    setNormalization([]);
  };

  const lookup = (): Promise<void> =>
    run('lookup', async () => {
      const result = form.identifier
        ? await api.lookupIsbn(form.identifier)
        : await api.searchTitle(form.title ?? '');
      setCandidates(result.candidates);
      setAppliedMatch(null);
      setMatchBase(null);
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
    setMatchBase(null);
    setForm((current) => ({ ...current, [suggestion.key]: suggestion.value }));
    setNormalization((current) => current.filter((item) => item.key !== suggestion.key));
  };

  // Loading a match changes only the draft. Picking a different match starts
  // again from the draft as it was before the first one, so a misclick is
  // corrected by clicking the right one, or undone outright.
  const applyCandidate = (candidate: MetadataCandidate, index: number): void => {
    const base = matchBase ?? { form, coverChoice };
    setMatchBase(base);
    setForm(withMatch(base.form, candidate));
    setCoverChoice(
      candidate.coverUrl
        ? { kind: 'remote', url: candidate.coverUrl, label: `Cover from ${candidate.source}` }
        : base.coverChoice,
    );
    setAppliedMatch(index);
    setMessage(
      `Loaded the ${candidate.source} match into the draft. Changed fields are marked; nothing is written until you save.`,
    );
  };

  const undoMatch = (): void => {
    if (!matchBase) return;
    setForm(matchBase.form);
    setCoverChoice(matchBase.coverChoice);
    setMatchBase(null);
    setAppliedMatch(null);
    setMessage('Match undone. The draft is back to how it was before it.');
  };

  const closeMatches = (): void => {
    setCandidates([]);
    setAppliedMatch(null);
    setMatchBase(null);
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
      chooseCover({ kind: 'upload', data: await fileAsDataUrl(file), label: file.name });
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
      resetDraft(result.book.metadata);
      setComparing(null);
      onBookUpdated(result.book);
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
      resetDraft(result.book.metadata);
      setComparing(null);
      onBookUpdated(result.book);
      await reloadRevisions();
      setMessage('Restored. The file you just replaced was saved as a new history entry.');
    });

  const discard = (): void => {
    resetDraft(book.metadata);
    setMessage('Changes discarded. The editor shows the file as it is.');
  };

  const requestClose = (): void => {
    if (changeCount > 0) setConfirmation({ kind: 'close' });
    else onClose();
  };

  // Escape backs out one layer: the confirmation first, then the editor (which
  // still asks before throwing a draft away).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || busy) return;
      if (confirmation) setConfirmation(null);
      else if (changeCount > 0) setConfirmation({ kind: 'close' });
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, confirmation, changeCount, onClose]);

  // Taking Audiobookshelf's value stages it like a lookup match: it lands in the
  // draft, marked as changed, and is only written after review.
  const adoptAbs = (differences: AbsDifference[]): void => {
    setMatchBase(null);
    setMessage(null);
    setForm((current) =>
      differences.reduce((next, d) => (d.adopt ? { ...next, ...d.adopt } : next), current),
    );
  };

  const undoAbs = (difference: AbsDifference): void => {
    setForm((current) => {
      const next = { ...current };
      for (const key of Object.keys(difference.adopt ?? {}) as Array<keyof MetadataUpdate>) {
        (next as Record<string, unknown>)[key] = original[key];
      }
      return next;
    });
  };

  const recheckAbs = (): Promise<void> =>
    run('abs', async () => {
      await api.refreshAbs();
      await onAbsRefreshed();
      setMessage('Audiobookshelf re-read.');
    });

  const syncAbs = (selectedDifferences: AbsDifference[]): Promise<void> =>
    run('abs-write', async () => {
      const result = await api.useFileMetadataInAbs(
        book.id,
        selectedDifferences.map(({ field }) => field),
      );
      onBookUpdated(result.book);
      setMessage(
        `Audiobookshelf now uses this file’s ${selectedDifferences
          .map(({ label }) => label.toLowerCase())
          .join(', ')}.`,
      );
    });

  const differences = book.absDifferences ?? [];
  const pendingAbs = differences.filter((d) => d.adopt && !adopted(form, d));
  const absLink = absPublicUrl && book.abs ? `${absPublicUrl}/item/${book.abs.id}` : null;

  const confirm = (): void => {
    const action = confirmation;
    setConfirmation(null);
    if (!action) return;
    if (action.kind === 'close') onClose();
    if (action.kind === 'discard') discard();
    if (action.kind === 'save') void save();
    if (action.kind === 'restore') void restore(action.revision);
    if (action.kind === 'sync-abs') void syncAbs(action.differences);
  };

  const currentCover = book.hasCover ? api.coverUrl(book.id, book.mtimeMs) : null;
  const chosenCoverPreview =
    coverChoice?.kind === 'remote'
      ? api.proxiedCover(coverChoice.url)
      : coverChoice?.kind === 'upload'
        ? coverChoice.data
        : coverChoice?.kind === 'revision'
          ? api.revisionCoverUrl(book.id, coverChoice.revisionId)
          : null;

  const draftChanges = (
    <>
      {coverChoice && (
        <div className="change-cover">
          <span className="change-label">Cover</span>
          <CoverPair
            before={currentCover}
            after={chosenCoverPreview}
            beforeLabel="Now"
            afterLabel={coverChoice.label}
          />
        </div>
      )}
      {changes.length > 0 && <ChangeList changes={changes} />}
    </>
  );

  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

  return (
    <div className="sheet-backdrop" onClick={requestClose}>
      <aside
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="editor-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="sheet-head">
          <div>
            <h2 id="editor-title">{book.metadata.title || book.folder}</h2>
            <p className="path">
              {book.path} · EPUB {book.epubVersion}
            </p>
          </div>
          <button type="button" className="icon" onClick={requestClose} aria-label="Close editor">
            ×
          </button>
        </header>

        <div className="sheet-body">
          {differences.length > 0 && (
            <section className="panel drift" aria-labelledby="drift-title">
              <div className="panel-head">
                <h3 id="drift-title">
                  Audiobookshelf shows {differences.length === 1 ? 'a different' : 'different'}{' '}
                  {differences.map((d) => d.label.toLowerCase()).join(', ')}
                </h3>
              </div>
              <p className="hint">
                Choose which side is right for each field. Taking Audiobookshelf’s value stages an
                EPUB draft; taking this file’s value updates Audiobookshelf after confirmation.
              </p>
              <ul>
                {differences.map((d) => {
                  const inDraft = adopted(form, d);
                  return (
                    <li key={d.field} className={inDraft ? 'taken' : undefined}>
                      <span className="drift-field">{d.label}</span>
                      <dl className="drift-values">
                        <div>
                          <dt>This file</dt>
                          <dd>{d.file || <em>Empty</em>}</dd>
                        </div>
                        <div>
                          <dt>Audiobookshelf</dt>
                          <dd>{d.abs}</dd>
                        </div>
                      </dl>
                      <div className="drift-actions">
                        {!d.adopt ? (
                          <span className="hint">
                            Not a value an EPUB can hold as it is; fix it in Audiobookshelf.
                          </span>
                        ) : inDraft ? (
                          <>
                            <em className="tag">In draft</em>
                            <button type="button" className="quiet" onClick={() => undoAbs(d)}>
                              Undo
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="small"
                            onClick={() => adoptAbs([d])}
                            disabled={busy !== null}
                          >
                            Use Audiobookshelf’s
                          </button>
                        )}
                        <button
                          type="button"
                          className="small"
                          onClick={() => setConfirmation({ kind: 'sync-abs', differences: [d] })}
                          disabled={busy !== null}
                        >
                          Use this file’s {d.label.toLowerCase()}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="drift-foot">
                {pendingAbs.length > 1 && (
                  <button
                    type="button"
                    className="small"
                    onClick={() => adoptAbs(pendingAbs)}
                    disabled={busy !== null}
                  >
                    Use all of Audiobookshelf’s
                  </button>
                )}
                {differences.length > 1 && (
                  <button
                    type="button"
                    className="small"
                    onClick={() => setConfirmation({ kind: 'sync-abs', differences })}
                    disabled={busy !== null}
                  >
                    Use all of this file’s
                  </button>
                )}
                {absLink && (
                  <a className="button small" href={absLink} target="_blank" rel="noreferrer">
                    Open in Audiobookshelf ↗
                  </a>
                )}
                <button
                  type="button"
                  className="small quiet"
                  onClick={() => void recheckAbs()}
                  disabled={busy !== null}
                  title="Read Audiobookshelf again, after changing the book there"
                >
                  {busy === 'abs' ? 'Rechecking…' : 'Recheck'}
                </button>
              </div>
            </section>
          )}

          <div className="tools">
            <button type="button" onClick={() => void lookup()} disabled={busy !== null}>
              {busy === 'lookup'
                ? 'Looking up…'
                : form.identifier
                  ? 'Look up ISBN'
                  : 'Search title'}
            </button>
            <button
              type="button"
              onClick={() => void previewNormalization()}
              disabled={busy !== null}
            >
              {busy === 'normalize' ? 'Checking…' : 'Normalize'}
            </button>
          </div>

          {candidates.length > 0 && (
            <section className="panel candidates">
              <div className="panel-head">
                <h3>Matches</h3>
                {matchBase && (
                  <button type="button" className="quiet" onClick={undoMatch}>
                    Undo match
                  </button>
                )}
                <button type="button" className="quiet" onClick={closeMatches}>
                  Close
                </button>
              </div>
              <p className="hint">
                Picking a match fills the draft below; pick another to swap it. Nothing is written
                until you save.
              </p>
              <ul>
                {candidates.map((candidate, index) => (
                  <li key={`${candidate.isbn ?? candidate.title}-${index}`}>
                    <button
                      type="button"
                      className={index === appliedMatch ? 'chosen' : undefined}
                      aria-pressed={index === appliedMatch}
                      onClick={() => applyCandidate(candidate, index)}
                    >
                      <strong>{candidate.title}</strong>
                      <span>
                        {candidate.author ?? '—'} · {candidate.source}
                        {candidate.isbn ? ` · ${candidate.isbn}` : ' · no ISBN'}
                      </span>
                      {index === appliedMatch && <em className="tag">In draft</em>}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {normalization.length > 0 && (
            <section className="panel normalization">
              <div className="panel-head">
                <h3>Normalization suggestions</h3>
                <button type="button" className="quiet" onClick={() => setNormalization([])}>
                  Dismiss
                </button>
              </div>
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

          <div className="fields">
            <Field label="Title" {...fieldState('title')}>
              <input
                value={form.title ?? ''}
                onChange={(event) => field('title', event.target.value)}
              />
            </Field>
            <Field label="Subtitle" {...fieldState('subtitle')}>
              <input
                value={form.subtitle ?? ''}
                onChange={(event) => field('subtitle', event.target.value)}
              />
            </Field>

            <fieldset
              className={changed.has('authors') ? 'author-editor changed' : 'author-editor'}
            >
              <legend>
                Authors and roles
                {changed.has('authors') && (
                  <button
                    type="button"
                    className="revert"
                    onClick={() => field('authors', original.authors)}
                    title="Put back what the file says"
                  >
                    Revert
                  </button>
                )}
              </legend>
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
                  <button
                    type="button"
                    className="quiet danger"
                    onClick={() => removeAuthor(index)}
                  >
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

            <Field label="Contributors" {...fieldState('contributors')}>
              <input
                value={form.contributors ?? ''}
                onChange={(event) => field('contributors', event.target.value)}
                placeholder="Comma separated"
              />
            </Field>
            <div className="row">
              <Field label="Series" {...fieldState('series')}>
                <input
                  value={form.series ?? ''}
                  onChange={(event) => field('series', event.target.value)}
                />
              </Field>
              <Field label="#" className="narrow" {...fieldState('seriesIndex')}>
                <input
                  value={String(form.seriesIndex ?? '')}
                  onChange={(event) => field('seriesIndex', event.target.value)}
                />
              </Field>
            </div>
            <div className="row">
              <Field label="ISBN" {...fieldState('identifier')}>
                <input
                  value={form.identifier ?? ''}
                  onChange={(event) => field('identifier', event.target.value)}
                />
              </Field>
              <Field label="Language" className="narrow" {...fieldState('language')}>
                <input
                  value={form.language ?? ''}
                  onChange={(event) => field('language', event.target.value)}
                />
              </Field>
            </div>
            <div className="row">
              <Field label="Publisher" {...fieldState('publisher')}>
                <input
                  value={form.publisher ?? ''}
                  onChange={(event) => field('publisher', event.target.value)}
                />
              </Field>
              <Field label="Date" className="narrow" {...fieldState('date')}>
                <input
                  value={form.date ?? ''}
                  onChange={(event) => field('date', event.target.value)}
                />
              </Field>
            </div>
            <Field label="Subjects" {...fieldState('subjects')}>
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
            </Field>
            <Field label="Description" {...fieldState('description')}>
              <textarea
                rows={6}
                value={form.description ?? ''}
                onChange={(event) => field('description', event.target.value)}
              />
            </Field>
          </div>

          <section className="cover-tools">
            <div className="section-heading">
              <h3>Cover</h3>
              <div className="heading-actions">
                <button
                  type="button"
                  className="small"
                  onClick={() => void findCovers()}
                  disabled={busy !== null}
                >
                  {busy === 'covers' ? 'Searching…' : 'Find covers'}
                </button>
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
            </div>
            {coverChoice ? (
              <div className="chosen-cover">
                <CoverPair
                  before={currentCover}
                  after={chosenCoverPreview}
                  beforeLabel="Now"
                  afterLabel={coverChoice.label}
                />
                <div className="chosen-cover-note">
                  <span>Replaces the embedded cover when you save.</span>
                  <button type="button" className="quiet" onClick={() => chooseCover(null)}>
                    Keep current cover
                  </button>
                </div>
              </div>
            ) : (
              <div className="current-cover">
                {currentCover ? (
                  <img src={currentCover} alt="Current embedded cover" />
                ) : (
                  <span className="no-cover">No embedded cover</span>
                )}
              </div>
            )}
            {covers.length > 0 && (
              <ul className="cover-results">
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
                        chooseCover({
                          kind: 'remote',
                          url: cover.url,
                          label: `${cover.source}: ${cover.description}`,
                        })
                      }
                      title={`${cover.source} — ${cover.description}`}
                    >
                      <img
                        src={api.proxiedCover(cover.url)}
                        alt={cover.description}
                        loading="lazy"
                      />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="history">
            <div className="section-heading">
              <h3>File history</h3>
              <span className="hint">Recent pre-save EPUBs, outside the book library</span>
            </div>
            {revisions.length === 0 ? (
              <p className="hint">A recovery point will appear here after the first save.</p>
            ) : (
              <ul>
                {revisions.map((revision) => {
                  const open = comparing === revision.id;
                  return (
                    <li key={revision.id} className={open ? 'open' : undefined}>
                      <div className="history-entry">
                        <div className="history-cover">
                          {revision.hasCover ? (
                            <img
                              src={api.revisionCoverUrl(book.id, revision.id)}
                              alt=""
                              loading="lazy"
                            />
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
                          <span className="history-summary">{revisionSummary(book, revision)}</span>
                        </div>
                        <div className="history-actions">
                          <button
                            type="button"
                            className="quiet"
                            aria-expanded={open}
                            onClick={() => setComparing(open ? null : revision.id)}
                          >
                            {open ? 'Hide comparison' : 'Compare'}
                          </button>
                          {revision.hasCover && (
                            <button
                              type="button"
                              className="quiet"
                              onClick={() =>
                                chooseCover({
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
                            Restore file…
                          </button>
                        </div>
                      </div>
                      {open && (
                        <div className="history-compare">
                          <p className="hint">Restoring this version would change the file so:</p>
                          <RevisionDiff book={book} revision={revision} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        {/* Docked to the sheet, not floating over the form: whether there is
            unsaved work, and the two ways out of it, are always in one place. */}
        <footer className="sheet-foot">
          {message && (
            <p className="foot-message" role="status">
              <span>{message}</span>
              <button
                type="button"
                className="icon"
                onClick={() => setMessage(null)}
                aria-label="Dismiss message"
              >
                ×
              </button>
            </p>
          )}
          <div className="draft-bar">
            <span className={changeCount > 0 ? 'draft-status dirty' : 'draft-status'}>
              {busy === 'save'
                ? 'Writing to the file…'
                : busy === 'abs-write'
                  ? 'Updating Audiobookshelf…'
                  : busy === 'restore'
                    ? 'Restoring…'
                    : changeCount === 0
                      ? 'No unsaved changes'
                      : plural(changeCount, 'unsaved change')}
            </span>
            <button
              type="button"
              className="danger"
              onClick={() => setConfirmation({ kind: 'discard' })}
              disabled={busy !== null || changeCount === 0}
            >
              Discard changes
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => setConfirmation({ kind: 'save' })}
              disabled={busy !== null || changeCount === 0}
            >
              Review &amp; save
            </button>
          </div>
        </footer>

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
                  : confirmation.kind === 'discard'
                    ? 'Discard these changes?'
                    : confirmation.kind === 'restore'
                      ? 'Restore this earlier file?'
                      : confirmation.kind === 'sync-abs'
                        ? 'Use this file’s metadata in Audiobookshelf?'
                        : 'Discard this draft?'}
              </h3>

              {confirmation.kind === 'save' && (
                <>
                  <p>
                    The current EPUB is copied to Calliope’s private history first, so this can be
                    undone from File history.
                  </p>
                  {draftChanges}
                </>
              )}

              {confirmation.kind === 'discard' && (
                <>
                  <p>The draft goes back to what the file says now. The file is not touched.</p>
                  {draftChanges}
                </>
              )}

              {confirmation.kind === 'close' && (
                <>
                  <p>Closing the editor throws away {plural(changeCount, 'unsaved change')}:</p>
                  {draftChanges}
                </>
              )}

              {confirmation.kind === 'restore' && (
                <>
                  <p>
                    This replaces the whole EPUB with the version from{' '}
                    <strong>{new Date(confirmation.revision.createdAt).toLocaleString()}</strong>.
                    The current file is saved to history first, so the restore can be undone too.
                  </p>
                  {changeCount > 0 && (
                    <p className="banner banner-warn">
                      Your {plural(changeCount, 'unsaved change')} in the draft will be discarded.
                    </p>
                  )}
                  <RevisionDiff book={book} revision={confirmation.revision} />
                </>
              )}

              {confirmation.kind === 'sync-abs' && (
                <>
                  <p>
                    This changes Audiobookshelf’s copy of the selected metadata. The EPUB and any
                    unsaved draft stay unchanged.
                  </p>
                  <dl className="abs-sync-summary">
                    {confirmation.differences.map((difference) => (
                      <div key={difference.field}>
                        <dt>{difference.label}</dt>
                        <dd>{difference.file || <em>Empty</em>}</dd>
                      </div>
                    ))}
                  </dl>
                </>
              )}

              <div className="dialog-actions">
                <button type="button" onClick={() => setConfirmation(null)} autoFocus>
                  {confirmation.kind === 'close' ? 'Keep editing' : 'Cancel'}
                </button>
                <button
                  type="button"
                  className={
                    confirmation.kind === 'close' || confirmation.kind === 'discard'
                      ? 'danger'
                      : 'primary'
                  }
                  onClick={confirm}
                >
                  {confirmation.kind === 'save'
                    ? 'Write to file'
                    : confirmation.kind === 'discard'
                      ? 'Discard changes'
                      : confirmation.kind === 'restore'
                        ? 'Restore this version'
                        : confirmation.kind === 'sync-abs'
                          ? 'Update Audiobookshelf'
                          : 'Discard and close'}
                </button>
              </div>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}
