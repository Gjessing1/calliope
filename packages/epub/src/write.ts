import path from 'node:path';
import type JSZip from 'jszip';
import { Builder } from 'xml2js';
import type { Author, MetadataUpdate } from '@calliope/core';
import { normalizeLanguageCode } from './language.js';
import { sanitizeMetadataString } from './sanitize.js';
import {
  attrsOf,
  bareIsbn,
  collectIds,
  isIsbn,
  isIsbnIdentifier,
  refinedId,
  seriesCollections,
  textOf,
} from './opf.js';
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
  // Ids in the package as it was read, and the running set of ids in use —
  // new elements must not collide with either, and a refinement whose target
  // this write removed has to go with it.
  const idsBefore = collectIds(pkg);
  const taken = new Set(idsBefore);

  /**
   * Set a simple DCMES element. undefined/null = leave as-is; '' = delete.
   * A value equal to what the file already says leaves the element alone: the
   * editor sends every field on every save, and rebuilding an unedited element
   * would strip its attributes (`opf:event`, `xml:lang`) for nothing.
   */
  const set = (key: string, value: string | undefined | null): void => {
    if (value === undefined || value === null) return;
    const sanitized = sanitizeMetadataString(String(value));
    if (!sanitized) {
      delete meta[key];
      return;
    }
    if (unchanged(meta[key] as XmlNode[] | undefined, sanitized)) return;
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
  // The replaced titles' refinements (title-type, file-as) go in the orphan
  // pass; an unchanged single title keeps its element, and so its sort title.
  if (updates.title) {
    const sanitizedTitle = sanitizeMetadataString(updates.title);
    let combinedTitle = sanitizedTitle;
    if (updates.subtitle) {
      const sanitizedSubtitle = sanitizeMetadataString(updates.subtitle);
      if (sanitizedSubtitle) combinedTitle = `${sanitizedTitle}: ${sanitizedSubtitle}`;
    }
    if (!unchanged(meta['dc:title'], combinedTitle)) meta['dc:title'] = [combinedTitle];
  }

  set('dc:publisher', updates.publisher);
  set('dc:date', updates.date);
  set('dc:description', updates.description);
  set('dc:rights', updates.rights);

  if (updates.language) {
    const langResult = normalizeLanguageCode(sanitizeMetadataString(updates.language));
    if (langResult.code && !unchanged(meta['dc:language'], langResult.code)) {
      meta['dc:language'] = [langResult.code];
    }
  }

  writeAuthors(meta, updates, isEpub2, taken);
  writeContributors(meta, updates);
  writeIdentifier(pkg, meta, updates, isEpub2, taken, warnings);
  writeSubjects(meta, updates);
  writeSeries(meta, updates, isEpub2, taken);

  if (coverBuffer) replaceCover(zip, opf, opfPath, meta, coverBuffer, isEpub2);
  pruneOrphanedRefinements(pkg, meta, idsBefore);

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

/** True when the element list is exactly one element that already says `value`. */
function unchanged(nodes: XmlNode[] | undefined, value: string): boolean {
  return nodes?.length === 1 && textOf(nodes[0]) === value;
}

/**
 * Remove every `<meta refines>` whose target this write removed — a dropped
 * contributor's role, a replaced title's title-type, an old collection's
 * position. Left behind, each is an epubcheck error ("@refines missing target
 * id"). Repeated until stable, because a removed refinement can itself carry an
 * id that another refinement points at.
 *
 * A refinement that was already dangling in the file as read is left alone,
 * like anything else this code did not write.
 */
function pruneOrphanedRefinements(
  pkg: OpfDocument['package'],
  meta: OpfMetadataNode,
  idsBefore: Set<string>,
): void {
  for (;;) {
    const present = collectIds(pkg);
    const all = meta.meta ?? [];
    const kept = all.filter((m) => {
      const target = refinedId(m);
      return !target || present.has(target) || !idsBefore.has(target);
    });
    if (kept.length === all.length) return;
    meta.meta = kept;
  }
}

/** An id not already used anywhere in the package: `creator-0`, `creator-1`, … */
function freshId(prefix: string, taken: Set<string>): string {
  let n = 0;
  while (taken.has(`${prefix}-${n}`)) n += 1;
  const id = `${prefix}-${n}`;
  taken.add(id);
  return id;
}

/**
 * Authors, with a strict EPUB 2 / EPUB 3 split:
 *   EPUB 3 — `<dc:creator id="…">` plus `<meta refines="#…">` for role and
 *            file-as; no `opf:*` attributes.
 *   EPUB 2 — `opf:role` / `opf:file-as` attributes on `<dc:creator>`; no
 *            `refines` elements at all.
 *
 * An author whose name is unchanged keeps its existing element id, so whatever
 * else refines it (an `alternate-script` spelling, a `display-seq`, a vendor
 * link) stays attached to the right person. Role and file-as come from the
 * update and replace the file's — unless the author arrived as a bare name,
 * which says nothing about either, and then the file's are kept.
 *
 * Only *creators'* refinements are touched. A contributor's role lives in the
 * same `role` property, and rewriting the author list must not demote the
 * translator.
 */
function writeAuthors(
  meta: OpfMetadataNode,
  updates: MetadataUpdate,
  isEpub2: boolean,
  taken: Set<string>,
): void {
  const nameOf = (author: Author | string): string =>
    sanitizeMetadataString(typeof author === 'string' ? author : author.name);

  const authors =
    updates.authors !== undefined && Array.isArray(updates.authors)
      ? updates.authors
      : updates.author
        ? [updates.author]
        : null;
  if (!authors) return;

  const existing = meta['dc:creator'] ?? [];
  const claimed = new Set<number>();
  const matchOf = (name: string): XmlNode | null => {
    const index = existing.findIndex((c, i) => !claimed.has(i) && textOf(c).trim() === name);
    if (index < 0) return null;
    claimed.add(index);
    return existing[index]!;
  };

  if (authors.length === 0) {
    // Their refinements go with them, in the orphan pass at the end of the write.
    delete meta['dc:creator'];
    return;
  }

  if (isEpub2) {
    meta['dc:creator'] = authors.map((author) => {
      const name = nameOf(author);
      const match = matchOf(name);
      if (typeof author === 'string' && match) return match;
      const entry: { _: string; $: Record<string, string> } = { _: name, $: {} };
      if (typeof author === 'object') {
        if (author.role) entry.$['opf:role'] = author.role;
        if (author.fileAs) entry.$['opf:file-as'] = sanitizeMetadataString(author.fileAs);
      }
      return entry;
    });
    return;
  }

  const written = authors.map((author) => {
    const name = nameOf(author);
    // xml:lang and dir survive on a matched element; the EPUB 2 attributes do
    // not, since EPUB 3 does not allow them and the refinements below carry both.
    const { 'opf:role': _role, 'opf:file-as': _fileAs, ...attrs } = attrsOf(matchOf(name));
    const id = attrs.id || freshId('creator', taken);
    return { author, name, attrs: { ...attrs, id }, matched: !!attrs.id };
  });

  // Replace the role/file-as of every creator being written — except a
  // matched bare-name author, whose refinements are the only record of them.
  const creatorIds = new Set(existing.map((c) => attrsOf(c).id).filter(Boolean));
  const keep = new Set(
    written.filter((w) => w.matched && typeof w.author === 'string').map((w) => w.attrs.id),
  );
  meta.meta = (meta.meta ?? []).filter((m) => {
    const target = refinedId(m);
    const prop = m.$?.property;
    return !(
      target &&
      (prop === 'file-as' || prop === 'role') &&
      creatorIds.has(target) &&
      !keep.has(target)
    );
  });

  meta['dc:creator'] = written.map(({ name, attrs }) => ({ _: name, $: attrs }));

  for (const {
    author,
    attrs: { id },
  } of written) {
    if (typeof author !== 'object') continue;
    if (author.fileAs) {
      meta.meta.push({
        $: { refines: `#${id}`, property: 'file-as' },
        _: sanitizeMetadataString(author.fileAs),
      });
    }
    if (author.role) {
      meta.meta.push({
        $: { refines: `#${id}`, property: 'role', scheme: 'marc:relators' },
        _: author.role,
      });
    }
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
 * The ISBN, added, updated or cleared in place while every other identifier is
 * preserved.
 *
 * The `unique-identifier` attribute is only set when the package had none: it is
 * referenced by the OPF's own id and repointing it at a new element breaks the
 * document for readers that resolve it. For the same reason an ISBN that *is*
 * the unique identifier cannot be cleared — the package would point at nothing.
 */
function writeIdentifier(
  pkg: OpfDocument['package'],
  meta: OpfMetadataNode,
  updates: MetadataUpdate,
  isEpub2: boolean,
  taken: Set<string>,
  warnings: string[],
): void {
  if (updates.identifier !== undefined) {
    const value = sanitizeMetadataString(updates.identifier).trim();
    const identifiers = [...(meta['dc:identifier'] ?? [])];
    const index = identifiers.findIndex((node) => isIsbnIdentifier(node, meta));
    const current = index >= 0 ? identifiers[index]! : null;
    const uniqueId = pkg.$?.['unique-identifier'];

    if (!value) {
      if (current && uniqueId && attrsOf(current).id === uniqueId) {
        warnings.push("The ISBN is also this book's unique identifier, so it was kept");
      } else if (current) {
        // Its identifier-type refinement goes in the orphan pass.
        identifiers.splice(index, 1);
      }
    } else if (!isIsbn(value)) {
      warnings.push(`"${value}" is not an ISBN, so the identifier was left unchanged`);
    } else if (current && bareIsbn(textOf(current)) === bareIsbn(value)) {
      // Same ISBN, perhaps hyphenated differently: leave the element as it is.
    } else if (current) {
      // Keep the element's id and attributes, and its `urn:isbn:` form if it
      // used one, so everything that points at it still does.
      const urn = /^urn:isbn:/i.test(textOf(current).trim());
      identifiers[index] = { _: urn ? `urn:isbn:${bareIsbn(value)}` : value, $: attrsOf(current) };
      const code = bareIsbn(value).length === 13 ? '15' : '02';
      const id = attrsOf(current).id;
      const type = meta.meta?.find(
        (m) =>
          m.$?.property === 'identifier-type' &&
          refinedId(m) === id &&
          m.$.scheme === 'onix:codelist5',
      );
      if (id && type) type._ = code;
    } else {
      const id = taken.has('pub-id') ? freshId('pub-id', taken) : 'pub-id';
      taken.add(id);
      identifiers.push({ _: value, $: { id } });
      if (!isEpub2) {
        meta.meta = meta.meta ?? [];
        meta.meta.push({
          $: { refines: `#${id}`, property: 'identifier-type', scheme: 'onix:codelist5' },
          _: bareIsbn(value).length === 13 ? '15' : '02',
        });
      }
      if (!uniqueId && pkg.$) pkg.$['unique-identifier'] = id;
    }

    if (identifiers.length > 0) meta['dc:identifier'] = identifiers;
    else delete meta['dc:identifier'];
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
 * undefined leaves the series alone — in EPUB 3 too, where rebuilding it
 * unconditionally once wiped the series of every book a partial update touched.
 * Setting one updates the first series collection in place, keeping its id and
 * anything else refining it; clearing removes every series collection. A `set`
 * collection is not a series and is never touched.
 *
 * An EPUB 3 file that also carries Calibre's legacy meta (common after a
 * conversion) gets it kept in step: left stale, it would make a cleared series
 * reappear on the next read and show the old name in readers that prefer it.
 *
 * EPUB 3 also gets its mandatory `dcterms:modified` stamp refreshed here, since
 * this is the only place the package is known to have changed.
 */
function writeSeries(
  meta: OpfMetadataNode,
  updates: MetadataUpdate,
  isEpub2: boolean,
  taken: Set<string>,
): void {
  meta.meta = meta.meta ?? [];

  if (updates.series !== undefined) {
    const series = sanitizeMetadataString(updates.series).trim();
    const index =
      updates.seriesIndex === undefined ? '' : sanitizeMetadataString(String(updates.seriesIndex));

    const hadCalibre = meta.meta.some((m) => m.$?.name === 'calibre:series');
    meta.meta = meta.meta.filter(
      (m) => m.$?.name !== 'calibre:series' && m.$?.name !== 'calibre:series_index',
    );
    if (series && (isEpub2 || hadCalibre)) {
      meta.meta.push({ $: { name: 'calibre:series', content: series } });
      if (index) meta.meta.push({ $: { name: 'calibre:series_index', content: index } });
    }

    if (!isEpub2) {
      const collections = seriesCollections(meta);
      if (!series) {
        // Their collection-type and group-position go in the orphan pass.
        const removed = new Set(collections);
        meta.meta = meta.meta.filter((m) => !removed.has(m));
      } else {
        let collection = collections[0];
        if (!collection) {
          collection = { $: { property: 'belongs-to-collection' } };
          meta.meta.push(collection);
        }
        collection._ = series;
        const $ = (collection.$ ??= {});
        const id = ($.id ||= freshId('collection', taken));

        const refines = (property: string) => (m: MetaElement) =>
          m.$?.property === property && refinedId(m) === id;
        if (!meta.meta.some(refines('collection-type'))) {
          meta.meta.push({ $: { property: 'collection-type', refines: `#${id}` }, _: 'series' });
        }
        meta.meta = meta.meta.filter((m) => !refines('group-position')(m));
        if (index) {
          meta.meta.push({ $: { property: 'group-position', refines: `#${id}` }, _: index });
        }
      }
    }
  }

  if (isEpub2) return;

  // dcterms:modified is required for EPUB 3 and must be a UTC timestamp with
  // no fractional seconds — `toISOString()` alone is rejected by epubcheck.
  meta.meta = meta.meta.filter((m) => m.$?.property !== 'dcterms:modified');
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  meta.meta.push({ $: { property: 'dcterms:modified' }, _: now });
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
