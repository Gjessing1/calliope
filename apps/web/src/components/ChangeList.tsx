import type { JSX } from 'react';
import type { BookRevision, FieldChange, MergedBook } from '@calliope/core';
import { diffWords, metadataChanges } from '@calliope/core';
import { api } from '../api.js';
import { ApiImage } from './ApiImage.js';

/**
 * Short values read best as "old → new". A long one (a description, a long
 * subject list) is shown once with the edits marked inside it — two nearly
 * identical paragraphs side by side hide a one-word change.
 */
const inline = (change: FieldChange): boolean =>
  change.before !== '' &&
  change.after !== '' &&
  Math.max(change.before.length, change.after.length) > 80;

export function ChangeList({ changes }: { changes: FieldChange[] }): JSX.Element {
  return (
    <dl className="change-list">
      {changes.map((change) => (
        <div key={change.key}>
          <dt>{change.label}</dt>
          {inline(change) ? (
            <dd className="inline-diff">
              {diffWords(change.before, change.after).map((part, index) =>
                part.kind === 'removed' ? (
                  <del key={index}>{part.text}</del>
                ) : part.kind === 'added' ? (
                  <ins key={index}>{part.text}</ins>
                ) : (
                  <span key={index}>{part.text}</span>
                ),
              )}
            </dd>
          ) : (
            <dd className="swap">
              <span className="change-before">{change.before || 'Empty'}</span>
              <b aria-hidden="true">→</b>
              <span className="change-after">{change.after || 'Empty'}</span>
            </dd>
          )}
        </div>
      ))}
    </dl>
  );
}

interface CoverPairProps {
  before: string | null;
  after: string | null;
  beforeLabel: string;
  afterLabel: string;
}

export function CoverPair({ before, after, beforeLabel, afterLabel }: CoverPairProps): JSX.Element {
  const side = (src: string | null, label: string): JSX.Element => (
    <figure>
      {src ? (
        <ApiImage src={src} alt="" loading="lazy" />
      ) : (
        <span className="no-cover">No cover</span>
      )}
      <figcaption>{label}</figcaption>
    </figure>
  );
  return (
    <div className="cover-pair">
      {side(before, beforeLabel)}
      <b aria-hidden="true">→</b>
      {side(after, afterLabel)}
    </div>
  );
}

/** What restoring `revision` would do to the current file, field by field. */
export function RevisionDiff({
  book,
  revision,
}: {
  book: MergedBook;
  revision: BookRevision;
}): JSX.Element {
  const changes = metadataChanges(book.metadata, revision.metadata);
  // Older API responses carry no comparison; show both covers rather than guess.
  const coverChanged = revision.coverChanged ?? (book.hasCover || revision.hasCover);
  return (
    <div className="revision-diff">
      {coverChanged && (
        <div className="change-cover">
          <span className="change-label">Cover</span>
          <CoverPair
            before={book.hasCover ? api.coverUrl(book.id, book.mtimeMs) : null}
            after={revision.hasCover ? api.revisionCoverUrl(book.id, revision.id) : null}
            beforeLabel="Now"
            afterLabel="This version"
          />
        </div>
      )}
      {changes.length > 0 && <ChangeList changes={changes} />}
      {changes.length === 0 && !coverChanged && (
        <p className="hint">
          Same metadata and cover as the current file. Only parts of the EPUB Calliope does not
          display could differ.
        </p>
      )}
    </div>
  );
}

/** A history entry's one-line summary: which fields restoring it would change. */
export function revisionSummary(book: MergedBook, revision: BookRevision): string {
  const labels = metadataChanges(book.metadata, revision.metadata).map((change) => change.label);
  if (revision.coverChanged) labels.push('Cover');
  return labels.length === 0 ? 'Same as the current file' : `Differs in ${labels.join(', ')}`;
}
