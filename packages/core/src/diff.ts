import type { Author, BookMetadata, MetadataUpdate } from './metadata.js';

/** The metadata fields a person can see differ between two versions of a book. */
export type MetadataField =
  | 'read'
  | 'title'
  | 'subtitle'
  | 'authors'
  | 'contributors'
  | 'series'
  | 'seriesIndex'
  | 'identifier'
  | 'language'
  | 'publisher'
  | 'date'
  | 'subjects'
  | 'description'
  | 'rights';

/** One field that differs, rendered as the text the editor shows for it. */
export interface FieldChange {
  key: MetadataField;
  label: string;
  before: string;
  after: string;
}

/** In the order the editor lays the fields out, so a change list reads like the form. */
const FIELDS: ReadonlyArray<readonly [MetadataField, string]> = [
  ['read', 'Read status'],
  ['title', 'Title'],
  ['subtitle', 'Subtitle'],
  ['authors', 'Authors'],
  ['contributors', 'Contributors'],
  ['series', 'Series'],
  ['seriesIndex', 'Series number'],
  ['identifier', 'ISBN'],
  ['language', 'Language'],
  ['publisher', 'Publisher'],
  ['date', 'Date'],
  ['subjects', 'Subjects'],
  ['description', 'Description'],
  ['rights', 'Rights'],
];

const formatAuthor = (author: Author | string): string =>
  typeof author === 'string'
    ? author
    : `${author.name}${author.role ? ` (${author.role})` : ''}${author.fileAs ? ` [${author.fileAs}]` : ''}`;

function display(metadata: MetadataUpdate | BookMetadata, key: MetadataField): string | undefined {
  if (key === 'read')
    return metadata.read === undefined ? undefined : metadata.read ? 'Read' : 'Unread';
  if (key === 'authors') return metadata.authors?.map(formatAuthor).join(', ');
  if (key === 'subjects') return metadata.subjects?.join(', ');
  if (key === 'contributors') {
    const contributors = metadata.contributors;
    return typeof contributors === 'string'
      ? contributors
      : contributors?.map((contributor) => contributor.name).join(', ');
  }
  const value = metadata[key];
  return value === undefined ? undefined : String(value);
}

/**
 * Every field that differs between `before` and `after`, as display text.
 *
 * A field `after` leaves undefined is skipped, not reported as cleared: in a
 * `MetadataUpdate` undefined means "not edited", and the editor's draft never
 * carries `rights` at all — reporting it would show a deletion nobody made.
 */
export function metadataChanges(
  before: MetadataUpdate | BookMetadata,
  after: MetadataUpdate | BookMetadata,
): FieldChange[] {
  return FIELDS.flatMap(([key, label]) => {
    const next = display(after, key);
    if (next === undefined) return [];
    const previous = display(before, key) ?? '';
    return previous === next ? [] : [{ key, label, before: previous, after: next }];
  });
}

export interface DiffPart {
  kind: 'same' | 'removed' | 'added';
  text: string;
}

/**
 * Past this many LCS cells the diff reports a wholesale replacement. Trimming
 * the shared prefix and suffix first means a normal edit never gets near it;
 * two unrelated long descriptions would, and a word-by-word diff of those is
 * noise anyway.
 */
const MAX_CELLS = 250_000;

/**
 * A word-level diff, for showing what changed inside a long field instead of
 * two near-identical paragraphs side by side.
 *
 * A token is a word plus the whitespace after it, so a replaced run of words
 * comes out as one removed and one added part rather than alternating around
 * every space. Joining the `same` and `removed` parts reproduces `before`
 * exactly; `same` and `added` reproduce `after`.
 */
export function diffWords(before: string, after: string): DiffPart[] {
  const tokenize = (text: string): string[] => text.match(/\s+|\S+\s*/g) ?? [];
  const a = tokenize(before);
  const b = tokenize(after);

  const parts: DiffPart[] = [];
  const push = (kind: DiffPart['kind'], text: string): void => {
    if (!text) return;
    const last = parts.at(-1);
    if (last?.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  push('same', a.slice(0, start).join(''));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;

  if (n * m > MAX_CELLS) {
    push('removed', midA.join(''));
    push('added', midB.join(''));
  } else {
    // lcs[i][j] = longest common subsequence of midA[i..] and midB[j..], so the
    // walk below can go forwards and emit parts in reading order.
    const width = m + 1;
    const lcs = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * width + j] =
          midA[i] === midB[j]
            ? lcs[(i + 1) * width + j + 1]! + 1
            : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        push('same', midA[i++]!);
        j++;
      } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
        push('removed', midA[i++]!);
      } else {
        push('added', midB[j++]!);
      }
    }
    while (i < n) push('removed', midA[i++]!);
    while (j < m) push('added', midB[j++]!);
  }

  push('same', a.slice(endA).join(''));
  return parts;
}
