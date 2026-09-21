import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type {
  AbsDifference,
  BatchItemResult,
  BatchJob,
  BatchOperation,
  BatchPlan,
  MergedBook,
  TidyPart,
} from '@calliope/core';
import { api } from '../api.js';
import { ChangeList } from './ChangeList.js';

type Kind = BatchOperation['kind'];

interface BatchEditorProps {
  /** The selection. */
  books: MergedBook[];
  /** The loaded library, for suggestions: series names and publishers already in use. */
  library: MergedBook[];
  absConfigured: boolean;
  /** The running or last batch, polled by the app so it survives closing this sheet. */
  job: BatchJob | null;
  onStarted: (job: BatchJob) => void;
  onClose: () => void;
}

const OPERATIONS: ReadonlyArray<{ kind: Kind; label: string; hint: string }> = [
  { kind: 'series', label: 'Series', hint: 'Put them in a series, renumber, or take them out' },
  { kind: 'author', label: 'Rename an author', hint: 'Fix one spelling of a name everywhere' },
  { kind: 'language', label: 'Language', hint: 'One language code on every book' },
  { kind: 'subjects', label: 'Subjects', hint: 'Add or remove subjects' },
  { kind: 'publisher', label: 'Publisher', hint: 'Set or clear the publisher' },
  { kind: 'tidy', label: 'Tidy up', hint: 'Descriptions, dates, codes, whitespace' },
  {
    kind: 'abs',
    label: 'Use Audiobookshelf’s values',
    hint: 'Write what ABS shows into the files, field by field',
  },
];

const TIDY_PARTS: ReadonlyArray<{ part: TidyPart; label: string; hint: string }> = [
  { part: 'description', label: 'Descriptions', hint: 'Strip HTML tags and entities' },
  { part: 'date', label: 'Dates', hint: 'Rewrite as YYYY-MM-DD or YYYY' },
  { part: 'language', label: 'Language codes', hint: 'Three letters to two: rus → ru' },
  { part: 'subjects', label: 'Subjects', hint: 'Trim them and drop duplicates' },
  { part: 'whitespace', label: 'Whitespace', hint: 'Title, subtitle, publisher, series, rights' },
];

/** Codes offered in the language field; anything else can still be typed. */
const LANGUAGES = ['en', 'nb', 'nn', 'no', 'sv', 'da', 'de', 'fr', 'es', 'it', 'ru', 'fi', 'nl'];

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Values in use across some books, most common first. */
function tally(values: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) if (value.trim()) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** The operation in words: shown while it runs, and in the result afterwards. */
function describe(operation: BatchOperation): string {
  switch (operation.kind) {
    case 'series':
      return operation.series.trim()
        ? `Series → ${operation.series.trim()}${operation.numbering === 'date' ? ', numbered by date' : operation.numbering === 'clear' ? ', no numbers' : ''}`
        : 'Take out of series';
    case 'language':
      return `Language → ${operation.language.trim()}`;
    case 'publisher':
      return operation.publisher.trim()
        ? `Publisher → ${operation.publisher.trim()}`
        : 'Clear publisher';
    case 'subjects': {
      const parts = [
        operation.add.length ? `add ${operation.add.join(', ')}` : '',
        operation.remove.length ? `remove ${operation.remove.join(', ')}` : '',
      ];
      return `Subjects: ${parts.filter(Boolean).join('; ')}`;
    }
    case 'author':
      return `${operation.from} → ${operation.to}`;
    case 'tidy':
      return `Tidy up ${operation.parts.join(', ')}`;
    case 'abs':
      return `Use Audiobookshelf’s ${operation.fields.join(', ')}`;
  }
}

const STATUS_LABEL: Record<BatchItemResult['status'], string> = {
  saved: 'Saved',
  conflict: 'Changed since the preview',
  failed: 'Failed',
  missing: 'No longer in the library',
};

/**
 * One edit across a selection, with the same guarantees as a single save.
 *
 * Nothing is written until the per-book preview has been reviewed and
 * confirmed. The server writes exactly the reviewed updates, one ordinary save
 * per book — each with its own history entry and its own conflict check — so a
 * batch can be undone book by book from File history.
 */
export function BatchEditor({
  books,
  library,
  absConfigured,
  job,
  onStarted,
  onClose,
}: BatchEditorProps): JSX.Element {
  const [kind, setKind] = useState<Kind>('series');
  const [series, setSeries] = useState('');
  const [numbering, setNumbering] = useState<'keep' | 'date' | 'clear'>('keep');
  const [start, setStart] = useState(1);
  const [language, setLanguage] = useState('');
  const [publisher, setPublisher] = useState('');
  const [addSubjects, setAddSubjects] = useState<string[]>([]);
  const [subjectDraft, setSubjectDraft] = useState('');
  const [removeSubjects, setRemoveSubjects] = useState<Set<string>>(new Set());
  const [authorFrom, setAuthorFrom] = useState('');
  const [authorTo, setAuthorTo] = useState('');
  const [fileAs, setFileAs] = useState('');
  const [tidyParts, setTidyParts] = useState<Set<TidyPart>>(new Set(TIDY_PARTS.map((p) => p.part)));
  const [absFields, setAbsFields] = useState<Set<AbsDifference['field']> | null>(null);

  const [plan, setPlan] = useState<BatchPlan | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The job this sheet started; another tab's batch is not this sheet's to report.
  const [startedId, setStartedId] = useState<string | null>(null);

  const ids = useMemo(() => books.map((book) => book.id), [books]);
  const authors = useMemo(
    () => tally(books.flatMap((book) => book.metadata.authors.map((a) => a.name))),
    [books],
  );
  const subjects = useMemo(() => tally(books.flatMap((book) => book.metadata.subjects)), [books]);
  const seriesNames = useMemo(
    () => tally(library.map((book) => book.metadata.series)).map(([name]) => name),
    [library],
  );
  const publishers = useMemo(
    () => tally(library.map((book) => book.metadata.publisher)).map(([name]) => name),
    [library],
  );

  // Every field where some selected book differs from ABS, with how many books
  // differ in it and how many of those can be written as ABS has them.
  const differences = useMemo(() => {
    const byField = new Map<
      AbsDifference['field'],
      { label: string; count: number; writable: number }
    >();
    for (const book of books) {
      for (const d of book.absDifferences ?? []) {
        const entry = byField.get(d.field) ?? { label: d.label, count: 0, writable: 0 };
        entry.count += 1;
        if (d.adopt) entry.writable += 1;
        byField.set(d.field, entry);
      }
    }
    return [...byField];
  }, [books]);
  const chosenAbsFields = useMemo(
    () =>
      absFields ?? new Set(differences.filter(([, d]) => d.writable > 0).map(([field]) => field)),
    [absFields, differences],
  );

  // Audiobookshelf's spelling of the chosen author, where the two disagree:
  // exactly the drift a rename is most often for.
  const absSpelling = useMemo(() => {
    for (const book of books) {
      const index = book.metadata.authors.findIndex((a) => a.name === authorFrom);
      const theirs = index >= 0 ? book.abs?.authors[index] : undefined;
      if (theirs && theirs.trim().toLowerCase() !== authorFrom.trim().toLowerCase()) return theirs;
    }
    return null;
  }, [books, authorFrom]);

  useEffect(() => {
    if (!authorFrom && authors[0]) {
      setAuthorFrom(authors[0][0]);
      setAuthorTo(authors[0][0]);
    }
  }, [authors, authorFrom]);

  const operation = useMemo((): BatchOperation => {
    switch (kind) {
      case 'series':
        return { kind, series, numbering, start };
      case 'language':
        return { kind, language };
      case 'publisher':
        return { kind, publisher };
      case 'subjects':
        return { kind, add: addSubjects, remove: [...removeSubjects] };
      case 'author':
        return { kind, from: authorFrom, to: authorTo, fileAs: fileAs.trim() || null };
      case 'tidy':
        return { kind, parts: TIDY_PARTS.map((p) => p.part).filter((p) => tidyParts.has(p)) };
      case 'abs':
        return {
          kind,
          fields: differences.map(([field]) => field).filter((f) => chosenAbsFields.has(f)),
        };
    }
  }, [
    kind,
    series,
    numbering,
    start,
    language,
    publisher,
    addSubjects,
    removeSubjects,
    authorFrom,
    authorTo,
    fileAs,
    tidyParts,
    differences,
    chosenAbsFields,
  ]);

  // A preview describes one operation over one selection; change either and it
  // no longer describes what would be written.
  const planKey = JSON.stringify([ids, operation]);
  useEffect(() => {
    setPlan(null);
    setError(null);
  }, [planKey]);

  const ownJob = job && job.id === startedId ? job : null;
  const phase = ownJob ? (ownJob.finishedAt ? 'done' : 'writing') : plan ? 'review' : 'edit';

  const included = plan ? plan.items.filter((item) => !excluded.has(item.id)) : [];

  const preview = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.batchPreview(ids, operation);
      if (next.items.length === 0 && next.warnings.length > 0) {
        setError(next.warnings.join(' '));
        return;
      }
      setPlan(next);
      setExcluded(new Set());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const apply = async (): Promise<void> => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      const started = await api.batchApply(describe(operation), included);
      setStartedId(started.id);
      onStarted(started);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const again = (): void => {
    setStartedId(null);
    setPlan(null);
    void preview();
  };

  const addSubject = (): void => {
    const subject = subjectDraft.trim();
    if (subject && !addSubjects.includes(subject)) setAddSubjects([...addSubjects, subject]);
    setSubjectDraft('');
  };

  const toggle = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (confirming) setConfirming(false);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirming, onClose]);

  const results = ownJob?.results ?? [];
  const counts = tally(results.map((r) => r.status));
  const saved = results.filter((r) => r.status === 'saved').length;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <aside
        className="sheet batch"
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="sheet-head">
          <div>
            <h2 id="batch-title">Edit {plural(books.length, 'book')}</h2>
            <p className="path">
              {books
                .slice(0, 4)
                .map((book) => book.metadata.title || book.folder)
                .join(' · ')}
              {books.length > 4 ? ` · and ${books.length - 4} more` : ''}
            </p>
          </div>
          <button type="button" className="icon" onClick={onClose} aria-label="Close batch edit">
            ×
          </button>
        </header>

        <div className="sheet-body">
          {phase === 'edit' && (
            <>
              <fieldset className="op-picker">
                <legend>What to change</legend>
                {OPERATIONS.filter((op) => op.kind !== 'abs' || absConfigured).map((op) => (
                  <label key={op.kind} className={kind === op.kind ? 'op chosen' : 'op'}>
                    <input
                      type="radio"
                      name="batch-op"
                      value={op.kind}
                      checked={kind === op.kind}
                      onChange={() => setKind(op.kind)}
                    />
                    <strong>{op.label}</strong>
                    <span>{op.hint}</span>
                  </label>
                ))}
              </fieldset>

              <div className="fields op-fields">
                {kind === 'series' && (
                  <>
                    <label className="field">
                      <span className="field-name">Series</span>
                      <input
                        value={series}
                        list="batch-series"
                        placeholder="Leave empty to take them out of their series"
                        onChange={(event) => setSeries(event.target.value)}
                      />
                      <datalist id="batch-series">
                        {seriesNames.map((name) => (
                          <option key={name} value={name} />
                        ))}
                      </datalist>
                    </label>
                    {series.trim() && (
                      <fieldset className="choices">
                        <legend>Numbers</legend>
                        <label>
                          <input
                            type="radio"
                            name="numbering"
                            checked={numbering === 'keep'}
                            onChange={() => setNumbering('keep')}
                          />
                          Keep each book’s number
                        </label>
                        <label>
                          <input
                            type="radio"
                            name="numbering"
                            checked={numbering === 'date'}
                            onChange={() => setNumbering('date')}
                          />
                          Number by publication date, from
                          <input
                            className="inline-number"
                            type="number"
                            min={0}
                            value={start}
                            aria-label="First number"
                            onChange={(event) => setStart(Number(event.target.value) || 0)}
                            onFocus={() => setNumbering('date')}
                          />
                        </label>
                        <label>
                          <input
                            type="radio"
                            name="numbering"
                            checked={numbering === 'clear'}
                            onChange={() => setNumbering('clear')}
                          />
                          Remove the numbers
                        </label>
                        {numbering === 'date' && (
                          <p className="hint">Oldest first; books with no date go last.</p>
                        )}
                      </fieldset>
                    )}
                  </>
                )}

                {kind === 'language' && (
                  <label className="field">
                    <span className="field-name">Language code</span>
                    <input
                      value={language}
                      list="batch-languages"
                      placeholder="en, nb, de…"
                      onChange={(event) => setLanguage(event.target.value)}
                    />
                    <datalist id="batch-languages">
                      {LANGUAGES.map((code) => (
                        <option key={code} value={code} />
                      ))}
                    </datalist>
                    <span className="hint">
                      Written as a BCP 47 code; a three-letter code is converted (nor → no).
                    </span>
                  </label>
                )}

                {kind === 'publisher' && (
                  <label className="field">
                    <span className="field-name">Publisher</span>
                    <input
                      value={publisher}
                      list="batch-publishers"
                      placeholder="Leave empty to clear it"
                      onChange={(event) => setPublisher(event.target.value)}
                    />
                    <datalist id="batch-publishers">
                      {publishers.map((name) => (
                        <option key={name} value={name} />
                      ))}
                    </datalist>
                  </label>
                )}

                {kind === 'subjects' && (
                  <>
                    <div className="field">
                      <span className="field-name">Add</span>
                      <div className="row">
                        <input
                          value={subjectDraft}
                          placeholder="A subject, then Enter"
                          aria-label="Subject to add"
                          onChange={(event) => setSubjectDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              addSubject();
                            }
                          }}
                        />
                        <button type="button" onClick={addSubject} disabled={!subjectDraft.trim()}>
                          Add
                        </button>
                      </div>
                      {addSubjects.length > 0 && (
                        <ul className="chips">
                          {addSubjects.map((subject) => (
                            <li key={subject}>
                              {subject}
                              <button
                                type="button"
                                className="icon"
                                aria-label={`Don’t add ${subject}`}
                                onClick={() =>
                                  setAddSubjects(addSubjects.filter((s) => s !== subject))
                                }
                              >
                                ×
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    {subjects.length > 0 && (
                      <fieldset className="choices subject-list">
                        <legend>Remove</legend>
                        {subjects.map(([subject, count]) => (
                          <label key={subject}>
                            <input
                              type="checkbox"
                              checked={removeSubjects.has(subject)}
                              onChange={() => setRemoveSubjects(toggle(removeSubjects, subject))}
                            />
                            <span>{subject}</span>
                            <span className="count">{count}</span>
                          </label>
                        ))}
                      </fieldset>
                    )}
                  </>
                )}

                {kind === 'author' && (
                  <>
                    <label className="field">
                      <span className="field-name">Author</span>
                      <select
                        value={authorFrom}
                        onChange={(event) => {
                          setAuthorFrom(event.target.value);
                          setAuthorTo(event.target.value);
                        }}
                      >
                        {authors.map(([name, count]) => (
                          <option key={name} value={name}>
                            {name} ({plural(count, 'book')})
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span className="field-name">Rename to</span>
                      <input
                        value={authorTo}
                        onChange={(event) => setAuthorTo(event.target.value)}
                      />
                    </label>
                    {absSpelling && absSpelling !== authorTo && (
                      <p className="banner suggestion">
                        <span>
                          Audiobookshelf spells this author <strong>{absSpelling}</strong>.
                        </span>
                        <button
                          type="button"
                          className="small"
                          onClick={() => setAuthorTo(absSpelling)}
                        >
                          Use that
                        </button>
                      </p>
                    )}
                    <label className="field">
                      <span className="field-name">Sort as</span>
                      <input
                        value={fileAs}
                        placeholder="Keep each book’s sort name"
                        onChange={(event) => setFileAs(event.target.value)}
                      />
                      <span className="hint">
                        Only authors are renamed; contributors such as translators are not.
                      </span>
                    </label>
                  </>
                )}

                {kind === 'abs' &&
                  (differences.length === 0 ? (
                    <p className="hint">None of the selected books differ from Audiobookshelf.</p>
                  ) : (
                    <fieldset className="choices">
                      <legend>Fields to take from Audiobookshelf</legend>
                      {differences.map(([field, d]) => (
                        <label key={field}>
                          <input
                            type="checkbox"
                            checked={chosenAbsFields.has(field)}
                            disabled={d.writable === 0}
                            onChange={() => setAbsFields(toggle(chosenAbsFields, field))}
                          />
                          <span>
                            {d.label}{' '}
                            <span className="hint">
                              — differs in {plural(d.count, 'book')}
                              {d.writable < d.count &&
                                ` (${d.count - d.writable} can only be fixed in Audiobookshelf)`}
                            </span>
                          </span>
                        </label>
                      ))}
                      <p className="hint">
                        The preview shows each book’s file value beside Audiobookshelf’s; untick any
                        book where the file is right. Those are best fixed in Audiobookshelf, which
                        keeps its own copy until you change it there.
                      </p>
                    </fieldset>
                  ))}

                {kind === 'tidy' && (
                  <fieldset className="choices">
                    <legend>Clean up</legend>
                    {TIDY_PARTS.map(({ part, label, hint }) => (
                      <label key={part}>
                        <input
                          type="checkbox"
                          checked={tidyParts.has(part)}
                          onChange={() => setTidyParts(toggle(tidyParts, part))}
                        />
                        <span>
                          {label} <span className="hint">— {hint}</span>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                )}
              </div>
            </>
          )}

          {phase === 'review' && plan && (
            <>
              <p className="hint review-lead">
                {plan.items.length === 0
                  ? 'Nothing to write — every selected book already matches.'
                  : `${describe(operation)}. Untick a book to leave it out.`}
              </p>
              {plan.warnings.map((warning) => (
                <p key={warning} className="banner banner-warn">
                  {warning}
                </p>
              ))}
              {plan.missing.length > 0 && (
                <p className="banner banner-warn">
                  {plural(plan.missing.length, 'selected book')} left the library since it was
                  selected and will be skipped.
                </p>
              )}
              <ul className="batch-items">
                {plan.items.map((item) => (
                  <li key={item.id} className={excluded.has(item.id) ? 'left-out' : undefined}>
                    <label className="batch-include">
                      <input
                        type="checkbox"
                        checked={!excluded.has(item.id)}
                        onChange={() => setExcluded(toggle(excluded, item.id))}
                      />
                      <span>
                        <strong>{item.title}</strong>
                        <span className="hint">{item.author || '—'}</span>
                      </span>
                    </label>
                    <ChangeList changes={item.changes} />
                  </li>
                ))}
              </ul>
              {plan.unchanged.length > 0 && (
                <details className="unchanged">
                  <summary>{plural(plan.unchanged.length, 'book')} already match</summary>
                  <ul>
                    {plan.unchanged.map((book) => (
                      <li key={book.id}>{book.title}</li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}

          {(phase === 'writing' || phase === 'done') && ownJob && (
            <>
              <div
                className="progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={ownJob.total}
                aria-valuenow={results.length}
                aria-label="Books written"
              >
                <span style={{ width: `${(100 * results.length) / Math.max(1, ownJob.total)}%` }} />
              </div>
              <p className="hint">
                {phase === 'writing'
                  ? `Writing ${Math.min(results.length + 1, ownJob.total)} of ${ownJob.total}… You can close this; it carries on.`
                  : `${ownJob.label}. ${counts.map(([status, n]) => `${n} ${STATUS_LABEL[status as BatchItemResult['status']].toLowerCase()}`).join(' · ')}.`}
              </p>
              {phase === 'done' && ownJob.absRescan === 'failed' && (
                <p className="banner banner-warn">
                  Audiobookshelf did not accept the rescan request; it will notice the changes when
                  its own watcher does.
                </p>
              )}
              {phase === 'done' && saved > 0 && (
                <p className="hint">
                  Every saved book’s previous file is in its own File history, so any one of them
                  can be undone from its editor.
                </p>
              )}
              <ul className="batch-results">
                {results.map((result) => (
                  <li key={result.id} className={`result-${result.status}`}>
                    <strong>{result.title}</strong>
                    <span>{STATUS_LABEL[result.status]}</span>
                    {result.message && result.status !== 'conflict' && (
                      <span className="hint">{result.message}</span>
                    )}
                    {result.warnings.map((warning) => (
                      <span key={warning} className="hint">
                        {warning}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <footer className="sheet-foot">
          {error && (
            <p className="foot-message" role="alert">
              <span>{error}</span>
              <button
                type="button"
                className="icon"
                onClick={() => setError(null)}
                aria-label="Dismiss message"
              >
                ×
              </button>
            </p>
          )}
          <div className="draft-bar">
            {phase === 'edit' && (
              <>
                <span className="draft-status">Nothing is written until you review it.</span>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void preview()}
                  disabled={busy}
                >
                  {busy ? 'Working out changes…' : 'Preview changes'}
                </button>
              </>
            )}
            {phase === 'review' && (
              <>
                <span className={included.length > 0 ? 'draft-status dirty' : 'draft-status'}>
                  {plural(included.length, 'book')} to write
                </span>
                <button type="button" onClick={() => setPlan(null)} disabled={busy}>
                  Back
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => setConfirming(true)}
                  disabled={busy || included.length === 0}
                >
                  Review &amp; write
                </button>
              </>
            )}
            {phase === 'writing' && (
              <>
                <span className="draft-status dirty">Writing to the files…</span>
                <button type="button" onClick={onClose}>
                  Close
                </button>
              </>
            )}
            {phase === 'done' && (
              <>
                <span className="draft-status">
                  {saved === ownJob?.total ? 'All written' : `${saved} of ${ownJob?.total} written`}
                </span>
                {saved !== ownJob?.total && (
                  <button type="button" onClick={again}>
                    Preview again
                  </button>
                )}
                <button type="button" className="primary" onClick={onClose}>
                  Done
                </button>
              </>
            )}
          </div>
        </footer>

        {confirming && (
          <div className="confirm-backdrop" onClick={() => setConfirming(false)}>
            <section
              className="confirm-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="batch-confirm-title"
              onClick={(event) => event.stopPropagation()}
            >
              <h3 id="batch-confirm-title">Write to {plural(included.length, 'EPUB file')}?</h3>
              <p>{describe(operation)}.</p>
              <p>
                Each book’s current file is copied to its own history first, so any one of them can
                be undone from File history. A book that changed since this preview is skipped, not
                overwritten.
                {absConfigured && ' Audiobookshelf is asked to rescan once, when all are written.'}
              </p>
              <div className="dialog-actions">
                <button type="button" onClick={() => setConfirming(false)} autoFocus>
                  Cancel
                </button>
                <button type="button" className="primary" onClick={() => void apply()}>
                  Write {plural(included.length, 'book')}
                </button>
              </div>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}
