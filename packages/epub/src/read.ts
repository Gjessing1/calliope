import JSZip from 'jszip';
import { parseStringPromise } from 'xml2js';
import type { Author, BookMetadata, Contributor } from '@calliope/core';
import { normalizeLanguageCode } from './language.js';
import { attrsOf, textOf } from './opf.js';
import type { OpfDocument, OpfMetadata, XmlNode } from './opf.js';

/** An opened EPUB: the archive plus the parsed OPF and where it lives inside it. */
export interface OpenedEpub {
  zip: JSZip;
  /** Path of the OPF inside the archive, as `container.xml` declares it. */
  opfPath: string;
  opf: OpfDocument;
  meta: OpfMetadata;
  /** The `package/@version` attribute, defaulting to `3.0` when absent. */
  version: string;
}

/**
 * Thrown when a file is not a usable EPUB. Distinguished from a programming
 * error so callers can report "this file is broken" rather than a stack trace —
 * a library scan walks whatever is on disk and will meet both.
 */
export class InvalidEpubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEpubError';
  }
}

/** Open an EPUB and parse its OPF. */
export async function readEpub(buffer: Buffer | Uint8Array | ArrayBuffer): Promise<OpenedEpub> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    throw new InvalidEpubError(`Not a readable ZIP archive: ${(err as Error).message}`);
  }

  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new InvalidEpubError('Missing META-INF/container.xml');
  const container = (await parseStringPromise(await containerFile.async('string'))) as {
    container?: { rootfiles?: Array<{ rootfile?: Array<{ $?: Record<string, string> }> }> };
  };

  const opfPath = container.container?.rootfiles?.[0]?.rootfile?.[0]?.$?.['full-path'];
  if (!opfPath) throw new InvalidEpubError('container.xml declares no rootfile full-path');

  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new InvalidEpubError(`OPF not found in archive at ${opfPath}`);
  const opf = (await parseStringPromise(await opfFile.async('string'))) as OpfDocument;

  const meta = opf.package?.metadata?.[0];
  if (!meta) throw new InvalidEpubError('OPF has no <metadata> element');

  return { zip, opfPath, opf, meta, version: opf.package.$?.version ?? '3.0' };
}

/**
 * Extract the metadata Calliope edits out of a parsed OPF.
 *
 * Authors come back as an array (like contributors) rather than a single string,
 * because a book with three authors and per-author `file-as` refinements cannot
 * survive a round-trip through one field. `author` is kept alongside for list
 * views and filenames.
 */
export function extractMetadata(meta: OpfMetadata): BookMetadata {
  const get = (k: string): string => textOf((meta[k] as XmlNode[] | undefined)?.[0]);

  const getMetaProp = (prop: string): string =>
    textOf(meta.meta?.find((m) => m.$?.property === prop));

  // EPUB 2 has no `belongs-to-collection`; the de-facto standard there is
  // Calibre's `<meta name="calibre:series" content="…"/>`, which is also what
  // the writer emits for EPUB 2. Reading only the EPUB 3 property would show an
  // empty series for every EPUB 2 book and then clear it on the next save.
  const getCalibreMeta = (name: string): string =>
    meta.meta?.find((m) => m.$?.name === name)?.$?.content ?? '';

  // Titles: EPUB 3 allows several dc:title distinguished by a title-type
  // refinement. Find the main one and the subtitle; a file with neither
  // refinement gives its first title as the main one.
  let mainTitle = '';
  let subtitle = '';

  if (meta['dc:title']) {
    const titles = Array.isArray(meta['dc:title']) ? meta['dc:title'] : [meta['dc:title']];

    for (const t of titles) {
      const titleValue = textOf(t);
      const titleId = attrsOf(t).id;

      let titleType: string | null = null;
      if (titleId && meta.meta) {
        const typeRefine = meta.meta.find(
          (m) => m.$?.refines === `#${titleId}` && m.$?.property === 'title-type',
        );
        if (typeRefine) titleType = textOf(typeRefine);
      }

      if (titleType === 'subtitle') {
        subtitle = titleValue;
      } else if (titleType === 'main' || !mainTitle) {
        mainTitle = titleValue;
      }
    }
  }

  const authors: Author[] =
    meta['dc:creator']?.map((c) => {
      const attrs = attrsOf(c);
      const author: Author = {
        name: textOf(c),
        role: attrs['opf:role'] || 'aut',
        fileAs: null,
      };

      const id = attrs.id;
      if (id && meta.meta) {
        const fileAs = meta.meta.find(
          (m) => m.$?.refines === `#${id}` && m.$?.property === 'file-as',
        );
        if (fileAs) author.fileAs = textOf(fileAs);
      }

      // EPUB 3 keeps the role in a refinement rather than an opf:role attribute.
      if (id && meta.meta) {
        const roleRefine = meta.meta.find(
          (m) => m.$?.refines === `#${id}` && m.$?.property === 'role',
        );
        if (roleRefine) author.role = textOf(roleRefine) || author.role;
      }

      return author;
    }) ?? [];

  const contributors: Contributor[] =
    meta['dc:contributor']?.map((c) => ({
      name: textOf(c),
      role: attrsOf(c)['opf:role'] || 'contributor',
    })) ?? [];

  // Identifier: an OPF commonly carries several (a UUID, an ASIN, an internal
  // id). Only the one that looks like an ISBN is surfaced for editing; the rest
  // are preserved untouched by the writer.
  let identifier = '';
  if (meta['dc:identifier']) {
    const identifiers = Array.isArray(meta['dc:identifier'])
      ? meta['dc:identifier']
      : [meta['dc:identifier']];

    for (const id of identifiers) {
      const value = textOf(id).trim();
      const attrs = attrsOf(id);
      const scheme = attrs['opf:scheme'];
      const idAttr = attrs.id;

      const cleanValue = value.replace(/^urn:isbn:/i, '').replace(/[-\s]/g, '');

      let isISBNRefined = false;
      if (idAttr && meta.meta) {
        const typeRefine = meta.meta.find(
          (m) => m.$?.refines === `#${idAttr}` && m.$?.property === 'identifier-type',
        );
        if (typeRefine) {
          const code = textOf(typeRefine);
          if (code === '15' || code === '02' || code.toUpperCase() === 'ISBN') {
            isISBNRefined = true;
          }
        }
      }

      const isISBN10 = /^\d{9}[\dX]$/i.test(cleanValue);
      const isISBN13 = /^(978|979)\d{10}$/.test(cleanValue);

      if (scheme === 'ISBN' || isISBNRefined || isISBN10 || isISBN13) {
        identifier = value.replace(/^urn:isbn:/i, '');
        break;
      }
    }
  }

  const rawLanguage = get('dc:language');
  const langResult = normalizeLanguageCode(rawLanguage);

  return {
    title: mainTitle,
    subtitle,
    authors,
    author: authors[0]?.name ?? '',
    contributors,
    language: langResult.code,
    languageWarning: langResult.warning,
    languageConverted: langResult.converted ? rawLanguage : null,
    identifier,
    publisher: get('dc:publisher'),
    date: get('dc:date'),
    description: get('dc:description'),
    rights: get('dc:rights'),
    series: getMetaProp('belongs-to-collection') || getCalibreMeta('calibre:series'),
    seriesIndex: getMetaProp('group-position') || getCalibreMeta('calibre:series_index'),
    subjects: meta['dc:subject']?.map((s) => textOf(s)) ?? [],
  };
}
