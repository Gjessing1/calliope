import path from 'node:path';
import type JSZip from 'jszip';
import { Builder } from 'xml2js';
import type { Author, MetadataUpdate } from '@calliope/core';
import { normalizeLanguageCode } from './language.js';
import { sanitizeMetadataString } from './sanitize.js';
import { textOf } from './opf.js';
import type { ManifestItem, MetaElement, OpfDocument, XmlNode } from './opf.js';

export interface WriteResult {
  /** The rebuilt EPUB. */
  buffer: Buffer;
  /**
   * Spec problems the write could not fix by itself — a book with no title, or
   * no identifier at all. The engine writes the file anyway (refusing would
   * strand the user with an unfixable book) and reports them.
   */
  warnings: string[];
}

/**
 * Write updated metadata back into an opened EPUB.
 *
 * Three rules govern everything below, and they are why this is longer than it
 * looks like it should be:
 *
 * 1. **The EPUB version is preserved, never upgraded.** An EPUB 2 file gets
 *    EPUB 2 metadata (`opf:role`, `opf:file-as`, `calibre:series`) and an EPUB 3
 *    file gets EPUB 3 metadata (`<meta refines>`, `belongs-to-collection`). The
 *    two vocabularies are never mixed: an EPUB 2 reader shown a `refines`
 *    element ignores the author entirely rather than falling back.
 * 2. **Unknown metadata is left exactly where it was found.** Identifiers other
 *    than the ISBN (ASIN, UUID, a publisher's internal id) are preserved
 *    untouched, as are vendor `<meta>` elements this code does not recognize.
 * 3. **`undefined` means "not edited", `''` means "clear this field".** Every
 *    setter honours that distinction, so a partial update never wipes a field
 *    the editor did not show.
 */
export async function writeEpub(
  zip: JSZip,
  opfPath: string,
  opf: OpfDocument,
  updates: MetadataUpdate,
  coverBuffer: Buffer | null = null,
): Promise<WriteResult> {
  const meta = opf.package.metadata[0];
  if (!meta) throw new Error('OPF has no <metadata> element');
  const pkg = opf.package;
  const warnings: string[] = [];

  const epubVersion = pkg.$?.version || '3.0';
  const isEpub2 = epubVersion.startsWith('2');

  /** Set a simple DCMES element. undefined/null = leave as-is; '' = delete. */
  const set = (key: string, value: string | undefined | null): void => {
    if (value === undefined || value === null) return;
    const sanitized = sanitizeMetadataString(String(value));
    if (!sanitized) {
      delete meta[key];
      return;
    }
    meta[key] = [sanitized];
  };

  meta.meta = meta.meta ?? [];

  if (!updates.title && !meta['dc:title']?.[0]) {
    warnings.push('EPUB requires a title (dc:title)');
  }

  // Title + subtitle are combined into ONE dc:title as "Title: Subtitle".
  // EPUB 3 does allow separate dc:title elements distinguished by a title-type
  // refinement, but real readers do not implement it: they show only the first
  // title, so a subtitle stored that way is invisible everywhere it matters.
  // Any existing title-type refinements are dropped, since nothing refers to
  // them once the titles are merged.
  meta.meta = meta.meta.filter((m) => m.$?.property !== 'title-type');

  if (updates.title) {
    const sanitizedTitle = sanitizeMetadataString(updates.title);
    let combinedTitle = sanitizedTitle;
    if (updates.subtitle) {
      const sanitizedSubtitle = sanitizeMetadataString(updates.subtitle);
      if (sanitizedSubtitle) combinedTitle = `${sanitizedTitle}: ${sanitizedSubtitle}`;
    }
    meta['dc:title'] = [combinedTitle];
  }

  set('dc:publisher', updates.publisher);
  set('dc:date', updates.date);
  set('dc:description', updates.description);
  set('dc:rights', updates.rights);

  if (updates.language) {
    const langResult = normalizeLanguageCode(sanitizeMetadataString(updates.language));
    if (langResult.code) meta['dc:language'] = [langResult.code];
  }

  writeAuthors(meta, updates, isEpub2);
  writeContributors(meta, updates);
  writeIdentifier(pkg, meta, updates, isEpub2, warnings);
  writeSubjects(meta, updates);
  writeSeries(meta, updates, isEpub2);

  if (coverBuffer) replaceCover(zip, opf, opfPath, meta, coverBuffer, isEpub2);

  const builder = new Builder();
  zip.file(opfPath, builder.buildObject(opf));

  // EPUB spec: the `mimetype` entry must exist and be STORED (uncompressed).
  // Re-set it explicitly so the global DEFLATE below does not compress it.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  // Without an explicit compression option JSZip stores everything, which
  // roughly doubles the output size of a typical EPUB.
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });

  return { buffer, warnings };
}

type OpfMetadataNode = OpfDocument['package']['metadata'][number];

/**
 * Authors, with a strict EPUB 2 / EPUB 3 split:
 *   EPUB 3 — `<dc:creator id="creator-N">` plus `<meta refines="#creator-N">`
 *            for role and file-as; no `opf:*` attributes.
 *   EPUB 2 — `opf:role` / `opf:file-as` attributes on `<dc:creator>`; no
 *            `refines` elements at all.
 */
function writeAuthors(meta: OpfMetadataNode, updates: MetadataUpdate, isEpub2: boolean): void {
  const nameOf = (author: Author | string): string =>
    sanitizeMetadataString(typeof author === 'string' ? author : author.name);

  if (updates.authors !== undefined && Array.isArray(updates.authors)) {
    if (!isEpub2) {
      // Drop every existing role/file-as refinement, whatever id it points at:
      // the creator ids are about to be reassigned, so any surviving refinement
      // would either be orphaned or attach to the wrong author.
      meta.meta = (meta.meta ?? []).filter((m) => {
        const prop = m.$?.property;
        const refines = m.$?.refines;
        return !((prop === 'file-as' || prop === 'role') && refines);
      });

      if (updates.authors.length === 0) {
        delete meta['dc:creator'];
        return;
      }

      meta['dc:creator'] = updates.authors.map((author, idx) => ({
        _: nameOf(author),
        $: { id: `creator-${idx}` },
      }));

      updates.authors.forEach((author, idx) => {
        if (typeof author === 'object') {
          if (author.fileAs) {
            meta.meta?.push({
              $: { refines: `#creator-${idx}`, property: 'file-as' },
              _: sanitizeMetadataString(author.fileAs),
            });
          }
          if (author.role) {
            meta.meta?.push({
              $: { refines: `#creator-${idx}`, property: 'role', scheme: 'marc:relators' },
              _: author.role,
            });
          }
        }
      });
    } else {
      if (updates.authors.length === 0) {
        delete meta['dc:creator'];
        return;
      }
      meta['dc:creator'] = updates.authors.map((author) => {
        const entry: { _: string; $: Record<string, string> } = { _: nameOf(author), $: {} };
        if (typeof author === 'object') {
          if (author.role) entry.$['opf:role'] = author.role;
          if (author.fileAs) entry.$['opf:file-as'] = sanitizeMetadataString(author.fileAs);
        }
        return entry;
      });
    }
    return;
  }

  if (updates.author) {
    const sanitizedAuthor = sanitizeMetadataString(updates.author);
    meta['dc:creator'] = isEpub2
      ? [{ _: sanitizedAuthor, $: {} }]
      : [{ _: sanitizedAuthor, $: { id: 'creator-0' } }];
  }
}

/**
 * Contributors arrive from the editor as one comma-separated field. Names that
 * are unchanged keep their existing element — and therefore their role — rather
 * than being rebuilt as bare names, which would silently demote every translator
 * and illustrator to "contributor".
 */
function writeContributors(meta: OpfMetadataNode, updates: MetadataUpdate): void {
  if (updates.contributors === undefined) return;

  const names = String(updates.contributors)
    .split(',')
    .map((s) => sanitizeMetadataString(s).trim())
    .filter(Boolean);

  if (names.length === 0) {
    delete meta['dc:contributor'];
    return;
  }

  const existing = meta['dc:contributor'] ?? [];
  meta['dc:contributor'] = names.map((name) => {
    const match = existing.find((c) => textOf(c).trim() === name);
    return match ?? ({ _: name } as XmlNode);
  });
}

/**
 * The ISBN, added or updated in place while every other identifier is preserved.
 *
 * The `unique-identifier` attribute is only set when the package had none: it is
 * referenced by the OPF's own id and repointing it at a new element breaks the
 * document for readers that resolve it.
 */
function writeIdentifier(
  pkg: OpfDocument['package'],
  meta: OpfMetadataNode,
  updates: MetadataUpdate,
  isEpub2: boolean,
  warnings: string[],
): void {
  if (updates.identifier) {
    const sanitizedId = sanitizeMetadataString(updates.identifier);
    const cleanISBN = sanitizedId.replace(/[-\s]/g, '');
    const isISBN10 = /^\d{9}[\dX]$/i.test(cleanISBN);
    const isISBN13 = /^(978|979)\d{10}$/.test(cleanISBN);

    const existingIdentifiers = meta['dc:identifier'] ?? [];
    const existingArray = Array.isArray(existingIdentifiers)
      ? existingIdentifiers
      : [existingIdentifiers];

    const uniqueIdRef = pkg.$?.['unique-identifier'];

    let foundExistingISBN = false;
    const updatedIdentifiers: XmlNode[] = existingArray.map((id) => {
      const attrs = typeof id === 'string' ? {} : (id.$ ?? {});
      const idAttr = attrs.id;
      const value = textOf(id).trim();
      const scheme = attrs['opf:scheme'];

      const cleanValue = value.replace(/^urn:isbn:/i, '').replace(/[-\s]/g, '');
      const isExistingISBN =
        scheme === 'ISBN' ||
        /^\d{9}[\dX]$/i.test(cleanValue) ||
        /^(978|979)\d{10}$/.test(cleanValue);

      if (isExistingISBN && (isISBN10 || isISBN13)) {
        foundExistingISBN = true;
        return {
          _: sanitizedId,
          $: { id: idAttr || 'pub-id', ...(scheme ? { 'opf:scheme': 'ISBN' } : {}) },
        };
      }

      // Anything else (ASIN, UUID, internal ids) survives untouched.
      return id;
    });

    if (!foundExistingISBN && (isISBN10 || isISBN13)) {
      const newIdAttr = 'pub-id';
      updatedIdentifiers.push({ _: sanitizedId, $: { id: newIdAttr } });

      if (!isEpub2) {
        meta.meta = (meta.meta ?? []).filter(
          (m) => !(m.$?.refines === `#${newIdAttr}` && m.$?.property === 'identifier-type'),
        );
        meta.meta.push({
          $: { refines: `#${newIdAttr}`, property: 'identifier-type', scheme: 'onix:codelist5' },
          _: isISBN13 ? '15' : '02',
        });
      }

      if (!uniqueIdRef && pkg.$) pkg.$['unique-identifier'] = newIdAttr;
    }

    meta['dc:identifier'] = updatedIdentifiers;
  }

  if (!meta['dc:identifier'] || meta['dc:identifier'].length === 0) {
    warnings.push('EPUB requires at least one identifier (dc:identifier)');
  }
}

function writeSubjects(meta: OpfMetadataNode, updates: MetadataUpdate): void {
  if (!Array.isArray(updates.subjects)) return;
  if (updates.subjects.length > 0) {
    meta['dc:subject'] = updates.subjects.map((s) => ({ _: sanitizeMetadataString(s) }));
  } else {
    // An empty array is the user clearing every subject, not an absent field.
    delete meta['dc:subject'];
  }
}

/**
 * Series. EPUB 3 has a real vocabulary for it (`belongs-to-collection` plus a
 * `collection-type` and `group-position` refinement); EPUB 2 has none, so the
 * de-facto Calibre `<meta name="calibre:series">` is used there instead.
 *
 * EPUB 3 also gets its mandatory `dcterms:modified` stamp refreshed here, since
 * this is the only place the package is known to have changed.
 */
function writeSeries(meta: OpfMetadataNode, updates: MetadataUpdate, isEpub2: boolean): void {
  meta.meta = meta.meta ?? [];

  if (!isEpub2) {
    meta.meta = meta.meta.filter(
      (m) =>
        m.$?.property !== 'belongs-to-collection' &&
        m.$?.property !== 'group-position' &&
        m.$?.property !== 'collection-type' &&
        !m.$?.refines?.startsWith('#collection'),
    );

    if (updates.series) {
      const sanitizedSeries = sanitizeMetadataString(updates.series);
      meta.meta.push({
        $: { property: 'belongs-to-collection', id: 'collection' },
        _: sanitizedSeries,
      });
      meta.meta.push({ $: { property: 'collection-type', refines: '#collection' }, _: 'series' });
      if (updates.seriesIndex) {
        meta.meta.push({
          $: { property: 'group-position', refines: '#collection' },
          _: String(updates.seriesIndex),
        });
      }
    }

    // dcterms:modified is required for EPUB 3 and must be a UTC timestamp with
    // no fractional seconds — `toISOString()` alone is rejected by epubcheck.
    meta.meta = meta.meta.filter((m) => m.$?.property !== 'dcterms:modified');
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    meta.meta.push({ $: { property: 'dcterms:modified' }, _: now });
    return;
  }

  // EPUB 2: undefined leaves the series untouched, '' clears it.
  if (updates.series !== undefined) {
    meta.meta = meta.meta.filter(
      (m) => m.$?.name !== 'calibre:series' && m.$?.name !== 'calibre:series_index',
    );

    const sanitizedSeries = sanitizeMetadataString(updates.series);
    if (sanitizedSeries) {
      meta.meta.push({ $: { name: 'calibre:series', content: sanitizedSeries } });
      if (updates.seriesIndex) {
        meta.meta.push({
          $: { name: 'calibre:series_index', content: String(updates.seriesIndex) },
        });
      }
    }
  }
}

/**
 * Replace the cover image, or add one when the book has none.
 *
 * Every structural access is guarded: a manifest that is missing, empty, or full
 * of attribute-less items is common enough in this corpus that an unguarded
 * `manifest[0].item` is a crash waiting for a particular book. A failure here is
 * swallowed — losing the new cover is better than losing the metadata edit that
 * came with it.
 */
function replaceCover(
  zip: JSZip,
  opf: OpfDocument,
  opfPath: string,
  meta: OpfMetadataNode,
  coverBuffer: Buffer,
  isEpub2: boolean,
): void {
  try {
    opf.package.manifest = opf.package.manifest ?? [{ item: [] }];
    opf.package.manifest[0] = opf.package.manifest[0] ?? { item: [] };
    opf.package.manifest[0].item = opf.package.manifest[0].item ?? [];
    const manifest = opf.package.manifest[0].item;

    let coverItem: ManifestItem | null = null;

    if (!isEpub2) {
      coverItem = manifest.find((item) => item?.$?.properties?.includes('cover-image')) ?? null;
    }

    if (!coverItem) {
      const coverMeta = meta.meta?.find((m: MetaElement) => m?.$?.name === 'cover');
      if (coverMeta?.$?.content) {
        const coverId = coverMeta.$.content;
        coverItem = manifest.find((item) => item?.$?.id === coverId) ?? null;
      }
    }

    if (!coverItem) {
      coverItem =
        manifest.find(
          (item) =>
            item?.$?.id?.toLowerCase().includes('cover') &&
            item.$['media-type']?.startsWith('image/'),
        ) ?? null;
    }

    if (coverItem?.$?.href) {
      const fullCoverPath = path.join(path.dirname(opfPath), coverItem.$.href).replace(/\\/g, '/');

      // JPEG magic bytes: if optimizeCover re-encoded a PNG, the manifest's
      // declared media type is now a lie and readers that trust it show nothing.
      const isJpeg = coverBuffer[0] === 0xff && coverBuffer[1] === 0xd8;
      if (isJpeg) coverItem.$['media-type'] = 'image/jpeg';

      zip.file(fullCoverPath, coverBuffer);
      return;
    }

    const newCoverId = 'cover-image';
    const newCoverPath = 'images/cover.jpg';
    zip.file(path.join(path.dirname(opfPath), newCoverPath).replace(/\\/g, '/'), coverBuffer);

    const newManifestItem: ManifestItem = {
      $: { id: newCoverId, href: newCoverPath, 'media-type': 'image/jpeg' },
    };
    // properties="cover-image" is EPUB 3 only; on an EPUB 2 it is an unknown
    // attribute that some validators reject.
    if (!isEpub2 && newManifestItem.$) newManifestItem.$.properties = 'cover-image';
    manifest.push(newManifestItem);

    // The EPUB 2 `<meta name="cover">` pointer is added for both versions —
    // EPUB 3 readers ignore it, EPUB 2 readers need it, and several EPUB 3
    // readers in the wild still look for it first.
    meta.meta = meta.meta ?? [];
    meta.meta.push({ $: { name: 'cover', content: newCoverId } });
  } catch {
    // Cover replacement is best-effort; the metadata write must still land.
  }
}
