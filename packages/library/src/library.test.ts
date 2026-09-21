import { mkdtemp, mkdir, rm, stat, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AbsBook, LibraryBook } from '@calliope/core';
import { emptyMetadata } from '@calliope/core';
import { bookId, readEpubFile, saveEpubFile } from '@calliope/epub';
import { AbsClient } from './abs.js';
import { CoverCache } from './covers.js';
import { LibraryIndex, ftsQuery } from './index-db.js';
import { absDifferences, absDrift } from './merge.js';
import { absMetadataPatch } from './abs-update.js';
import { RevisionStore } from './revisions.js';
import { findEpubs, scanLibrary } from './scan.js';

let root: string;

async function writeEpubAt(relative: string, title: string, author: string): Promise<void> {
  const target = path.join(root, 'books', relative);
  await mkdir(path.dirname(target), { recursive: true });

  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${title}</dc:title>
    <dc:creator>${author}</dc:creator>
    <dc:identifier id="bookid">urn:uuid:${relative}</dc:identifier>
  </metadata>
  <manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="nav"/></spine>
</package>`,
  );
  await writeFile(target, await zip.generateAsync({ type: 'nodebuffer' }));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'calliope-test-'));
  await mkdir(path.join(root, 'books'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('findEpubs', () => {
  it('walks nested folders and ignores everything that is not an epub', async () => {
    await writeEpubAt('Sult - Knut Hamsun/Sult - Knut Hamsun.epub', 'Sult', 'Knut Hamsun');
    await writeEpubAt('The Trial - Franz Kafka/The Trial - Franz Kafka.epub', 'The Trial', 'Kafka');
    await writeFile(path.join(root, 'books', 'notes.txt'), 'not a book');
    await mkdir(path.join(root, 'books', '.stfolder'), { recursive: true });
    await writeFile(path.join(root, 'books', '.stfolder', 'x.epub'), 'nope');

    const found: string[] = [];
    for await (const p of findEpubs(path.join(root, 'books'))) found.push(p);

    expect(found.sort()).toEqual([
      'Sult - Knut Hamsun/Sult - Knut Hamsun.epub',
      'The Trial - Franz Kafka/The Trial - Franz Kafka.epub',
    ]);
  });
});

describe('scanLibrary', () => {
  it('adds, then skips unchanged files, then removes deleted ones', async () => {
    const books = path.join(root, 'books');
    const index = new LibraryIndex(':memory:');
    const covers = new CoverCache(path.join(root, 'covers'));

    await writeEpubAt('Sult - Knut Hamsun/Sult - Knut Hamsun.epub', 'Sult', 'Knut Hamsun');
    await writeEpubAt('War and Peace - Leo Tolstoy/wap.epub', 'War and Peace', 'Leo Tolstoy');

    const first = await scanLibrary(books, index, covers);
    expect(first).toMatchObject({ seen: 2, added: 2, updated: 0, removed: 0, unchanged: 0 });
    expect(index.count()).toBe(2);

    // Nothing touched the files, so the second pass must not re-parse them.
    const second = await scanLibrary(books, index, covers);
    expect(second).toMatchObject({ seen: 2, added: 0, updated: 0, unchanged: 2 });

    await rm(path.join(books, 'War and Peace - Leo Tolstoy'), { recursive: true });
    const third = await scanLibrary(books, index, covers);
    expect(third).toMatchObject({ seen: 1, removed: 1 });
    expect(index.count()).toBe(1);

    index.close();
  });

  // Mtime alone would miss a file restored from backup with its timestamp
  // preserved; size alone would miss an edit that happened to keep the size.
  it('re-parses when the size changes even if mtime is restored', async () => {
    const books = path.join(root, 'books');
    const index = new LibraryIndex(':memory:');
    const covers = new CoverCache(path.join(root, 'covers'));

    const rel = 'Sult - Knut Hamsun/Sult - Knut Hamsun.epub';
    await writeEpubAt(rel, 'Sult', 'Knut Hamsun');
    await scanLibrary(books, index, covers);

    const file = path.join(books, rel);
    const before = index.get(bookId(rel));
    await writeEpubAt(rel, 'Sult (revised edition with a much longer title)', 'Knut Hamsun');
    await utimes(file, new Date(before!.mtimeMs), new Date(before!.mtimeMs));

    const again = await scanLibrary(books, index, covers);
    expect(again).toMatchObject({ updated: 1, unchanged: 0 });
    expect(index.get(bookId(rel))?.metadata.title).toMatch(/revised edition/);

    index.close();
  });

  it('records a corrupt book as an error and keeps going', async () => {
    const books = path.join(root, 'books');
    const index = new LibraryIndex(':memory:');
    const covers = new CoverCache(path.join(root, 'covers'));

    await writeEpubAt('Good/good.epub', 'Good Book', 'An Author');
    await mkdir(path.join(books, 'Bad'), { recursive: true });
    await writeFile(path.join(books, 'Bad', 'bad.epub'), 'this is not a zip');

    const summary = await scanLibrary(books, index, covers);
    expect(summary.seen).toBe(2);
    expect(summary.added).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]?.path).toBe('Bad/bad.epub');
    expect(index.count()).toBe(1);

    index.close();
  });

  it('reports discovery and numbered scan progress', async () => {
    const books = path.join(root, 'books');
    const index = new LibraryIndex(':memory:');
    const covers = new CoverCache(path.join(root, 'covers'));
    await writeEpubAt('First/first.epub', 'First', 'One');
    await writeEpubAt('Second/second.epub', 'Second', 'Two');
    const progress = vi.fn();

    await scanLibrary(books, index, covers, { onProgress: progress });

    expect(progress.mock.calls.map(([value]) => value)).toEqual([
      { phase: 'discovering', found: 1 },
      { phase: 'discovering', found: 2 },
      { phase: 'scanning', current: 0, total: 2 },
      { phase: 'scanning', current: 1, total: 2 },
      { phase: 'scanning', current: 2, total: 2 },
    ]);
    index.close();
  });

  // Every save replaces the file by rename, so the file's own birth time would
  // reset on each edit; the folder is what records when the book arrived.
  it('dates a book by its folder, and backfills rows indexed before that existed', async () => {
    const books = path.join(root, 'books');
    const index = new LibraryIndex(':memory:');
    const covers = new CoverCache(path.join(root, 'covers'));
    const rel = 'Sult - Knut Hamsun/Sult - Knut Hamsun.epub';
    await writeEpubAt(rel, 'Sult', 'Knut Hamsun');

    await scanLibrary(books, index, covers);
    const book = index.get(bookId(rel))!;
    expect(book.addedAt).toBeGreaterThan(0);
    // Only checkable where the test filesystem records birth times at all.
    const born = Math.floor((await stat(path.join(books, 'Sult - Knut Hamsun'))).birthtimeMs);
    if (born > 0) expect(book.addedAt).toBe(born);

    index.setAddedAt(book.id, 0);
    const again = await scanLibrary(books, index, covers);
    expect(again).toMatchObject({ unchanged: 1, updated: 0 });
    expect(index.get(book.id)?.addedAt).toBe(book.addedAt);

    index.close();
  });
});

describe('RevisionStore', () => {
  it('keeps the exact pre-write EPUB outside the library and can restore it atomically', async () => {
    const relative = 'Sult/Sult.epub';
    const file = path.join(root, 'books', relative);
    await writeEpubAt(relative, 'Sult', 'Knut Hamsun');

    const revisions = new RevisionStore(path.join(root, 'data', 'revisions'));
    await revisions.init();
    const saved = await revisions.capture(bookId(relative), file);

    await saveEpubFile(file, { title: 'Hunger' });
    expect((await readEpubFile(file)).metadata.title).toBe('Hunger');

    const snapshot = await revisions.read(bookId(relative), saved.id);
    expect(snapshot).not.toBeNull();
    await saveEpubFile(file, {}, { replacement: snapshot! });
    expect((await readEpubFile(file)).metadata.title).toBe('Sult');
    expect(await revisions.list(bookId(relative))).toMatchObject([
      { id: saved.id, metadata: { title: 'Sult' } },
    ]);
  });

  it('prunes old snapshots to the configured per-book limit', async () => {
    const relative = 'Sult/Sult.epub';
    const file = path.join(root, 'books', relative);
    await writeEpubAt(relative, 'Sult', 'Knut Hamsun');
    const revisions = new RevisionStore(path.join(root, 'data', 'revisions'), 2);
    await revisions.init();

    await revisions.capture(bookId(relative), file);
    await revisions.capture(bookId(relative), file);
    await revisions.capture(bookId(relative), file);

    expect(await revisions.list(bookId(relative))).toHaveLength(2);
  });

  it('marks whether each snapshot cover differs from the current one', async () => {
    const relative = 'Sult/Sult.epub';
    const file = path.join(root, 'books', relative);
    await writeEpubAt(relative, 'Sult', 'Knut Hamsun');
    const revisions = new RevisionStore(path.join(root, 'data', 'revisions'));
    await revisions.init();
    const id = bookId(relative);
    const thumbnail = Buffer.from('jpeg-a');

    await revisions.capture(id, file, {
      metadata: (await readEpubFile(file)).metadata,
      hasCover: true,
      thumbnail,
    });
    expect(await revisions.listComparedTo(id, Buffer.from('jpeg-a'))).toMatchObject([
      { coverChanged: false },
    ]);
    expect(await revisions.listComparedTo(id, Buffer.from('jpeg-b'))).toMatchObject([
      { coverChanged: true },
    ]);
    expect(await revisions.listComparedTo(id, null)).toMatchObject([{ coverChanged: true }]);

    await revisions.capture(id, file, {
      metadata: (await readEpubFile(file)).metadata,
      hasCover: false,
    });
    const [newest] = await revisions.listComparedTo(id, null);
    expect(newest).toMatchObject({ hasCover: false, coverChanged: false });
  });
});

describe('LibraryIndex', () => {
  const makeBook = (
    title: string,
    author: string,
    series = '',
    times: { addedAt?: number; mtimeMs?: number } = {},
  ): LibraryBook => ({
    id: bookId(`${title}.epub`),
    path: `${title}.epub`,
    folder: '',
    fileSize: 1000,
    mtimeMs: times.mtimeMs ?? 1,
    addedAt: times.addedAt ?? 1,
    epubVersion: '3.0',
    metadata: {
      ...emptyMetadata(),
      title,
      author,
      authors: [{ name: author, role: 'aut', fileAs: null }],
      series,
      subjects: ['Fiction'],
    },
    hasCover: false,
    scannedAt: Date.now(),
  });

  it('lists, searches by prefix and sorts', () => {
    const index = new LibraryIndex(':memory:');
    index.upsert(makeBook('War and Peace', 'Leo Tolstoy'));
    index.upsert(makeBook('Crime and Punishment', 'Fyodor Dostoyevsky'));
    index.upsert(makeBook('Sult', 'Knut Hamsun'));

    expect(index.list({ sort: 'title' }).map((b) => b.metadata.title)).toEqual([
      'Crime and Punishment',
      'Sult',
      'War and Peace',
    ]);
    expect(index.list({ sort: 'author' })[0]?.metadata.author).toBe('Fyodor Dostoyevsky');

    // Prefix matching: the search box filters while the user is still typing.
    expect(index.list({ search: 'dosto' })).toHaveLength(1);
    expect(index.list({ search: 'peace' })).toHaveLength(1);
    expect(index.count('dosto')).toBe(1);
    expect(index.count()).toBe(3);

    index.close();
  });

  it('sorts newest first by arrival or by last modification', () => {
    const index = new LibraryIndex(':memory:');
    index.upsert(makeBook('Old but edited', 'A', '', { addedAt: 100, mtimeMs: 900 }));
    index.upsert(makeBook('New arrival', 'B', '', { addedAt: 500, mtimeMs: 500 }));
    index.upsert(makeBook('Untouched', 'C', '', { addedAt: 200, mtimeMs: 200 }));

    const titles = (sort: 'added' | 'modified'): string[] =>
      index.list({ sort }).map((book) => book.metadata.title);
    expect(titles('added')).toEqual(['New arrival', 'Untouched', 'Old but edited']);
    expect(titles('modified')).toEqual(['Old but edited', 'New arrival', 'Untouched']);
    index.close();
  });

  it('orders browse views by author sort name and numeric series position', () => {
    const index = new LibraryIndex(':memory:');
    const leGuin = makeBook('A Wizard of Earthsea', 'Ursula K. Le Guin', 'Earthsea');
    leGuin.metadata.authors[0]!.fileAs = 'Le Guin, Ursula K.';
    leGuin.metadata.seriesIndex = '1';
    const asimov = makeBook('Foundation', 'Isaac Asimov', 'Foundation');
    asimov.metadata.authors[0]!.fileAs = 'Asimov, Isaac';
    asimov.metadata.seriesIndex = '10';
    const second = makeBook('Foundation and Empire', 'Isaac Asimov', 'Foundation');
    second.metadata.authors[0]!.fileAs = 'Asimov, Isaac';
    second.metadata.seriesIndex = '2';
    const standalone = makeBook('Authorless', '');

    for (const book of [leGuin, asimov, second, standalone]) index.upsert(book);

    expect(index.list({ sort: 'author' }).map((book) => book.metadata.title)).toEqual([
      'Foundation',
      'Foundation and Empire',
      'A Wizard of Earthsea',
      'Authorless',
    ]);
    expect(index.list({ sort: 'series' }).map((book) => book.metadata.title)).toEqual([
      'A Wizard of Earthsea',
      'Foundation and Empire',
      'Foundation',
      'Authorless',
    ]);
    index.close();
  });

  // The sort comes from a query string and is interpolated into SQL.
  it('falls back to title order for an unknown sort', () => {
    const index = new LibraryIndex(':memory:');
    index.upsert(makeBook('B', 'x'));
    index.upsert(makeBook('A', 'y'));
    const sort = 'nonsense; DROP TABLE books' as 'title';
    expect(index.list({ sort }).map((book) => book.metadata.title)).toEqual(['A', 'B']);
    index.close();
  });

  it('replaces the search entry on update instead of accumulating', () => {
    const index = new LibraryIndex(':memory:');
    const book = makeBook('Old Title', 'An Author');
    index.upsert(book);
    index.upsert({ ...book, metadata: { ...book.metadata, title: 'New Title' } });

    expect(index.list({ search: 'Old' })).toHaveLength(0);
    expect(index.list({ search: 'New' })).toHaveLength(1);
    index.close();
  });

  // A bare apostrophe or hyphen is FTS5 syntax; unquoted it throws rather than
  // returning nothing, which would take out the whole list view.
  it('survives punctuation in the search box', () => {
    const index = new LibraryIndex(':memory:');
    index.upsert(makeBook("Captain Stormfield's Visit", 'Mark Twain'));
    expect(() => index.list({ search: "Stormfield's" })).not.toThrow();
    expect(() => index.list({ search: 'a - b "quoted"' })).not.toThrow();
    index.close();
  });

  it('quotes every term in an FTS query and makes it a prefix match', () => {
    expect(ftsQuery('knut hamsun')).toBe('"knut"* "hamsun"*');
    expect(ftsQuery('say "what"')).toBe('"say"* """what"""*');
  });
});

describe('absDrift', () => {
  const book: LibraryBook = {
    id: 'a',
    path: 'a.epub',
    folder: '',
    fileSize: 1,
    mtimeMs: 1,
    addedAt: 1,
    epubVersion: '3.0',
    metadata: {
      ...emptyMetadata(),
      title: 'The Trial',
      author: 'Franz Kafka',
      authors: [{ name: 'Franz Kafka', role: 'aut', fileAs: null }],
      publisher: 'Schocken',
      date: '1925-01-01',
      language: 'en',
    },
    hasCover: true,
    scannedAt: 1,
  };

  const abs: AbsBook = {
    id: 'li_1',
    libraryId: 'lib_1',
    path: '/books/The Trial',
    title: 'The Trial',
    authors: ['Franz Kafka'],
    series: [],
    narrators: [],
    publishedYear: '1925',
    publisher: 'Schocken',
    description: null,
    genres: [],
    language: 'en',
    isbn: null,
    coverPath: null,
    updatedAt: 0,
  };

  it('reports nothing when the two agree', () => {
    expect(absDrift(book, abs)).toEqual([]);
  });

  it('reports nothing when ABS is not configured', () => {
    expect(absDrift(book, null)).toEqual([]);
  });

  // ABS stores only a year, so a full EPUB date in the same year is agreement.
  it('compares the ABS year against the EPUB date year', () => {
    expect(absDrift(book, { ...abs, publishedYear: '1925' })).toEqual([]);
    expect(absDrift(book, { ...abs, publishedYear: '1926' })).toEqual(['date']);
  });

  it('catches a title overridden in ABS but never written to the file', () => {
    expect(absDrift(book, { ...abs, title: 'Der Process' })).toEqual(['title']);
  });

  it('catches an extra author on one side', () => {
    expect(absDrift(book, { ...abs, authors: ['Franz Kafka', 'Willa Muir'] })).toEqual(['authors']);
  });

  it('carries both values and the edit that would make the file agree', () => {
    const [difference] = absDifferences(book, { ...abs, title: 'Der Process' });
    expect(difference).toEqual({
      field: 'title',
      label: 'Title',
      file: 'The Trial',
      abs: 'Der Process',
      adopt: { title: 'Der Process', subtitle: '' },
    });
  });

  it("keeps each author's role when adopting ABS's spelling", () => {
    const translated = {
      ...book,
      metadata: {
        ...book.metadata,
        authors: [
          { name: 'Franz Kafka', role: 'aut', fileAs: 'Kafka, Franz' },
          { name: 'W. Muir', role: 'trl', fileAs: null },
        ],
      },
    };
    const [difference] = absDifferences(translated, {
      ...abs,
      authors: ['Franz Kafka', 'Willa Muir'],
    });
    expect(difference?.adopt).toEqual({
      authors: [
        { name: 'Franz Kafka', role: 'aut', fileAs: 'Kafka, Franz' },
        { name: 'Willa Muir', role: 'trl', fileAs: null },
      ],
    });
  });

  it('treats a subtitle kept apart in ABS as the same title', () => {
    const joined = { ...book, metadata: { ...book.metadata, title: 'The Trial: A Novel' } };
    expect(absDrift(joined, { ...abs, title: 'The Trial', subtitle: 'A Novel' })).toEqual([]);
  });

  it('compares a series position as a number, and reports a different one', () => {
    const numbered = { ...book, metadata: { ...book.metadata, series: 'K', seriesIndex: '1' } };
    expect(absDrift(numbered, { ...abs, series: [{ name: 'K', sequence: '1.0' }] })).toEqual([]);
    expect(absDrift(numbered, { ...abs, series: [{ name: 'K', sequence: '2' }] })).toEqual([
      'series',
    ]);
  });

  it('ignores ISBN hyphenation and language code length', () => {
    const coded = { ...book, metadata: { ...book.metadata, identifier: '978-0-8052-0999-0' } };
    expect(absDrift(coded, { ...abs, isbn: '9780805209990', language: 'eng' })).toEqual([]);
  });

  it('shows a language name from ABS but does not offer to write it', () => {
    const [difference] = absDifferences(book, { ...abs, language: 'German' });
    expect(difference).toMatchObject({ field: 'language', abs: 'German', adopt: null });
  });

  it('maps only selected file fields into Audiobookshelf metadata', () => {
    const metadata = {
      ...book.metadata,
      subtitle: 'A Novel',
      series: 'Classics',
      seriesIndex: '3',
      identifier: '9780805209990',
    };
    expect(absMetadataPatch(metadata, ['title', 'series'])).toEqual({
      title: 'The Trial',
      subtitle: 'A Novel',
      series: [{ name: 'Classics', sequence: '3' }],
    });
    expect(absMetadataPatch(metadata, ['date', 'authors', 'identifier', 'language'])).toEqual({
      publishedYear: '1925',
      publishedDate: '1925-01-01',
      authors: [{ name: 'Franz Kafka' }],
      isbn: '9780805209990',
      language: 'en',
    });
  });
});

// Response shapes below are ABS 2.33.1's, read from its server source: the
// library listing is minified, the batch endpoint is expanded, and the scan
// endpoint answers in plain text.
describe('AbsClient', () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

  function serve(routes: Record<string, (init?: RequestInit) => Response>): void {
    vi.stubGlobal('fetch', async (input: URL, init?: RequestInit) => {
      const url = new URL(input);
      calls.push({ url: url.pathname + url.search, init });
      const route = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
      return route ? route(init) : new Response('Not Found', { status: 404 });
    });
  }

  const client = () => new AbsClient({ url: 'http://abs', token: 't', booksRoot: '/books' });

  afterEach(() => {
    vi.unstubAllGlobals();
    calls.length = 0;
  });

  it('reads authors and series from the expanded records, not the listing', async () => {
    serve({
      'GET /api/libraries': () =>
        Response.json({
          libraries: [
            { id: 'lib_books', name: 'Ebooks', mediaType: 'book' },
            { id: 'lib_pods', name: 'Podcasts', mediaType: 'podcast' },
          ],
        }),
      'GET /api/libraries/lib_books/items': () =>
        Response.json({
          results: [
            {
              id: 'li_1',
              path: '/books/Good Omens',
              media: { metadata: { authorName: 'Terry Pratchett, Neil Gaiman', seriesName: '' } },
            },
            { id: 'li_2', path: '/elsewhere/Stray', media: { metadata: {} } },
          ],
        }),
      'POST /api/items/batch/get': (init) => {
        const ids = (JSON.parse(String(init?.body)) as { libraryItemIds: string[] }).libraryItemIds;
        expect(ids).toEqual(['li_1', 'li_2']);
        return Response.json({
          libraryItems: [
            {
              id: 'li_1',
              libraryId: 'lib_books',
              path: '/books/Good Omens',
              relPath: 'Good Omens',
              media: {
                metadata: {
                  title: 'Good Omens',
                  authors: [
                    { id: 'au_1', name: 'Terry Pratchett' },
                    { id: 'au_2', name: 'Neil Gaiman' },
                  ],
                  series: [{ id: 'se_1', name: 'Discworld-adjacent', sequence: '1' }],
                  narrators: [],
                },
              },
            },
            { id: 'li_2', libraryId: 'lib_books', path: '/elsewhere/Stray', media: {} },
          ],
        });
      },
    });

    const items = await client().allItems();

    // The podcast library is never listed; the item outside the books root has no key.
    expect([...items.keys()]).toEqual(['Good Omens']);
    expect(items.get('Good Omens')).toMatchObject({
      id: 'li_1',
      authors: ['Terry Pratchett', 'Neil Gaiman'],
      series: [{ name: 'Discworld-adjacent', sequence: '1' }],
    });
    expect(calls.map((c) => c.url)).not.toContain('/api/libraries/lib_pods/items?limit=0');
  });

  it('keys by the path below the books root, not the ABS library-relative path', async () => {
    serve({
      'GET /api/libraries': () =>
        Response.json({ libraries: [{ id: 'lib', name: 'Fiction', mediaType: 'book' }] }),
      'GET /api/libraries/lib/items': () => Response.json({ results: [{ id: 'li_1' }] }),
      // An ABS library rooted at /books/Fiction: relPath drops the Fiction/ that
      // Calliope's own key carries.
      'POST /api/items/batch/get': () =>
        Response.json({
          libraryItems: [
            { id: 'li_1', libraryId: 'lib', path: '/books/Fiction/Sult', relPath: 'Sult' },
          ],
        }),
    });

    expect([...(await client().allItems()).keys()]).toEqual(['Fiction/Sult']);
  });

  it('accepts the plain-text OK that the scan endpoint answers with', async () => {
    serve({
      'GET /api/libraries': () =>
        Response.json({ libraries: [{ id: 'lib', name: 'Ebooks', mediaType: 'book' }] }),
      'POST /api/libraries/lib/scan': () =>
        new Response('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    });

    await expect(client().rescanAll()).resolves.toBeUndefined();
  });

  it('reports a non-admin key as a failed rescan', async () => {
    serve({
      'GET /api/libraries': () =>
        Response.json({ libraries: [{ id: 'lib', name: 'Ebooks', mediaType: 'book' }] }),
      'POST /api/libraries/lib/scan': () => new Response('Forbidden', { status: 403 }),
    });

    await expect(client().rescanAll()).rejects.toThrow('responded 403');
  });

  it('updates only the selected Audiobookshelf metadata', async () => {
    serve({
      'PATCH /api/items/li_1/media': (init) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          metadata: { title: 'The Trial', subtitle: null },
        });
        return Response.json({
          id: 'li_1',
          libraryId: 'lib',
          path: '/books/The Trial',
          media: { metadata: { title: 'The Trial', authors: [{ name: 'Franz Kafka' }] } },
        });
      },
    });

    await expect(
      client().updateMetadata('li_1', { title: 'The Trial', subtitle: null }),
    ).resolves.toMatchObject({ id: 'li_1', title: 'The Trial', authors: ['Franz Kafka'] });
  });
});
