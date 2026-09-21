/**
 * The editable metadata surface of a book.
 *
 * This is the contract between every layer: what the EPUB engine reads out of an
 * OPF, what a lookup provider proposes, what the editor sends back, and what the
 * writer puts into the file. Keeping one shape means a new field is added once.
 *
 * `undefined` and `''` are deliberately different in the update direction:
 * undefined means "not edited, leave the file alone", `''` means "clear it".
 * The writer relies on that distinction — see @calliope/epub's `writeEpub`.
 */
export interface BookMetadata {
  title: string;
  /** Rendered into `dc:title` as `Title: Subtitle` — see the note in `writeEpub`. */
  subtitle: string;
  authors: Author[];
  /** First author's name. Kept because most list views and filenames want one string. */
  author: string;
  contributors: Contributor[];
  /** BCP 47, normalized by `normalizeLanguageCode`. */
  language: string;
  /** Set when the language code could not be confidently normalized. */
  languageWarning?: string;
  /** The original 3-letter code when normalization converted one, else null. */
  languageConverted: string | null;
  /** ISBN when one could be identified among the `dc:identifier` entries. */
  identifier: string;
  publisher: string;
  date: string;
  description: string;
  rights: string;
  series: string;
  seriesIndex: string;
  subjects: string[];
}

/** MARC relator code, e.g. `aut`, `trl`, `edt`, `ill`. */
export type MarcRole = string;

export interface Author {
  name: string;
  /** MARC relator; defaults to `aut`. */
  role: MarcRole;
  /** Sort name (`Tolstoy, Leo`). Null when the file carries none. */
  fileAs: string | null;
}

export interface Contributor {
  name: string;
  role: MarcRole;
}

/**
 * A metadata edit. Every field is optional: only what is present is written.
 * `contributors` is a comma-separated string because that is what the editor
 * field produces; the writer splits and matches it against existing entries so
 * unchanged names keep their role attributes.
 */
export interface MetadataUpdate {
  title?: string;
  subtitle?: string;
  authors?: Array<Author | string>;
  author?: string;
  contributors?: string;
  language?: string;
  identifier?: string;
  publisher?: string;
  date?: string;
  description?: string;
  rights?: string;
  series?: string;
  seriesIndex?: string | number;
  subjects?: string[];
}

/** An empty, fully-populated metadata record — the shape a caller can spread over. */
export function emptyMetadata(): BookMetadata {
  return {
    title: '',
    subtitle: '',
    authors: [],
    author: '',
    contributors: [],
    language: '',
    languageConverted: null,
    identifier: '',
    publisher: '',
    date: '',
    description: '',
    rights: '',
    series: '',
    seriesIndex: '',
    subjects: [],
  };
}
