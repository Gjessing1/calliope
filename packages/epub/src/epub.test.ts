import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { normalizeLanguageCode } from './language.js';
import { normalizeDateFormat, normalizeMetadata, stripHTML } from './normalize.js';
import { extractMetadata, readEpub } from './read.js';
import { writeEpub } from './write.js';
import type { MetadataUpdate } from '@calliope/core';
import { collectIds, refinedId } from './opf.js';
import { sanitizeMetadataString } from './sanitize.js';

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

/** Build a minimal but valid-enough EPUB for the engine to round-trip. */
async function makeEpub(version: '2.0' | '3.0', metadataXml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', CONTAINER);
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${version}" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
${metadataXml}
  </metadata>
  <manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="nav"/></spine>
</package>`,
  );
  zip.file('OEBPS/nav.xhtml', '<html><body/></html>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

const BASE_META = `    <dc:title>Crime and Punishment</dc:title>
    <dc:creator>Fyodor Dostoyevsky</dc:creator>
    <dc:language>rus</dc:language>
    <dc:identifier id="bookid">urn:uuid:1f0e3dad-9990-4b2e-8b3a-000000000001</dc:identifier>`;

describe('normalizeLanguageCode', () => {
  it('converts a 3-letter code to its 2-letter form', () => {
    expect(normalizeLanguageCode('nor')).toEqual({
      code: 'no',
      converted: true,
      original: 'nor',
    });
  });

  it('preserves a region subtag and uppercases it', () => {
    expect(normalizeLanguageCode('en_us').code).toBe('en-US');
  });

  it('warns rather than guessing on an unknown code', () => {
    const result = normalizeLanguageCode('zz');
    expect(result.code).toBe('zz');
    expect(result.warning).toMatch(/Unknown language code/);
  });

  it('warns on an unconvertible 3-letter code', () => {
    expect(normalizeLanguageCode('xyz').warning).toMatch(/Could not convert/);
  });

  it('returns an empty code for empty input', () => {
    expect(normalizeLanguageCode('')).toEqual({ code: '' });
  });
});

describe('normalizeDateFormat', () => {
  it('keeps an already-normal date', () => {
    expect(normalizeDateFormat('1866-01-01')).toBe('1866-01-01');
    expect(normalizeDateFormat('1866')).toBe('1866');
  });

  // Date-only strings parse as UTC midnight; local getters would report the
  // previous day west of Greenwich and shift every date back by one.
  it('does not shift the day across timezones', () => {
    expect(normalizeDateFormat('2020-03-01T00:00:00Z')).toBe('2020-03-01');
  });

  it('falls back to the year when the string is not a date', () => {
    expect(normalizeDateFormat('published sometime in 1866, probably')).toBe('1866');
  });
});

describe('stripHTML', () => {
  it('removes tags and decodes the common entities', () => {
    expect(stripHTML('<p>Crime &amp; Punishment&nbsp;&#39;66</p>')).toBe("Crime & Punishment '66");
  });
});

describe('sanitizeMetadataString', () => {
  it('strips control characters that would make the OPF unparseable', () => {
    expect(sanitizeMetadataString('Tit\u0000le\u0007')).toBe('Title');
  });

  it('keeps newlines and tabs', () => {
    expect(sanitizeMetadataString('one\ntwo\tthree')).toBe('one\ntwo\tthree');
  });

  it('returns an empty string for a non-string', () => {
    expect(sanitizeMetadataString(undefined)).toBe('');
    expect(sanitizeMetadataString(42)).toBe('');
  });
});

describe('extractMetadata', () => {
  it('reads the basics and normalizes the language', async () => {
    const opened = await readEpub(await makeEpub('3.0', BASE_META));
    const meta = extractMetadata(opened.meta);
    expect(meta.title).toBe('Crime and Punishment');
    expect(meta.author).toBe('Fyodor Dostoyevsky');
    expect(meta.authors).toEqual([{ name: 'Fyodor Dostoyevsky', role: 'aut', fileAs: null }]);
    expect(meta.language).toBe('ru');
    expect(meta.languageConverted).toBe('rus');
  });

  it('picks the main title and the subtitle apart via title-type refinements', async () => {
    const opened = await readEpub(
      await makeEpub(
        '3.0',
        `    <dc:title id="t1">The Trial</dc:title>
    <dc:title id="t2">A Novel</dc:title>
    <meta refines="#t1" property="title-type">main</meta>
    <meta refines="#t2" property="title-type">subtitle</meta>
    <dc:identifier id="bookid">x</dc:identifier>`,
      ),
    );
    const meta = extractMetadata(opened.meta);
    expect(meta.title).toBe('The Trial');
    expect(meta.subtitle).toBe('A Novel');
  });

  it('finds the ISBN among several identifiers and leaves the others alone', async () => {
    const opened = await readEpub(
      await makeEpub(
        '3.0',
        `    <dc:title>x</dc:title>
    <dc:identifier id="bookid">urn:uuid:abc</dc:identifier>
    <dc:identifier id="asin">B000FC1PJI</dc:identifier>
    <dc:identifier id="isbn" opf:scheme="ISBN">978-0-14-044913-6</dc:identifier>`,
      ),
    );
    expect(extractMetadata(opened.meta).identifier).toBe('978-0-14-044913-6');
  });

  // A self-closing or attribute-only element parses as an object, not a string;
  // coercing with String() would put "[object Object]" into the field.
  it('does not leak an object into a field for an attribute-only element', async () => {
    const opened = await readEpub(
      await makeEpub(
        '3.0',
        `    <dc:title>x</dc:title>
    <dc:publisher id="pub"/>
    <dc:identifier id="bookid">x</dc:identifier>`,
      ),
    );
    expect(extractMetadata(opened.meta).publisher).toBe('');
  });

  it('reads EPUB 2 series from the calibre meta tags', async () => {
    const opened = await readEpub(
      await makeEpub(
        '2.0',
        `    <dc:title>x</dc:title>
    <dc:identifier id="bookid">x</dc:identifier>
    <meta name="calibre:series" content="Discworld"/>
    <meta name="calibre:series_index" content="3"/>`,
      ),
    );
    const meta = extractMetadata(opened.meta);
    expect(meta.series).toBe('Discworld');
    expect(meta.seriesIndex).toBe('3');
  });
});

describe('writeEpub — EPUB 3', () => {
  it('round-trips a full edit', async () => {
    const opened = await readEpub(await makeEpub('3.0', BASE_META));
    const { buffer, warnings } = await writeEpub(opened.zip, opened.opfPath, opened.opf, {
      title: 'Crime and Punishment',
      subtitle: 'A Novel in Six Parts',
      authors: [{ name: 'Fyodor Dostoyevsky', role: 'aut', fileAs: 'Dostoyevsky, Fyodor' }],
      language: 'ru',
      publisher: 'The Russian Messenger',
      date: '1866',
      identifier: '9780140449136',
      series: 'Penguin Classics',
      seriesIndex: '12',
      subjects: ['Fiction', 'Russian literature'],
    });
    expect(warnings).toEqual([]);

    const back = extractMetadata((await readEpub(buffer)).meta);
    // Title and subtitle are deliberately merged into one dc:title, because
    // readers do not implement the multi-title form.
    expect(back.title).toBe('Crime and Punishment: A Novel in Six Parts');
    expect(back.authors[0]?.fileAs).toBe('Dostoyevsky, Fyodor');
    expect(back.publisher).toBe('The Russian Messenger');
    expect(back.identifier).toBe('9780140449136');
    expect(back.series).toBe('Penguin Classics');
    expect(back.seriesIndex).toBe('12');
    expect(back.subjects).toEqual(['Fiction', 'Russian literature']);
  });

  it('keeps the existing unique-identifier and preserves foreign identifiers', async () => {
    const opened = await readEpub(
      await makeEpub(
        '3.0',
        `    <dc:title>x</dc:title>
    <dc:identifier id="bookid">urn:uuid:abc</dc:identifier>
    <dc:identifier id="asin">B000FC1PJI</dc:identifier>`,
      ),
    );
    const { buffer } = await writeEpub(opened.zip, opened.opfPath, opened.opf, {
      identifier: '9780140449136',
    });
    const reopened = await readEpub(buffer);
    // The package still points at the id it always pointed at.
    expect(reopened.opf.package.$?.['unique-identifier']).toBe('bookid');
    const ids = (reopened.meta['dc:identifier'] ?? []).map((n) =>
      typeof n === 'string' ? n : n._,
    );
    expect(ids).toContain('B000FC1PJI');
    expect(ids).toContain('9780140449136');
  });

  it('writes role and file-as as refinements, never as opf:* attributes', async () => {
    const opened = await readEpub(await makeEpub('3.0', BASE_META));
    const { buffer } = await writeEpub(opened.zip, opened.opfPath, opened.opf, {
      authors: [{ name: 'Constance Garnett', role: 'trl', fileAs: 'Garnett, Constance' }],
    });
    const reopened = await readEpub(buffer);
    const creator = reopened.meta['dc:creator']?.[0];
    expect(typeof creator === 'string' ? {} : (creator?.$ ?? {})).not.toHaveProperty('opf:role');
    expect(reopened.meta.meta?.some((m) => m.$?.property === 'role' && m._ === 'trl')).toBe(true);
    // And the role survives the round trip back out.
    expect(extractMetadata(reopened.meta).authors[0]?.role).toBe('trl');
  });

  it('can explicitly clear every author and its refinements', async () => {
    const opened = await readEpub(await makeEpub('3.0', BASE_META));
    const first = await writeEpub(opened.zip, opened.opfPath, opened.opf, {
      authors: [{ name: 'Constance Garnett', role: 'trl', fileAs: 'Garnett, Constance' }],
    });
    const withRefinements = await readEpub(first.buffer);
    const cleared = await writeEpub(
      withRefinements.zip,
      withRefinements.opfPath,
      withRefinements.opf,
      { authors: [] },
    );
    const reopened = await readEpub(cleared.buffer);
    expect(reopened.meta['dc:creator']).toBeUndefined();
    expect(reopened.meta.meta?.some((meta) => meta.$?.property === 'role')).toBe(false);
  });

  it('stamps dcterms:modified exactly once', async () => {
    const opened = await readEpub(await makeEpub('3.0', BASE_META));
    const once = await writeEpub(opened.zip, opened.opfPath, opened.opf, { title: 'a' });
    const reopened = await readEpub(once.buffer);
    const twice = await writeEpub(reopened.zip, reopened.opfPath, reopened.opf, { title: 'b' });
    const final = await readEpub(twice.buffer);
    const stamps = final.meta.meta?.filter((m) => m.$?.property === 'dcterms:modified') ?? [];
    expect(stamps).toHaveLength(1);
    expect(stamps[0]?._).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('clears a field on empty string but leaves it alone on undefined', async () => {
    const opened = await readEpub(
      await makeEpub('3.0', `${BASE_META}\n    <dc:publisher>Vintage</dc:publisher>`),
    );
    const untouched = await writeEpub(opened.zip, opened.opfPath, opened.opf, { title: 'x' });
    expect(extractMetadata((await readEpub(untouched.buffer)).meta).publisher).toBe('Vintage');

    const reopened = await readEpub(untouched.buffer);
    const cleared = await writeEpub(reopened.zip, reopened.opfPath, reopened.opf, {
      publisher: '',
    });
    expect(extractMetadata((await readEpub(cleared.buffer)).meta).publisher).toBe('');
  });

  it('warns when the book would end up without a title or identifier', async () => {
    const opened = await readEpub(await makeEpub('3.0', '    <dc:language>en</dc:language>'));
    const { warnings } = await writeEpub(opened.zip, opened.opfPath, opened.opf, {});
    expect(warnings).toEqual([
      'EPUB requires a title (dc:title)',
      'EPUB requires at least one identifier (dc:identifier)',
    ]);
  });
});

/**
 * The shape Project Gutenberg ships and this library is full of: a translator as
 * a `dc:contributor` whose role and sort name are refinements, next to the
 * author's own, plus a set collection that is not a series.
 */
const GUTENBERG_META = `    <dc:identifier id="bookid">http://www.gutenberg.org/1004</dc:identifier>
    <dc:creator id="author_0">Dante Alighieri</dc:creator>
    <meta property="file-as" refines="#author_0">Dante Alighieri</meta>
    <meta property="role" refines="#author_0" scheme="marc:relators">aut</meta>
    <meta property="alternate-script" refines="#author_0" xml:lang="it">Durante degli Alighieri</meta>
    <meta property="file-as" refines="#author_1">Longfellow, Henry Wadsworth</meta>
    <meta property="role" refines="#author_1" scheme="marc:relators">trl</meta>
    <dc:contributor id="author_1">Henry Wadsworth Longfellow</dc:contributor>
    <dc:title id="main">The Divine Comedy</dc:title>
    <meta property="file-as" refines="#main">Divine Comedy, The</meta>
    <meta property="belongs-to-collection" id="set">Harvard Classics</meta>
    <meta property="collection-type" refines="#set">set</meta>
    <meta property="group-position" refines="#set">20</meta>
    <meta property="belongs-to-collection" id="c1">Commedia</meta>
    <meta property="collection-type" refines="#c1">series</meta>
    <meta property="group-position" refines="#c1">1</meta>
    <dc:language>en</dc:language>`;

/** What the editor sends: every field, straight from what the reader returned. */
function editorForm(buffer: Buffer): Promise<MetadataUpdate> {
  return readEpub(buffer).then(({ meta }) => {
    const m = extractMetadata(meta);
    return {
      ...m,
      contributors: m.contributors.map((c) => c.name).join(', '),
    };
  });
}

async function edit(buffer: Buffer, update: MetadataUpdate): Promise<Buffer> {
  const opened = await readEpub(buffer);
  return (await writeEpub(opened.zip, opened.opfPath, opened.opf, update)).buffer;
}

/** Every `<meta refines>` whose target id is nowhere in the package. */
async function danglingRefinements(buffer: Buffer): Promise<string[]> {
  const { opf, meta } = await readEpub(buffer);
  const ids = collectIds(opf.package);
  return (meta.meta ?? [])
    .map((m) => refinedId(m))
    .filter((id): id is string => id !== null && !ids.has(id));
}

describe('writeEpub — what an edit must not break (EPUB 3)', () => {
  it("keeps the translator's role when the author list is rewritten", async () => {
    const book = await makeEpub('3.0', GUTENBERG_META);
    const saved = await edit(book, { ...(await editorForm(book)), title: 'Inferno' });
    const back = extractMetadata((await readEpub(saved)).meta);
    expect(back.contributors).toEqual([{ name: 'Henry Wadsworth Longfellow', role: 'trl' }]);
    expect(back.authors).toEqual([
      { name: 'Dante Alighieri', role: 'aut', fileAs: 'Dante Alighieri' },
    ]);
    expect(await danglingRefinements(saved)).toEqual([]);
  });

  it("keeps an unchanged author's id, so its other refinements stay attached", async () => {
    const book = await makeEpub('3.0', GUTENBERG_META);
    const saved = await edit(book, await editorForm(book));
    const { meta } = await readEpub(saved);
    expect(meta.meta?.find((m) => m.$?.property === 'alternate-script')?.$?.refines).toBe(
      '#author_0',
    );
    expect(await danglingRefinements(saved)).toEqual([]);
  });

  it('drops the refinements of an author or contributor it removes', async () => {
    const book = await makeEpub('3.0', GUTENBERG_META);
    const saved = await edit(book, {
      authors: [{ name: 'Someone Else', role: 'aut', fileAs: null }],
      contributors: '',
    });
    const { meta } = await readEpub(saved);
    expect(await danglingRefinements(saved)).toEqual([]);
    expect(meta.meta?.some((m) => m.$?.property === 'alternate-script')).toBe(false);
    expect(meta.meta?.some((m) => m._ === 'trl')).toBe(false);
  });

  it('leaves the series alone when the update does not mention it', async () => {
    const book = await makeEpub('3.0', GUTENBERG_META);
    const saved = await edit(book, { language: 'it' });
    const back = extractMetadata((await readEpub(saved)).meta);
    expect(back.series).toBe('Commedia');
    expect(back.seriesIndex).toBe('1');
  });

  it('reads and writes the series, never the set beside it', async () => {
    const book = await makeEpub('3.0', GUTENBERG_META);
    expect(extractMetadata((await readEpub(book)).meta).series).toBe('Commedia');

    const renamed = await edit(book, { series: 'Divina Commedia', seriesIndex: '2' });
    const back = extractMetadata((await readEpub(renamed)).meta);
    expect([back.series, back.seriesIndex]).toEqual(['Divina Commedia', '2']);

    const cleared = await edit(renamed, { series: '', seriesIndex: '' });
    const { meta } = await readEpub(cleared);
    expect(extractMetadata(meta).series).toBe('');
    const set = meta.meta?.find((m) => m.$?.id === 'set');
    expect(set?._).toBe('Harvard Classics');
    expect(meta.meta?.some((m) => m.$?.refines === '#set' && m._ === '20')).toBe(true);
    expect(await danglingRefinements(cleared)).toEqual([]);
  });

  it("keeps Calibre's legacy series meta in step, so a cleared series stays cleared", async () => {
    const book = await makeEpub(
      '3.0',
      `${BASE_META}\n    <meta name="calibre:series" content="Old"/>\n    <meta name="calibre:series_index" content="4"/>`,
    );
    expect(extractMetadata((await readEpub(book)).meta).series).toBe('Old');
    const cleared = await edit(book, { series: '', seriesIndex: '' });
    expect(extractMetadata((await readEpub(cleared)).meta).series).toBe('');

    const renamed = await edit(book, { series: 'New', seriesIndex: '5' });
    const { meta } = await readEpub(renamed);
    expect(meta.meta?.find((m) => m.$?.name === 'calibre:series')?.$?.content).toBe('New');
    expect(extractMetadata(meta).series).toBe('New');
  });

  it('keeps an unchanged title element, and with it the sort title', async () => {
    const book = await makeEpub('3.0', GUTENBERG_META);
    const saved = await edit(book, await editorForm(book));
    const { meta } = await readEpub(saved);
    expect(meta.meta?.some((m) => m.$?.refines === '#main' && m._ === 'Divine Comedy, The')).toBe(
      true,
    );

    const retitled = await edit(book, { title: 'Inferno' });
    expect(await danglingRefinements(retitled)).toEqual([]);
  });

  it('does not touch a subtitle when the title is not being edited', async () => {
    const book = await makeEpub(
      '3.0',
      `    <dc:identifier id="bookid">x</dc:identifier>
    <dc:title id="t1">The Trial</dc:title>
    <meta refines="#t1" property="title-type">main</meta>
    <dc:title id="t2">A Novel</dc:title>
    <meta refines="#t2" property="title-type">subtitle</meta>`,
    );
    const saved = await edit(book, { language: 'de' });
    expect(extractMetadata((await readEpub(saved)).meta).subtitle).toBe('A Novel');
  });
});

describe('writeEpub — the ISBN', () => {
  const WITH_ISBN = `${BASE_META}
    <dc:identifier id="isbn">urn:isbn:9780140449136</dc:identifier>
    <meta refines="#isbn" property="identifier-type" scheme="onix:codelist5">15</meta>`;

  it('clears the ISBN on an empty string, and its refinement with it', async () => {
    const saved = await edit(await makeEpub('3.0', WITH_ISBN), { identifier: '' });
    expect(extractMetadata((await readEpub(saved)).meta).identifier).toBe('');
    expect(await danglingRefinements(saved)).toEqual([]);
  });

  it('keeps an ISBN that is the unique identifier, and says why', async () => {
    const book = await makeEpub(
      '3.0',
      `    <dc:title>x</dc:title>\n    <dc:identifier id="bookid">9780140449136</dc:identifier>`,
    );
    const opened = await readEpub(book);
    const { buffer, warnings } = await writeEpub(opened.zip, opened.opfPath, opened.opf, {
      identifier: '',
    });
    expect(extractMetadata((await readEpub(buffer)).meta).identifier).toBe('9780140449136');
    expect(warnings).toEqual(["The ISBN is also this book's unique identifier, so it was kept"]);
  });

  it('warns instead of silently dropping something that is not an ISBN', async () => {
    const opened = await readEpub(await makeEpub('3.0', WITH_ISBN));
    const { buffer, warnings } = await writeEpub(opened.zip, opened.opfPath, opened.opf, {
      identifier: '12345',
    });
    expect(warnings).toEqual(['"12345" is not an ISBN, so the identifier was left unchanged']);
    expect(extractMetadata((await readEpub(buffer)).meta).identifier).toBe('9780140449136');
  });

  it('updates in place: same element, same urn form, identifier-type kept right', async () => {
    const saved = await edit(await makeEpub('3.0', WITH_ISBN), { identifier: '0140449132' });
    const { meta } = await readEpub(saved);
    const isbn = meta['dc:identifier']?.find((n) => typeof n !== 'string' && n.$?.id === 'isbn');
    expect(typeof isbn === 'string' ? isbn : isbn?._).toBe('urn:isbn:0140449132');
    expect(meta.meta?.find((m) => m.$?.refines === '#isbn')?._).toBe('02');
    expect(meta['dc:identifier']).toHaveLength(2);
  });
});

describe('writeEpub — EPUB 2', () => {
  it('uses opf:* attributes and calibre series, and never EPUB 3 vocabulary', async () => {
    const opened = await readEpub(await makeEpub('2.0', BASE_META));
    const { buffer } = await writeEpub(opened.zip, opened.opfPath, opened.opf, {
      authors: [{ name: 'Constance Garnett', role: 'trl', fileAs: 'Garnett, Constance' }],
      series: 'Penguin Classics',
      seriesIndex: '12',
    });
    const reopened = await readEpub(buffer);

    const creator = reopened.meta['dc:creator']?.[0];
    const attrs = typeof creator === 'string' ? {} : (creator?.$ ?? {});
    expect(attrs['opf:role']).toBe('trl');
    expect(attrs['opf:file-as']).toBe('Garnett, Constance');

    // No refinements and no dcterms:modified: both are EPUB 3 only, and an
    // EPUB 2 reader shown them ignores the element they refine.
    expect(reopened.meta.meta?.some((m) => m.$?.refines)).toBeFalsy();
    expect(reopened.meta.meta?.some((m) => m.$?.property === 'dcterms:modified')).toBeFalsy();
    expect(reopened.meta.meta?.some((m) => m.$?.name === 'calibre:series')).toBe(true);
    expect(extractMetadata(reopened.meta).series).toBe('Penguin Classics');
  });

  it('keeps the package at version 2.0', async () => {
    const opened = await readEpub(await makeEpub('2.0', BASE_META));
    const { buffer } = await writeEpub(opened.zip, opened.opfPath, opened.opf, { title: 'x' });
    expect((await readEpub(buffer)).opf.package.$?.version).toBe('2.0');
  });
});

/**
 * Read the ZIP local file headers directly.
 *
 * JSZip's own `options.compression` comes back null for an entry read out of a
 * loaded archive, so it says nothing about what was written — only the bytes
 * do. Layout: signature (4), ..., compression method at offset 8 (2, LE), ...,
 * filename length at 26 (2, LE), filename at 30.
 */
function zipEntries(buffer: Buffer): Array<{ name: string; method: number }> {
  const entries: Array<{ name: string; method: number }> = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    entries.push({
      name: buffer.subarray(offset + 30, offset + 30 + nameLen).toString('utf8'),
      method,
    });
    offset += 30 + nameLen + extraLen + compressedSize;
  }
  return entries;
}

describe('writeEpub — archive invariants', () => {
  // OCF requires `mimetype` to be the first entry and stored uncompressed, so
  // that a reader can identify the file from its first bytes without inflating
  // anything. Getting this wrong produces an archive that opens fine in every
  // ZIP tool and is rejected by epubcheck and some readers.
  it('writes mimetype first and stored uncompressed', async () => {
    const opened = await readEpub(await makeEpub('3.0', BASE_META));
    const { buffer } = await writeEpub(opened.zip, opened.opfPath, opened.opf, { title: 'x' });

    const entries = zipEntries(buffer);
    expect(entries[0]).toMatchObject({ name: 'mimetype', method: 0 });

    const zip = await JSZip.loadAsync(buffer);
    expect(await zip.file('mimetype')?.async('string')).toBe('application/epub+zip');
  });

  // Everything else must be DEFLATE (method 8): without an explicit option
  // JSZip stores every entry, which roughly doubles a typical EPUB's size.
  it('deflates everything except mimetype', async () => {
    const opened = await readEpub(await makeEpub('3.0', BASE_META));
    const { buffer } = await writeEpub(opened.zip, opened.opfPath, opened.opf, { title: 'x' });

    // Directory entries are zero-length and always stored; only files count.
    const entries = zipEntries(buffer).filter(
      (e) => e.name !== 'mimetype' && !e.name.endsWith('/'),
    );
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map((e) => e.method)).toEqual(entries.map(() => 8));
  });
});

describe('normalizeMetadata', () => {
  it('trims, deduplicates subjects and reports what it converted', () => {
    const result = normalizeMetadata({
      title: '  Sult  ',
      subtitle: '',
      authors: [],
      author: '',
      contributors: [],
      language: 'nor',
      languageConverted: null,
      identifier: '',
      publisher: '',
      date: '1890',
      description: '<p>A novel &amp; a fever dream</p>',
      rights: '',
      series: '',
      seriesIndex: '',
      subjects: ['Fiction', ' Fiction ', 'Norwegian', ''],
    });
    expect(result.title).toBe('Sult');
    expect(result.subjects).toEqual(['Fiction', 'Norwegian']);
    expect(result.description).toBe('A novel & a fever dream');
    expect(result.language).toBe('no');
    expect(result._warnings).toContain('Language code converted: "nor" → "no"');
  });
});
